// shift.mjs 的测试：临时目录里现造 loop.config.mjs（记录型 executor + 前后钩子）与登记表，
// 不起真会话、不碰真 home。时间用固定 fixture；锁的「活进程」直接用测试进程自己的 pid。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, test } from "node:test";

import { loadConfig } from "../src/config.mjs";
import { makeCtx, openOrder } from "../src/orders.mjs";
import { dueShift, setDisabled } from "../src/scheduled-tasks.mjs";
import { gitHeadShort, gitPullFf, lastShiftRow, runShift, shiftRan, shiftSummary } from "../src/shift.mjs";

const HELPERS_URL = JSON.stringify(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "helpers.mjs")).href);

const tempDirs = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "kern-shift-"));
  tempDirs.push(dir);
  return dir;
};
afterEach(() => {
  delete process.env.LOOP_GUARD_ROOT;
  delete process.env.LOOP_SESSION_ID;
  delete process.env.LOOP_SHIFT;
  while (tempDirs.length) rmSync(tempDirs.pop(), { recursive: true, force: true });
});

// 上海墙上时钟 → 绝对时刻（UTC+8，无夏令时），不依赖测试机的系统时区
const bjAt = (h, m = 0, day = 17) => new Date(Date.UTC(2026, 9, day, h - 8, m));
const DAY = "2026-10-17";

// 登记表默认两张任务：main（早班 02:00、晚班 03:00）+ weekly（每周五 17:00）
const TASKS = [
  {
    id: "main",
    name: "主循环",
    runbook: "loop/shift.md",
    executor: "test",
    schedule: { slots: [{ shift: "dawn", name: "早班", hour: 2 }, { shift: "dusk", name: "晚班", hour: 3 }] },
  },
  {
    id: "weekly",
    name: "周班",
    runbook: "loop/week.md",
    executor: "test",
    schedule: { weekday: 5, slots: [{ shift: "weekly", name: "周班", hour: 17 }] },
  },
];

/** 一套注入好的假环境：临时循环根（配置 + 登记表）、临时 loopHome、记录型 executor。
 *  配置文件把 harness 导出，测试 import 同一 URL 拿到同一实例来改结果、读调用。 */
async function makeLoop(over = {}) {
  const root = tempDir();
  const loopHome = tempDir();
  mkdirSync(join(root, "loop"), { recursive: true });
  writeFileSync(join(root, "loop", "scheduled-tasks.json"), JSON.stringify({ tasks: over.tasks ?? TASKS }));
  writeFileSync(
    join(root, "loop.config.mjs"),
    `import { ORDER_TYPES } from ${HELPERS_URL};\n` +
      "export const harness = { calls: { run: [], before: [], after: [], prompts: [], envAt: [] }, result: null };\n" +
      "export default {\n" +
      `  loopHome: ${JSON.stringify(loopHome)},\n` +
      '  launchdPrefix: "com.example.kern-test",\n' +
      "  shifts: {\n" +
      '    dawn: { name: "早班", alwaysRun: true, timeLimitMin: 120 },\n' +
      '    dusk: { name: "晚班", alwaysRun: false, timeLimitMin: 90 },\n' +
      '    weekly: { name: "周班", alwaysRun: true, timeLimitMin: 30 },\n' +
      "  },\n" +
      '  by: ["shift", "manual"],\n' +
      "  orderTypes: ORDER_TYPES,\n" +
      "  ledgerRows: {},\n" +
      "  prompt: (shift, opts) => { harness.calls.prompts.push({ shift, ...opts }); return `prompt-${shift}`; },\n" +
      "  beforeShift: async (x) => { harness.calls.before.push(x); },\n" +
      "  afterShift: async (x) => { harness.calls.after.push(x); },\n" +
      "  executor: {\n" +
      "    run: async (opts) => {\n" +
      "      harness.calls.run.push(opts);\n" +
      "      harness.calls.envAt.push({ sid: process.env.LOOP_SESSION_ID, shift: process.env.LOOP_SHIFT, guard: process.env.LOOP_GUARD_ROOT });\n" +
      '      return harness.result ?? { code: 0, json: { session_id: "s1", result: "干完了" }, timedOut: false, stderr: "", row: { searches: 1 } };\n' +
      "    },\n" +
      "  },\n" +
      "};\n",
  );
  const { harness } = await import(pathToFileURL(join(root, "loop.config.mjs")).href);
  const deps = { root, now: bjAt(5), sessionIdFn: () => "sid-fixed", ...over.deps };
  const readRow = (day = DAY) => JSON.parse(readFileSync(join(root, "loop", "days", day, "shifts.jsonl"), "utf8").trim().split("\n").at(-1));
  return { calls: harness.calls, harness, deps, root, loopHome, readRow };
}

