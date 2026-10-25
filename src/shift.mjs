// 班入口：一个定时任务一个 launchd 闹钟，每小时整点叫醒 `node src/shift.mjs --task <id>`。
// 钟点是「最早几点能开」（登记表 loop/scheduled-tasks.json，按配置时区），错过的班顺延到
// 下一个整点补上，前一班没跑完占住后一班。停用标记 <loopHome>/disabled/<id> 在则记一行
// noop 退出，不写 shifts.jsonl、不起会话。手动开班 --shift <编号> 不查停用、不查跑过没。
// 单实例锁保证同一时刻只有一班；上一班没跑完新的一班直接跳过（记 skipped）。
// 业务差异全在 <root>/loop.config.mjs：提示词（prompt）、执行器（executor）、班前后钩子
// （beforeShift 里可做 git pull --ff-only——gitPullFf/gitHeadShort 已导出成工具函数）。
// skipped 行沿用老 shift.mjs 的形状（key:null 占位）；正常班的通道字段（key/channel 之类）
// 由循环的 executor 经 result.row 合并进班记录。
// 用法：
//   node src/shift.mjs --task <id> [--dry-run] [--cwd <root>]
//   node src/shift.mjs --shift <编号> [--dry-run] [--cwd <root>]

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, linkSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { addDaysStr, localDate } from "./dates.mjs";
import { loadConfig } from "./config.mjs";
import { makeCtx, nextOrder } from "./orders.mjs";
import { dueShift, isDisabled, loadTasks } from "./scheduled-tasks.mjs";

const LOCK_STALE_MS = 3 * 60 * 60 * 1000; // 锁超过 3 小时视为上一起死锁，可抢占

// —— 纯函数 ——

/** 登记表里全部班编号（跨任务合并，一张表不许重复）。 */
function knownShifts(tasks) {
  return new Set(tasks.flatMap((t) => t.schedule.slots.map((s) => s.shift)));
}

/** 「跑过」判定：该圈日该班在 shifts.jsonl 有一条非 skipped 的行。行只在班结束时写，
 *  exit 非零/超时也算跑过——失败班不靠每小时重试，交给巡检单报修。
 *  skipped-empty 例外（#180）：算跑过。dueShift 取「到点且没跑过」的最早班，空池跳过若不算
 *  跑过，之后每个整点都会再查同一个池、再写一行 skipped，后面的班永远轮不到；空池不是
 *  靠整点重试能变好的状态（规划班明早才开单）。quota/lock 类 skipped 照旧不算——额度可能
 *  下一小时就恢复，保留整点重试。 */
export function shiftRan(root, day, shift, { readImpl = readFileSync } = {}) {
  let text;
  try {
    text = readImpl(join(root, "loop", "days", day, "shifts.jsonl"), "utf8");
  } catch {
    return false;
  }
  return text.split("\n").some((line) => {
    if (!line.includes(`"shift":"${shift}"`)) return false;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      return false;
    }
    return row.shift === shift && (row.skipped === undefined || row.skipped === "skipped-empty");
  });
}

/** 收齐全部圈日目录下某 jsonl 的行（跨天事件按 ts 过滤，单文件损坏的行跳过）。 */
function collectDayFile(daysDir, name) {
  const rows = [];
  let dirs = [];
  try {
    dirs = readdirSync(daysDir).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  } catch {
    return rows;
  }
  for (const dir of dirs) {
    let text;
    try {
      text = readFileSync(join(daysDir, dir, name), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        rows.push(JSON.parse(line));
      } catch {}
    }
  }
  return rows;
}

/** 班小结（纯函数）：本班时间窗 start..end 内 orders.jsonl 事件按单号去重统计、
 *  rejects.jsonl 按 type+reason 去重计 count、收工原因（超时/出错/池空/干完）。
 *  nextFn 只在 exit 0 时被问「还有没有单」。 */
