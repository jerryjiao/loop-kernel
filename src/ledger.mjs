// 循环账本（JSONL，一本账装交付物/拍板结果/先行指标）。内核只管追加与读侧的通用形状：
// date/type 必填、question 行的 options/recommend 约定；具体行类型的业务校验由循环经
// validators 注入（loop.config.mjs 的 ledgerRows）。文件路径一律由调用方传。
//   {"date","type":"delivery","trial","url","title","verified":true|false,"note"}
//   {"date","type":"question","id","trial","category","recommend","options":["<选项1>","<选项2>"],"text","ts"}
//     —— options 是候选选项数组（不带 options 的旧格式照常允许）；recommend 若给必须是 options 之一，
//        不给 recommend 合法（= 永不默认）；ts 是入账时间（ISO 字符串），add 时行内没有会自动补，
//        48 小时默认从它起算
//   {"date","type":"decision","trial","question","choice","source":"reply|default|workbench","supersedes"?}
//     —— 改判：对同一题号再记一行 decision 即生效（账本靠后者为准）；supersedes 记被替换行，只作记录
// 用法（CLI，root = LOOP_CWD ?? cwd，账本 <root>/loop/ledger.jsonl，规则来自 loop.config.mjs）：
//   node src/ledger.mjs add '{"date":"2026-10-15","type":"delivery",...}'
//   node src/ledger.mjs recent --days 7 [--type delivery]
//   node src/ledger.mjs pending   （待拍题 JSON：pendingQuestions 输出，只读）

import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { loadConfig } from "./config.mjs";
import { addDaysStr, localDate } from "./dates.mjs";
import { withDirLock } from "./dir-lock.mjs";

/** 读账本全部行：逐行 JSON.parse，坏行跳过（手工编辑损坏不拖垮调用方）。 */
export function loadLedger(file) {
  let text;
  try {
    text = readFileSync(file, "utf-8");
  } catch {
    return [];
  }
  const rows = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed));
    } catch {} // 坏行跳过
  }
  return rows;
}

/** 追加一行（校验 date 必填且为 YYYY-MM-DD、type 必填；行内没有 ts 时自动补 now 的 ISO 时间，已有不覆盖）。
 *  question 行带 options 时：options 必须是非空字符串数组；recommend 若给必须是其中一项，
 *  不给 recommend 合法（= 永不默认）。其余行类型的校验由 validators[row.type]（循环注入）补：
 *  返回非空字符串即拒绝。 */
export function addLedgerRow(file, row, { now = new Date(), validators = {} } = {}) {
  if (row === null || typeof row !== "object" || Array.isArray(row)) {
    throw new Error("行必须是 JSON 对象");
  }
  if (typeof row.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(row.date)) {
    throw new Error("date 必填且为 YYYY-MM-DD");
  }
  if (typeof row.type !== "string" || !row.type) throw new Error("type 必填");
  if (row.type === "question" && row.options !== undefined) {
    const badOptions =
      !Array.isArray(row.options) ||
      row.options.length === 0 ||
      row.options.some((option) => typeof option !== "string" || !option);
    if (badOptions) throw new Error("question 行 options 必须是非空字符串数组");
    if (row.recommend !== undefined && !row.options.includes(row.recommend)) {
      throw new Error("question 行 recommend 必须是 options 之一");
    }
  }
  const problem = validators[row.type]?.(row);
  if (typeof problem === "string" && problem) throw new Error(problem);
  if (!row.ts) row.ts = now.toISOString();
  // 账本有多个写入者（工作台常驻、夜里班次），追加放进账本旁的目录锁里（dir-lock.mjs，
  // 与单记录同一套抢锁/死锁抢占口径），防并发交叉写坏行。
  return withDirLock(`${file}.lock`, () => {
    appendFileSync(file, `${JSON.stringify(row)}\n`);
    return row;
  });
}

/** 题目入账时间：行内带 ts 用 ts；没有（旧行）按 date 当地时间 05:00（每日一圈开跑时刻）。 */
export function questionTime(row) {
  const ts = row.ts ? new Date(row.ts) : null;
  if (ts && !Number.isNaN(ts.getTime())) return ts;
  const [year, month, day] = row.date.split("-").map(Number);
  return new Date(year, month - 1, day, 5, 0, 0);
}

/** 生效拍板：题号 → decision 行。同一题号多行时取账本靠后的一行；
 *  改判行带的 supersedes 只作记录，不参与判断。 */