test("shiftRan：只认非 skipped 的行——skipped:lock/quota 不算跑过，skipped-empty 算（#180），无文件算没跑", () => {
  const root = tempDir();
  const dayDir = join(root, "loop", "days", DAY);
  mkdirSync(dayDir, { recursive: true });
  writeFileSync(
    join(dayDir, "shifts.jsonl"),
    [
      { shift: "dawn", key: "alt", exit: 0, timedOut: false },
      { shift: "dusk", skipped: "skipped-empty", key: null, exit: 0, timedOut: false },
      { shift: "dusk", skipped: "quota", key: null, exit: null },
    ]
      .map((r) => JSON.stringify(r))
      .join("\n"),
  );
  assert.equal(shiftRan(root, DAY, "dawn"), true);
  assert.equal(shiftRan(root, DAY, "dusk"), true, "skipped-empty 算跑过（打回：不然 dueShift 每个整点都重查同一个空池）");
  assert.equal(shiftRan(root, DAY, "weekly"), false, "quota 类 skipped 不算");
  assert.equal(shiftRan(root, "2026-10-18", "dawn"), false, "无文件");
});

test("dueShift+shiftRan：dusk 空池 skipped-empty 后不再每小时重查；quota 类 skipped 仍整点重试", () => {
  const seed = (skipped) => {
    const root = tempDir();
    const dayDir = join(root, "loop", "days", DAY);
    mkdirSync(dayDir, { recursive: true });
    writeFileSync(
      join(dayDir, "shifts.jsonl"),
      `${JSON.stringify({ shift: "dawn", end: "y", key: "alt", exit: 0, timedOut: false })}\n${JSON.stringify({ shift: "dusk", skipped, key: null, exit: null })}\n`,
    );
    return root;
  };
  assert.equal(dueShift(TASKS[0], bjAt(4), (d, s) => shiftRan(seed("skipped-empty"), d, s)), null, "两班都算跑过 → 没有该跑的班");
  assert.equal(dueShift(TASKS[0], bjAt(4), (d, s) => shiftRan(seed("quota"), d, s)), "dusk", "额度可能已恢复，保留整点重试");
});

/** 往临时 root 的某圈日写已跑过的班行（非 skipped，shiftRan 认它）。 */
function seedRan(root, day, shifts) {
  const dir = join(root, "loop", "days", day);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "shifts.jsonl"), shifts.map((s) => JSON.stringify({ shift: s, end: "y", key: "alt", exit: 0, timedOut: false })).join("\n") + "\n");
}

/** 在 root 的单池里开一张待做的单（dusk 领得到）。 */
async function openCraft(root, at = bjAt(3)) {
  const ctx = makeCtx(await loadConfig(root), { now: () => at });
  return openOrder(ctx, { type: "craft", title: "做点手作" });
}

/** 关掉注册表里两个 selfStart 单型（侦察/传书）——测试单池真空的场景用。 */
function killSelfStart(root) {
  mkdirSync(join(root, "loop", "switches"), { recursive: true });
  for (const t of ["scout", "herald"]) writeFileSync(join(root, "loop", "switches", `${t}.off`), "");
}