export function shiftSummary(row, { orderEvents = [], rejectRows = [], nextFn = null } = {}) {
  const startMs = Date.parse(row.start);
  const endMs = Date.parse(row.end);
  const inWindow = (ts) => {
    const t = Date.parse(ts);
    return t >= startMs && t <= endMs;
  };
  const distinctOrders = (event) =>
    new Set(orderEvents.filter((e) => e.event === event && inWindow(e.ts) && e.order).map((e) => e.order)).size;
  const orders = {
    done: distinctOrders("done"),
    failed: distinctOrders("fail"),
    waiting: distinctOrders("needs_you"),
    opened: distinctOrders("open"),
  };
  const seen = new Map();
  for (const r of rejectRows) {
    if (!inWindow(r.ts)) continue;
    const k = `${r.type}\n${r.reason}`;
    const hit = seen.get(k);
    if (hit) hit.count += 1;
    else seen.set(k, { type: r.type, reason: r.reason, count: 1 });
  }
  let endReason = "done";
  if (row.timedOut) endReason = "timeout";
  else if (row.exit !== 0) endReason = "error";
  else if (nextFn) {
    const next = nextFn({ shift: row.shift });
    if (!next?.order && !next?.type) endReason = "pool-empty";
  }
  return { orders, rejects: [...seen.values()], endReason };
}

// —— 锁（<loopHome>/shift.lock，JSON {pid, started}）——

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readLock(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function lockHeld(lock, now) {
  return Boolean(lock) && Number.isInteger(lock.pid) && pidAlive(lock.pid) && now - Date.parse(lock.started) < LOCK_STALE_MS;
}

// tmp+link 原子独占（LESSONS 19）：两个进程同时抢，只有一个 link 得手。
function tryLock(file, entry) {
  mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(entry) + "\n", { mode: 0o600 });
  try {
    linkSync(tmp, file);
    return true;
  } catch {
    return false;
  } finally {
    try {
      unlinkSync(tmp);
    } catch {}
  }
}

function releaseLock(file, entry) {
  const cur = readLock(file);
  if (cur && cur.pid === entry.pid && cur.started === entry.started) {
    try {
      unlinkSync(file);
    } catch {}
  }
}

// —— shifts.jsonl / 日志 ——

// 追加后读回来核验最后一行真是本行（LESSONS 19：单次 write 返回不可当落盘证据），不行补一次。
export function appendShiftRow(daysFile, row) {
  mkdirSync(join(daysFile, ".."), { recursive: true });
  appendFileSync(daysFile, `${JSON.stringify(row)}\n`);
  let last = null;
  try {
    const lines = readFileSync(daysFile, "utf8").split("\n").filter(Boolean);
    last = JSON.parse(lines.at(-1));
  } catch {}
  if (last?.start !== row.start || last?.shift !== row.shift) appendFileSync(daysFile, `${JSON.stringify(row)}\n`);
}

/** 最近一条 shifts 记录：从今天（配置时区）往前找 7 天的 shifts.jsonl，返回最后一条解析成功的行。 */
export function lastShiftRow(root, { now = new Date(), readImpl = readFileSync } = {}) {
  let day = localDate(now);
  for (let i = 0; i < 7; i++) {
    const file = join(root, "loop", "days", day, "shifts.jsonl");
    if (existsSync(file)) {
      const lines = readImpl(file, "utf8").split("\n").filter(Boolean);
      for (let j = lines.length - 1; j >= 0; j--) {
        try {
          return JSON.parse(lines[j]);
        } catch {}
      }
    }
    day = addDaysStr(day, -1);
  }
  return null;
}

// —— 工具函数（钩子里可用）——

/** git pull --ff-only（参数数组、无 shell）；返回 {ok, detail}，绝不抛错。 */
export function gitPullFf(cwd, spawn = spawnSync) {
  try {
    const r = spawn("git", ["pull", "--ff-only"], { cwd, encoding: "utf-8", timeout: 60_000 });
    const detail = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim().split("\n").at(-1) ?? "";
    return { ok: r.status === 0, detail };
  } catch (error) {
    return { ok: false, detail: String(error?.message ?? error) };
  }
}

/** 取当前 git HEAD 短哈希（参数数组、无 shell）；取不到 → null，绝不抛错。 */
export function gitHeadShort(cwd, spawn = spawnSync) {
  try {
    const r = spawn("git", ["rev-parse", "--short", "HEAD"], { cwd, encoding: "utf-8", timeout: 10_000 });
    return r.status === 0 ? (r.stdout ?? "").trim() : null;
  } catch {
    return null;
  }
}