export function effectiveDecisions(rows) {
  const effective = new Map();
  for (const row of rows) {
    if (row.type !== "decision" || typeof row.question !== "string" || !row.question) continue;
    effective.set(row.question, row);
  }
  return effective;
}

/** 待拍题：题号还没有生效 decision 的 question 行。每项为原行加：
 *  deadline（入账时间 + 48 小时，ISO 字符串）、irreversible（category 在 neverDefaultCategories
 *  名单里 → true，永不默认执行）、neverDefault（irreversible 或没有 recommend → true；
 *  这类题永不按推荐自动执行）。 */
export function pendingQuestions(rows, { neverDefaultCategories = [] } = {}) {
  const decided = effectiveDecisions(rows);
  const pending = [];
  for (const row of rows) {
    if (row.type !== "question" || !row.id || decided.has(row.id)) continue;
    const irreversible = neverDefaultCategories.includes(row.category);
    pending.push({
      ...row,
      deadline: new Date(questionTime(row).getTime() + 48 * 60 * 60 * 1000).toISOString(),
      irreversible,
      neverDefault: irreversible || row.recommend === undefined,
    });
  }
  return pending;
}

/** 最近 N 天（含今天）的行，可选按 type 过滤，按 date 升序。未来日期的行视为异常不计。 */
export function recentRows(file, { days = 7, type = null, now = new Date() } = {}) {
  const today = localDate(now);
  const cutoff = addDaysStr(today, -(Math.max(days, 1) - 1));
  return loadLedger(file)
    .filter((row) => row.date >= cutoff && row.date <= today)
    .filter((row) => type === null || row.type === type)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** 连续空转天数：从 dateStr 往前数没有 delivery 行的天数。下界 = 账本里最早的循环行
 *  （默认 delivery/decision，循环可在 loopRowTypes 里换成自家的行类型清单）日期；
 *  循环还没记过账（无任何循环行）记 0，不用旧历史背锅。 */
export function emptyStreak(rows, dateStr, { loopRowTypes = ["delivery", "decision"] } = {}) {
  const deliveryDates = new Set(rows.filter((r) => r.type === "delivery").map((r) => r.date));
  if (deliveryDates.has(dateStr)) return 0;
  const loopDates = rows
    .filter((r) => loopRowTypes.includes(r.type))
    .map((r) => r.date)
    .sort();
  const floor = loopDates[0] ?? null;
  if (floor === null || floor > dateStr) return 0;
  let streak = 0;
  let cur = dateStr;
  while (cur >= floor && !deliveryDates.has(cur)) {
    streak += 1;
    cur = addDaysStr(cur, -1);
  }
  return streak;
}

/** CLI 入口。ledgerFile 必传（测试与循环脚本注入）。config 带 ledgerRows 与 neverDefaultCategories。 */
export async function main(argv, { ledgerFile, config } = {}) {
  const [cmd, ...rest] = argv;
  if (!ledgerFile) {
    process.stderr.write("ledger 需要账本路径：main(argv, { ledgerFile })\n");
    process.exitCode = 1;
    return;
  }
  if (cmd === "add") {
    try {
      addLedgerRow(ledgerFile, JSON.parse(rest[0] ?? ""), { validators: config?.ledgerRows ?? {} });
    } catch (error) {
      process.stderr.write(`ledger add 失败: ${error?.message ?? error}\n`);
      process.exitCode = 1;
    }
    return;
  }
  if (cmd === "recent") {
    let days = 7;
    let type = null;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--days") days = Number(rest[++i]);
      else if (rest[i] === "--type") type = rest[++i];
    }
    process.stdout.write(`${JSON.stringify(recentRows(ledgerFile, { days, type }), null, 2)}\n`);
    return;
  }
  if (cmd === "pending") {
    const neverDefaultCategories = config?.neverDefaultCategories ?? [];
    process.stdout.write(`${JSON.stringify(pendingQuestions(loadLedger(ledgerFile), { neverDefaultCategories }), null, 2)}\n`);
    return;
  }
  process.stderr.write("用法: ledger add <json> | recent --days N [--type T] | pending\n");
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = process.env.LOOP_CWD ?? process.cwd();
  const config = await loadConfig(root);
  await main(process.argv.slice(2), { ledgerFile: join(root, "loop", "ledger.jsonl"), config });
}