test("runShift：alwaysRun 班正常跑完——行里 sessionId/exit/timedOut/searches/head 齐全，锁释放，钩子被调，日志落盘", async () => {
  const loop = await makeLoop({ deps: { now: bjAt(2), gitHeadFn: () => "abc1234" } });
  const code = await runShift(["--shift", "dawn"], loop.deps);
  assert.equal(code, 0);
  const row = loop.readRow();
  assert.deepEqual(
    { shift: row.shift, exit: row.exit, timedOut: row.timedOut, searches: row.searches, skipped: row.skipped, head: row.head },
    { shift: "dawn", exit: 0, timedOut: false, searches: 1, skipped: undefined, head: "abc1234" },
  );
  assert.equal(row.sessionId, "s1", "claude 回了 session_id 就用它");
  assert.equal(row.summary.endReason, "done", "空池但 selfStart 建议算有活，不算 pool-empty");
  const run = loop.calls.run[0];
  assert.equal(run.cwd, loop.root);
  assert.equal(run.prompt, "prompt-dawn");
  assert.equal(run.timeoutMs, 120 * 60_000);
  assert.equal(run.shift, "dawn");
  assert.deepEqual(loop.calls.envAt[0], { sid: "sid-fixed", shift: "dawn", guard: loop.root }, "会话号/班次/守卫边界都钉进 env");
  assert.deepEqual(loop.calls.prompts[0], { shift: "dawn", dryRun: false });
  assert.deepEqual(
    { root: loop.calls.before[0].root, shift: loop.calls.before[0].shift, log: typeof loop.calls.before[0].log },
    { root: loop.root, shift: "dawn", log: "function" },
  );
  assert.equal(loop.calls.after[0].shift, "dawn");
  assert.deepEqual({ code: loop.calls.after[0].result.code, searches: loop.calls.after[0].result.row.searches }, { code: 0, searches: 1 }, "afterShift 拿到 executor 原始结果");
  assert.equal(existsSync(join(loop.loopHome, "shift.lock")), false, "锁已释放");
  const logText = readFileSync(join(loop.loopHome, "logs", `${DAY}-dawn.log`), "utf8");
  assert.match(logText, /start shift=dawn/);
  assert.match(logText, /prompt: prompt-dawn/);
  assert.match(logText, /干完了/);
  assert.equal(process.env.LOOP_SESSION_ID, undefined, "班结束清掉，不串到下一班");
  assert.equal(process.env.LOOP_SHIFT, undefined);
});

test("runShift：claude 不回 session_id 时班记录回落到预先定的号", async () => {
  const loop = await makeLoop();
  loop.harness.result = { code: 1, json: null, stderr: "boom", timedOut: false };
  assert.equal(await runShift(["--shift", "dawn"], loop.deps), 1);
  assert.equal(loop.readRow().sessionId, "sid-fixed");
});

test("runShift：executor 给 skip → 写 skipped 行退出 0，不写小结、afterShift 不调", async () => {
  const loop = await makeLoop({ deps: { now: bjAt(2) } });
  loop.harness.result = { skip: "quota" };
  assert.equal(await runShift(["--shift", "dawn"], loop.deps), 0);
  assert.equal(loop.calls.run.length, 1, "executor 被调（skip 由它判）");
  const row = loop.readRow();
  assert.equal(row.skipped, "quota");
  assert.equal(row.key, null);
  assert.equal(row.summary, undefined, "skipped 行不写小结");
  assert.equal(loop.calls.after.length, 0);
  assert.match(readFileSync(join(loop.loopHome, "logs", `${DAY}-dawn.log`), "utf8"), /skipped: quota/);
});