// —— 主流程 ——

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--shift" || a === "--task" || a === "--cwd") out[a.slice(2)] = argv[++i];
    else out._.push(a);
  }
  return out;
}

/** 跑一班。返回进程退出码。deps：{ root, tasks, now, sessionIdFn, gitHeadFn } 全可注入，
 *  测试临时目录里现造 loop.config.mjs 与登记表、executor 记录调用，不起真会话。 */
export async function runShift(argv = [], deps = {}) {
  const opts = parseArgs(argv);
  const config = await loadConfig(opts.cwd ?? deps.root ?? process.env.LOOP_CWD ?? process.cwd());
  const tasks = deps.tasks ?? loadTasks(config.root);
  const shifts = knownShifts(tasks);
  const missing = [...shifts].filter((s) => config.shifts[s] === undefined);
  if (missing.length > 0) {
    process.stderr.write(`shift: 登记表里的班 ${missing.join(", ")} 不在 loop.config.mjs 的 shifts 里\n`);
    return 2;
  }
  if (!existsSync(config.root) || !statSync(config.root).isDirectory()) {
    process.stderr.write(`shift: 循环根目录不存在：${config.root}\n`);
    return 2;
  }
  const loopHome = config.loopHome;
  const lockFile = join(loopHome, "shift.lock");
  const logTo = (name, ...lines) => appendFileSync(join(loopHome, "logs", name), `${lines.join("\n")}\n`);
  mkdirSync(join(loopHome, "logs"), { recursive: true, mode: 0o700 });

  const now = deps.now ?? new Date();
  const day = localDate(now);
  const startIso = now.toISOString();

  // --task：每小时闹钟的入口。停用、或此刻没有到点且没跑过的班 → 记一行 noop 退出，
  // 不写 shifts.jsonl（每小时刷行只会把账本当噪声；「没跑」本身就是无行的证据）。
  // --shift：手动开班，不查停用、不查跑过没。
  let shift;
  if (opts.task !== undefined) {
    const task = tasks.find((t) => t.id === opts.task);
    if (!task) {
      process.stderr.write(`shift: 未知任务 ${opts.task}（登记表里有：${tasks.map((t) => t.id).join(", ")}）\n`);
      return 2;
    }
    if (isDisabled(loopHome, task.id)) {
      logTo(`${day}-${task.id}.log`, `noop ${startIso}: 任务 ${task.id} 已停用`);
      return 0;
    }
    shift = dueShift(task, now, (d, s) => shiftRan(config.root, d, s));
    if (shift === null) {
      logTo(`${day}-${task.id}.log`, `noop ${startIso}: ${task.id} 此刻没有该跑的班`);
      return 0;
    }
  } else if (opts.shift !== undefined) {
    if (!shifts.has(opts.shift)) {
      process.stderr.write(`shift: 未知班 ${opts.shift}（登记表里有：${[...shifts].join(", ")}）\n`);
      return 2;
    }
    shift = opts.shift;
  } else {
    process.stderr.write(`shift: 需要 --task <${tasks.map((t) => t.id).join("|")}> 或 --shift <${[...shifts].join("|")}>\n`);
    return 2;
  }

  const daysDir = join(config.root, "loop", "days");
  const daysFile = join(daysDir, day, "shifts.jsonl");
  // 班小结随班记录自动写：算失败只记 summary:null，不挡班（skipped 行不写小结）
  const withSummary = (row) => {
    try {
      return {
        ...row,
        summary: shiftSummary(row, {
          orderEvents: collectDayFile(daysDir, "orders.jsonl"),
          rejectRows: collectDayFile(daysDir, "rejects.jsonl"),
          nextFn: (q) => nextOrder(makeCtx(config, { now: () => new Date(row.end) }), q),
        }),
      };
    } catch {
      return { ...row, summary: null };
    }
  };
  const log = (...lines) => logTo(`${day}-${shift}.log`, ...lines);
  const head = (deps.gitHeadFn ?? gitHeadShort)(config.root);
  const skip = (why) => {
    appendShiftRow(daysFile, { shift, start: startIso, end: new Date().toISOString(), key: null, exit: null, timedOut: false, searches: null, skipped: why, head });
    log(`skipped: ${why}`);
    return 0;
  };

  // 单实例锁：上一班还在跑（或没死透）→ 记 skipped 退出
  const myLock = { pid: process.pid, started: startIso };
  const cur = readLock(lockFile);
  if (lockHeld(cur, now.getTime())) return skip("lock");
  if (cur) {
    try {
      unlinkSync(lockFile); // 失效锁（进程已死或超 3 小时）抢占
    } catch {}
  }
  if (!tryLock(lockFile, myLock)) return skip("lock");

  try {
    // 拿到锁先跑循环的钩子（老版内置的 git pull --ff-only 挪到这里：要用就写进 beforeShift）
    await config.beforeShift?.({ root: config.root, shift, log });

    // 「有单才起」（#180）：alwaysRun:false 的班起会话前先查单池（与班小结 pool-empty 同一
    // 口径，selfStart 建议算有活）。空池 → 真写一行 skipped-empty 收工（不算失败；shiftRan 把
    // 它当跑过，dueShift 下个整点才轮到下一班，不会每小时重查同一个空池）。查池本身出错 →
    // 宁可多跑不漏跑，记一句原因照起会话。
    if (config.shifts[shift].alwaysRun === false) {
      try {
        const probe = nextOrder(makeCtx(config, deps.now ? { now: () => deps.now } : {}), { shift });
        if (!probe?.order && !probe?.type) {
          appendShiftRow(daysFile, {
            shift, start: startIso, end: new Date().toISOString(), key: null, exit: 0, timedOut: false, searches: null,
            skipped: "skipped-empty", head,
            summary: { orders: { done: 0, failed: 0, waiting: 0, opened: 0 }, rejects: [], endReason: "skipped-empty" },
          });
          log("skipped-empty: 单池空，不起会话");
          return 0;
        }
      } catch (error) {
        log(`查单池出错（${error?.message ?? error}），照起会话`);
      }
    }

    // 会话号先定：executor 失败/超时不回 JSON 时也能记下。orders CLI 靠 LOOP_SESSION_ID 把
    // sessionId 写进单事件；LOOP_SHIFT 钉班次身份（多个班钟点挨着开时按钟点推算会算错班）；
    // LOOP_GUARD_ROOT 把守卫的 rm/find 边界换成本循环的根。
    const sessionId = deps.sessionIdFn?.() ?? randomUUID();
    process.env.LOOP_SESSION_ID = sessionId;
    process.env.LOOP_SHIFT = shift;
    process.env.LOOP_GUARD_ROOT = config.root;
    const prompt = config.prompt(shift, { dryRun: Boolean(opts.dryRun) });
    const timeoutMs = config.shifts[shift].timeLimitMin * 60_000;
    log(`start shift=${shift} day=${day} session=${sessionId} cwd=${config.root}${opts.dryRun ? " dry-run" : ""}`, `prompt: ${prompt}`);
    const r = await config.executor.run({ cwd: config.root, prompt, sessionId, timeoutMs, shift });
    if (r.skip) return skip(r.skip);
    const end = new Date();
    appendShiftRow(daysFile, withSummary({
      shift, start: startIso, end: end.toISOString(),
      sessionId: (typeof r.json?.session_id === "string" && r.json.session_id) || sessionId,
      exit: r.code, timedOut: r.timedOut, head, ...(r.row ?? {}),
    }));
    log(`end exit=${r.code} timedOut=${r.timedOut} searches=${r.row?.searches ?? "null"} durationMs=${end - now}`, String(r.json?.result ?? "") || "(无回答)", r.stderr ? `stderr: ${r.stderr.slice(-2000)}` : "");
    await config.afterShift?.({ root: config.root, shift, log, result: r });
    return r.timedOut || r.code !== 0 || r.json?.is_error === true ? 1 : 0;
  } finally {
    delete process.env.LOOP_SESSION_ID;
    delete process.env.LOOP_SHIFT;
    releaseLock(lockFile, myLock);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await runShift(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`shift: ${error?.message ?? error}\n`);
    process.exitCode = 2;
  }
}
