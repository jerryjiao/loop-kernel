// 账本拍板 ↔ 拍板单同步：账本 question 行没单的开拍板单推「等你」（shift=manual）；生效
// decision 行 → done，source=default → close「按推荐默认」（48 小时已按默认执行的补登记
// 收尾）；窗内（7 天）补登记，窗外不补。幂等：连跑两次第二次零事件。只经 orders.mjs 的
// openOrder/transitionOrder 写单（自带目录锁与防重复），绝不写账本。
// 注册表须含内置拍板单型（order-types.mjs 的 DECISION_TYPE），循环把它放进 loop.config.mjs
// 的 orderTypes 才启用本模块。

import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { addDaysStr, localDate } from "./dates.mjs";
import { effectiveDecisions, loadLedger, pendingQuestions } from "./ledger.mjs";
import { makeCtx, openOrder, scanOrders, transitionOrder, Reject } from "./orders.mjs";
import { loadConfig } from "./config.mjs";

/** 拍板单在单册里的索引：防重复键 → 折叠态（任意阶段）。 */
export function scanTodoOrders(daysDir) {
  const byKey = new Map();
  for (const s of scanOrders(daysDir)) {
    if (s.type === "decision") byKey.set(s.key, s);
  }
  return { byKey };
}

/** 同步。rows = 账本行，ctx 由 makeCtx 组（registry 须含 DECISION_TYPE），
 *  neverDefaultCategories 见 ledger.pendingQuestions。返回 ops = 每笔 { order, event }，
 *  skipped = 个别 open/transition 撞锁或撞防重复闸（并发窗口）跳过的笔数——下一轮同步自愈。 */
export function syncDecisions({ rows = [], now = new Date(), ctx, neverDefaultCategories = [] } = {}) {
  if (!ctx?.daysDir) throw new Error("syncDecisions 必须传 ctx（makeCtx 组好，不允许静默写真实 days）");
  const dateStr = localDate(now);
  const windowStart = addDaysStr(dateStr, -6); // 只补登记窗内的源（与 recentRows 默认 7 天窗一致）
  const inWindow = (date) => date >= windowStart && date <= dateStr;

  const ops = [];
  let skipped = 0;
  const open = (type, key, title, data) => {
    try {
      // 拍板单是人工关卡单型（shifts=["manual"]）：不归任何班，班次记 manual；
      // 同步每班开班跑，开单方是循环机制本身，by 记 "shift"
      const r = openOrder(ctx, { type, key, title, data, shift: "manual", by: "shift" });
      ops.push({ order: r.order, event: "open" });
      return r.order;
    } catch (error) {
      if (error instanceof Reject) {
        skipped += 1;
        return null;
      }
      throw error;
    }
  };
  const tr = (orderId, event, extra) => {
    try {
      transitionOrder(ctx, orderId, event, extra);
      ops.push({ order: orderId, event });
      return true;
    } catch (error) {
      if (error instanceof Reject) {
        skipped += 1;
        return false;
      }
      throw error;
    }
  };

  const decided = effectiveDecisions(rows); // 题号 → 生效 decision 行
  const questionTexts = new Map(
    rows.filter((r) => r.type === "question" && r.id && typeof r.text === "string").map((r) => [r.id, r.text]),
  );
  const { byKey } = scanTodoOrders(ctx.daysDir);

  // —— 源 = 未拍题（开单→等你）与生效 decision 行（已办→done / 默认→close）——
  for (const q of pendingQuestions(rows, { neverDefaultCategories })) {
    const key = `decision:${q.id}`;
    const s = byKey.get(key);
    if (!s) {
      const order = open("decision", key, q.text, { question: q.id });
      if (order) tr(order, "needs_you");
      continue;
    }
    if (s.phase === "todo") tr(s.order, "needs_you"); // 开了还没推进的半程状态补齐
  }
  for (const [qid, drow] of decided) {
    const key = `decision:${qid}`;
    const s = byKey.get(key);
    if (!s) {
      // 拍板发生在同步建单之前：窗内补登记收尾
      if (!inWindow(drow.date)) continue;
      const order = open("decision", key, questionTexts.get(qid) ?? qid, { question: qid });
      if (!order) continue;
      if (drow.source === "default") tr(order, "close", { reason: "按推荐默认" });
      else tr(order, "done", { verified: true });
      continue;
    }
    let phase = s.phase;
    if (phase === "todo") {
      if (!tr(s.order, "needs_you")) continue; // 半程状态补齐后接着收尾
      phase = "waiting";
    }
    if (phase === "waiting" || phase === "queued" || phase === "doing") {
      if (drow.source === "default") tr(s.order, "close", { reason: "按推荐默认" });
      else tr(s.order, "done", { verified: true });
    }
  }

  return { ops, skipped };
}

// —— CLI（每班开班用）：node src/decision-sync.mjs [--dry-run] ——
// 读 <cwd>/loop.config.mjs 与账本，同步拍板单，打印 JSON。--dry-run：真实 days 一个字节
// 不动——把 days 目录拷进临时目录在副本上跑，打印将发生的 ops，退出前删临时目录。

export async function main(argv = [], deps = {}) {
  if (argv.some((a) => a !== "--dry-run")) {
    process.stderr.write("用法: node src/decision-sync.mjs [--dry-run]\n");
    return 1;
  }
  const dryRun = argv.includes("--dry-run");
  let scratch = null;
  try {
    const config = await loadConfig(deps.root ?? process.cwd());
    let ctx = makeCtx(config, deps);
    if (dryRun) {
      scratch = mkdtempSync(join(tmpdir(), "decision-sync-dry-"));
      const copy = join(scratch, "days");
      if (existsSync(ctx.daysDir)) cpSync(ctx.daysDir, copy, { recursive: true });
      ctx = { ...ctx, daysDir: copy };
    }
    const result = syncDecisions({
      rows: loadLedger(ctx.ledgerFile),
      now: ctx.now(),
      ctx,
      neverDefaultCategories: config.neverDefaultCategories ?? [],
    });
    process.stdout.write(`${JSON.stringify({ ok: true, ...(dryRun ? { dryRun: true } : {}), ...result })}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`decision-sync 失败: ${error?.message ?? error}\n`);
    return 1;
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2), { root: process.env.LOOP_CWD ?? process.cwd() });
}