test("runShift：alwaysRun:false 空池 → skipped-empty（不 spawn、无 sessionId、exit 0、summary 记上）", async () => {
  const loop = await makeLoop({ deps: { now: bjAt(3) } });
  killSelfStart(loop.root); // 关掉 selfStart 建议单型，池才是真空
  const code = await runShift(["--shift", "dusk"], loop.deps);
  assert.equal(code, 0);
  assert.equal(loop.calls.run.length, 0, "不起会话");
  assert.equal(loop.calls.before.length, 1, "钩子在查池之前照走");
  const row = loop.readRow();
  assert.equal(row.skipped, "skipped-empty");
  assert.equal(row.exit, 0);
  assert.equal(row.sessionId, undefined);
  assert.equal(row.key, null);
  assert.equal(row.summary.endReason, "skipped-empty");
});

test("runShift：alwaysRun:false 有单（已开待做）照跑；selfStart 建议也算有活", async () => {
  const busy = await makeLoop({ deps: { now: bjAt(3) } });
  await openCraft(busy.root);
  assert.equal(await runShift(["--shift", "dusk"], busy.deps), 0);
  assert.equal(busy.calls.run.length, 1);
  assert.equal(busy.readRow().skipped, undefined);

  // 空池但注册表里有 selfStart 单型（scout）→ nextOrder 给建议，算有活
  const suggest = await makeLoop({ deps: { now: bjAt(3) } });
  assert.equal(await runShift(["--shift", "dusk"], suggest.deps), 0);
  assert.equal(suggest.calls.run.length, 1);
});

test("runShift：查池出错 → 宁可多跑不漏跑，日志记原因；班小结算不出记 summary:null", async () => {
  const loop = await makeLoop({ deps: { now: bjAt(3) } });
  const dayDir = join(loop.root, "loop", "days", DAY);
  mkdirSync(dayDir, { recursive: true });
  writeFileSync(join(dayDir, "orders.jsonl"), "不是 JSON\n");
  assert.equal(await runShift(["--shift", "dusk"], loop.deps), 0);
  assert.equal(loop.calls.run.length, 1, "照起会话");
  assert.equal(loop.readRow().skipped, undefined);
  assert.equal(loop.readRow().summary, null, "小结的 nextFn 同样读坏池，算失败只记 null");
  assert.match(readFileSync(join(loop.loopHome, "logs", `${DAY}-dusk.log`), "utf8"), /查单池出错/);
});

test("runShift：班记录带 summary（窗口内单量/被拒/收工原因）", async () => {
  const loop = await makeLoop({ deps: { now: bjAt(2) } });
  const dayDir = join(loop.root, "loop", "days", DAY);
  mkdirSync(dayDir, { recursive: true });
  writeFileSync(
    join(dayDir, "orders.jsonl"),
    [
      { ts: "2026-10-16T18:10:00.000Z", order: "20261017-craft-1", event: "open", type: "craft" },
      { ts: "2026-10-16T19:00:00.000Z", order: "20261017-craft-1", event: "done", type: "craft" },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n") + "\n",
  );
  writeFileSync(join(dayDir, "rejects.jsonl"), `${JSON.stringify({ ts: "2026-10-16T18:20:00.000Z", shift: "dawn", type: "craft", reason: "达到每日上限 5" })}\n`);
  assert.equal(await runShift(["--shift", "dawn"], loop.deps), 0);
  const row = loop.readRow();
  assert.deepEqual(row.summary.orders, { done: 1, failed: 0, waiting: 0, opened: 1 });
  assert.deepEqual(row.summary.rejects, [{ type: "craft", reason: "达到每日上限 5", count: 1 }]);
  assert.equal(row.summary.endReason, "done");
});

test("runShift：--dry-run 把 dryRun 传给 config.prompt", async () => {
  const loop = await makeLoop({ deps: { now: bjAt(2) } });
  assert.equal(await runShift(["--shift", "dawn", "--dry-run"], loop.deps), 0);
  assert.deepEqual(loop.calls.prompts[0], { shift: "dawn", dryRun: true });
});

test("runShift：超时 → timedOut:true 退出 1；is_error 也算失败", async () => {
  const timedOut = await makeLoop({ deps: { now: bjAt(3) } });
  await openCraft(timedOut.root);
  timedOut.harness.result = { code: null, json: null, timedOut: true, stderr: "" };
  assert.equal(await runShift(["--shift", "dusk"], timedOut.deps), 1);
  assert.equal(timedOut.readRow().timedOut, true);
  assert.equal(timedOut.readRow().summary.endReason, "timeout");

  const isError = await makeLoop({ deps: { now: bjAt(2) } });
  isError.harness.result = { code: 0, json: { is_error: true, result: "网关炸了" }, timedOut: false, stderr: "" };
  assert.equal(await runShift(["--shift", "dawn"], isError.deps), 1);
});

test("runShift：上一班还活着（锁新、pid 活）→ skipped:lock 退出且不动别人的锁", async () => {
  const loop = await makeLoop({ deps: { now: bjAt(2) } });
  const lockFile = join(loop.loopHome, "shift.lock");
  writeFileSync(lockFile, `${JSON.stringify({ pid: process.pid, started: "2026-10-17T04:30:00.000Z" })}\n`);
  assert.equal(await runShift(["--shift", "dawn"], loop.deps), 0);
  assert.equal(loop.calls.run.length, 0);
  assert.equal(loop.readRow().skipped, "lock");
  assert.match(readFileSync(lockFile, "utf8"), /04:30/); // 锁内容没被改
});

test("runShift：死锁可抢占——pid 已死或超 3 小时的锁被换成本班，跑完释放", async () => {
  const loop = await makeLoop({ deps: { now: bjAt(13) } }); // UTC 05:00：下面的旧锁已 4 小时
  const lockFile = join(loop.loopHome, "shift.lock");
  writeFileSync(lockFile, `${JSON.stringify({ pid: 2_000_000_000, started: "2026-10-17T04:59:00.000Z" })}\n`);
  assert.equal(await runShift(["--shift", "dawn"], loop.deps), 0);
  assert.equal(loop.calls.run.length, 1);
  assert.equal(existsSync(lockFile), false);

  // 超时锁：pid 活着但 started 已 4 小时前
  writeFileSync(lockFile, `${JSON.stringify({ pid: process.pid, started: "2026-10-17T01:00:00.000Z" })}\n`);
  assert.equal(await runShift(["--shift", "dawn"], loop.deps), 0);
  assert.equal(loop.calls.run.length, 2);
  assert.equal(existsSync(lockFile), false);
});

test("runShift --task main：01:30 noop、02:00 开早班、前一班没跑完顺延；dusk 空池轮到时记 skipped-empty", async () => {
  const early = await makeLoop({ deps: { now: bjAt(1, 30) } });
  assert.equal(await runShift(["--task", "main"], early.deps), 0);
  assert.equal(early.calls.run.length, 0);
  assert.equal(existsSync(join(early.root, "loop", "days")), false, "noop 不写 shifts.jsonl");
  assert.match(readFileSync(join(early.loopHome, "logs", `${DAY}-main.log`), "utf8"), /noop/);

  const onTime = await makeLoop({ deps: { now: bjAt(2) } });
  assert.equal(await runShift(["--task", "main"], onTime.deps), 0);
  assert.equal(onTime.readRow().shift, "dawn");

  // 03:00 早班没跑过 → 仍先补早班，不跳到晚班
  const behind = await makeLoop({ deps: { now: bjAt(3) } });
  assert.equal(await runShift(["--task", "main"], behind.deps), 0);
  assert.equal(behind.readRow().shift, "dawn");

  // 03:00 早班跑过 → 晚班（空池 → skipped-empty，不算失败）
  const caught = await makeLoop({ deps: { now: bjAt(3) } });
  seedRan(caught.root, DAY, ["dawn"]);
  killSelfStart(caught.root);
  assert.equal(await runShift(["--task", "main"], caught.deps), 0);
  assert.equal(caught.readRow().shift, "dusk");
  assert.equal(caught.readRow().skipped, "skipped-empty");
});

test("runShift --task：停用标记 → noop 且不写 shifts.jsonl；--shift 手动开班不受停用影响", async () => {
  const off = await makeLoop({ deps: { now: bjAt(2) } });
  setDisabled(off.loopHome, "main", true);
  assert.equal(await runShift(["--task", "main"], off.deps), 0);
  assert.equal(off.calls.run.length, 0);
  assert.equal(existsSync(join(off.root, "loop", "days")), false);
  assert.match(readFileSync(join(off.loopHome, "logs", `${DAY}-main.log`), "utf8"), /已停用/);

  assert.equal(await runShift(["--shift", "dawn"], off.deps), 0);
  assert.equal(off.readRow().shift, "dawn");
});

test("runShift --task weekly：周四 17:00 noop，周五 17:00 开周班", async () => {
  const thu = await makeLoop({ deps: { now: bjAt(17, 0, 22) } });
  assert.equal(await runShift(["--task", "weekly"], thu.deps), 0);
  assert.equal(thu.calls.run.length, 0);

  const fri = await makeLoop({ deps: { now: bjAt(17, 0, 23) } });
  assert.equal(await runShift(["--task", "weekly"], fri.deps), 0);
  assert.equal(fri.readRow("2026-10-23").shift, "weekly");
});

test("runShift：未知任务/班退出 2；登记表班编号不在 config.shifts 里也退出 2", async () => {
  const loop = await makeLoop();
  const err = [];
  const saved = process.stderr.write;
  const grab = (s) => {
    err.push(String(s));
    return true;
  };
  process.stderr.write = grab;
  try {
    assert.equal(await runShift(["--task", "nope"], loop.deps), 2);
    assert.match(err.join(""), /main/);
    err.length = 0;
    assert.equal(await runShift(["--shift", "nope"], loop.deps), 2);
    assert.match(err.join(""), /dawn/);
    assert.equal(existsSync(join(loop.root, "loop", "days")), false);
  } finally {
    process.stderr.write = saved;
  }

  const stray = await makeLoop({
    tasks: [
      {
        id: "main",
        name: "主循环",
        runbook: "loop/shift.md",
        executor: "test",
        schedule: { slots: [{ shift: "dawn", name: "早班", hour: 2 }, { shift: "dusk", name: "晚班", hour: 3 }, { shift: "night", name: "夜班", hour: 4 }] },
      },
    ],
  });
  err.length = 0;
  process.stderr.write = grab;
  try {
    assert.equal(await runShift(["--shift", "night"], stray.deps), 2, "登记表里的班必须都在 shifts 里");
    assert.match(err.join(""), /night/);
  } finally {
    process.stderr.write = saved;
  }
});

test("lastShiftRow：今天没有就往前翻（最多 7 天），都翻不到 → null", () => {
  const root = tempDir();
  assert.equal(lastShiftRow(root, { now: bjAt(5) }), null);
  const dir = join(root, "loop", "days", "2026-10-15");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "shifts.jsonl"), `${JSON.stringify({ shift: "dawn", start: "2026-10-15T21:00:00.000Z", key: "alt", exit: 0 })}\n`);
  assert.equal(lastShiftRow(root, { now: bjAt(5) }).shift, "dawn");
});

test("shiftSummary：四种收工原因——timedOut→timeout、exit≠0→error、班末无单→pool-empty、其余→done", () => {
  const base = { start: "2026-10-17T05:00:00.000Z", end: "2026-10-17T07:00:00.000Z", shift: "dusk" };
  assert.equal(shiftSummary({ ...base, timedOut: true, exit: null }).endReason, "timeout");
  assert.equal(shiftSummary({ ...base, timedOut: false, exit: -1 }, { nextFn: () => { throw new Error("不该问 next"); } }).endReason, "error");
  assert.equal(shiftSummary({ ...base, timedOut: false, exit: 0 }, { nextFn: () => ({ order: null, type: null }) }).endReason, "pool-empty");
  assert.equal(shiftSummary({ ...base, timedOut: false, exit: 0 }, { nextFn: () => ({ order: "20261017-craft-1" }) }).endReason, "done");
  assert.equal(shiftSummary({ ...base, timedOut: false, exit: 0 }, { nextFn: () => ({ order: null, type: "scout" }) }).endReason, "done", "还有可开的建议单不算池空");
});

test("shiftSummary：窗口内事件按单号去重、窗外不算；rejects 同 type+reason 去重计 count", () => {
  const row = { start: "2026-10-17T05:00:00.000Z", end: "2026-10-17T07:00:00.000Z", shift: "dusk", exit: 0, timedOut: false };
  const events = [
    { ts: "2026-10-17T05:10:00.000Z", order: "A", event: "open" },
    { ts: "2026-10-17T06:00:00.000Z", order: "A", event: "done" },
    { ts: "2026-10-17T06:30:00.000Z", order: "A", event: "done" }, // 同单重复 done 不重计
    { ts: "2026-10-17T06:40:00.000Z", order: "B", event: "open" },
    { ts: "2026-10-17T06:50:00.000Z", order: "B", event: "needs_you" },
    { ts: "2026-10-17T06:55:00.000Z", order: "C", event: "fail" },
    { ts: "2026-10-17T04:59:00.000Z", order: "D", event: "open" }, // 窗口前
    { ts: "2026-10-17T07:00:00.000Z", order: "E", event: "open" }, // 恰在 end，含
  ];
  const rejects = [
    { ts: "2026-10-17T05:20:00.000Z", type: "craft", reason: "同 key 已有单" },
    { ts: "2026-10-17T05:40:00.000Z", type: "craft", reason: "同 key 已有单" },
    { ts: "2026-10-17T06:00:00.000Z", type: "craft", reason: "达到每日上限" },
    { ts: "2026-10-17T06:10:00.000Z", type: "herald", reason: "同 key 已有单" },
    { ts: "2026-10-17T08:00:00.000Z", type: "craft", reason: "窗外" },
  ];
  const s = shiftSummary(row, { orderEvents: events, rejectRows: rejects, nextFn: () => ({ order: null, type: null }) });
  assert.deepEqual(s.orders, { done: 1, failed: 1, waiting: 1, opened: 3 });
  assert.deepEqual(s.rejects, [
    { type: "craft", reason: "同 key 已有单", count: 2 },
    { type: "craft", reason: "达到每日上限", count: 1 },
    { type: "herald", reason: "同 key 已有单", count: 1 },
  ]);
  assert.equal(s.endReason, "pool-empty");
});

test("gitHeadShort：正常返回短哈希，取不到返回 null，绝不抛错", () => {
  const r = gitHeadShort("/w", (cmd, args) => {
    assert.equal(cmd, "git");
    assert.deepEqual(args, ["rev-parse", "--short", "HEAD"]);
    return { status: 0, stdout: "abc1234\n" };
  });
  assert.equal(r, "abc1234");
  assert.equal(gitHeadShort("/w", () => ({ status: 128 })), null);
  assert.equal(gitHeadShort("/w", () => { throw new Error("ENOENT"); }), null);
});

test("gitPullFf：参数数组无 shell，失败不抛错（钩子里用）", () => {
  const seen = [];
  const ok = gitPullFf("/w", (cmd, args, opts) => (seen.push([cmd, args, opts.cwd]), { status: 0, stdout: "Already up to date.\n", stderr: "" }));
  assert.deepEqual(seen, [["git", ["pull", "--ff-only"], "/w"]]);
  assert.deepEqual(ok, { ok: true, detail: "Already up to date." });
  const bad = gitPullFf("/w", () => ({ status: 128, stdout: "", stderr: "fatal: Not possible to fast-forward, aborting.\n" }));
  assert.equal(bad.ok, false);
  assert.match(bad.detail, /fast-forward/);
  assert.equal(gitPullFf("/w", () => { throw new Error("spawn git ENOENT"); }).ok, false);
});
