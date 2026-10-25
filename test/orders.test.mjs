// orders.mjs：七阶段迁移、防重复、上限（perDay/perWeek/perWeekPer）、开关、搜索预算、
// next 建议（selfStart/activeGroups/suggestExtras）、班次推算（LOOP_SHIFT/shiftOf/manual）、
// 账本行（delivery 形状 + 通用合并 + validators）、rejects、CLI、锁与并发。
// 全部临时目录 + 注入时间（小注册表见 helpers.mjs）。
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
  LOCK_RETRY_MS,
  SEARCH_BUDGET,
  capProblem,
  isFault,
  weekOpened,
  listOrders,
  main,
  makeCtx as kernelMakeCtx,
  nextOrder,
  openOrder,
  switchFile,
  transitionOrder,
  withDayLock,
} from "../src/orders.mjs";
import { addLedgerRow } from "../src/ledger.mjs";
import { testConfig, writeConfigFile } from "./helpers.mjs";

const tempDirs = [];
function tempDir(prefix = "orders-test-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop(), { recursive: true, force: true });
});

// 北京 2026-10-17 12:00（周六）；所有时间注入，不耦合活墙钟
const NOW = new Date("2026-10-17T04:00:00.000Z");
const at = (iso) => new Date(iso);
const DAY = "2026-10-17";

function makeCtx(over = {}) {
  const { config, ...deps } = over;
  return kernelMakeCtx(config ?? testConfig(), {
    daysDir: tempDir("orders-days-"),
    switchesDir: tempDir("orders-sw-"),
    ledgerFile: join(tempDir("orders-ledger-"), "ledger.jsonl"),
    now: NOW,
    shiftOf: () => "dawn",
    ...deps,
  });
}

/** 跑一遍 CLI main，抓 stdout JSON 与退出码（跑完恢复现场，不污染别的用例）。 */
async function runMain(argv, deps) {
  const chunks = [];
  const origWrite = process.stdout.write;
  const prevExit = process.exitCode;
  process.stdout.write = (chunk) => {
    chunks.push(chunk);
    return true;
  };
  try {
    await main(argv, deps);
    return { body: JSON.parse(chunks.join("")), code: process.exitCode };
  } finally {
    process.stdout.write = origWrite;
    process.exitCode = prevExit;
  }
}

test("makeCtx：路径从 config.root 推、注册表组好、quotaFn 默认放行、suggestExtras 默认空；deps 可覆盖", () => {
  const ctx = kernelMakeCtx(testConfig({ root: "/w/loop-x" }), {});
  assert.equal(ctx.daysDir, "/w/loop-x/loop/days");
  assert.equal(ctx.switchesDir, "/w/loop-x/loop/switches");
  assert.equal(ctx.ledgerFile, "/w/loop-x/loop/ledger.jsonl");
  assert.equal(ctx.registry.getType("decision").id, "decision");
  assert.deepEqual(ctx.registry.shiftIds, ["dawn", "dusk", "manual"]);
  assert.equal(ctx.registry.by, testConfig().by);
  assert.equal(ctx.quotaFn({}), "ok");
  assert.deepEqual(ctx.suggestExtras, {});
  assert.deepEqual(ctx.ledgerRows, {});
  const over = kernelMakeCtx(testConfig(), { daysDir: "/d", quotaFn: () => null });
  assert.equal(over.daysDir, "/d");
  assert.equal(over.quotaFn({}), null);
});

test("七阶段合法迁移：open→start→needs_you→resume→done、open→queue→start→done、直接 done/fail/close、open→needs_you", () => {
  const ctx = makeCtx();
  const a = openOrder(ctx, { type: "craft", title: "A", trial: "t1" });
  assert.equal(a.phase, "todo");
  assert.equal(transitionOrder(ctx, a.order, "start").phase, "doing");
  assert.equal(transitionOrder(ctx, a.order, "needs_you").phase, "waiting");
  assert.equal(transitionOrder(ctx, a.order, "resume").phase, "doing");
  assert.equal(transitionOrder(ctx, a.order, "done", { verified: false }).phase, "done");

  const b = openOrder(ctx, { type: "craft", title: "B", trial: "t2" });
  assert.equal(transitionOrder(ctx, b.order, "queue", { reason: "等额度" }).phase, "queued");
  assert.equal(transitionOrder(ctx, b.order, "start").phase, "doing");
  assert.equal(transitionOrder(ctx, b.order, "queue", { reason: "前置单没好" }).phase, "queued"); // 做到一半也能退回排队
  assert.equal(transitionOrder(ctx, b.order, "start").phase, "doing");
  assert.equal(transitionOrder(ctx, b.order, "done", { verified: true, artifacts: ["https://x.example/b"] }).phase, "done");

  const c = openOrder(ctx, { type: "craft", title: "C", trial: "t3" });
  assert.equal(transitionOrder(ctx, c.order, "done", { verified: false }).phase, "done"); // 小单可直达完成
  const f = openOrder(ctx, { type: "craft", title: "D", trial: "t4" });
  assert.equal(transitionOrder(ctx, f.order, "fail", { reason: "线上 500" }).phase, "failed");
  const g = openOrder(ctx, { type: "craft", title: "E", trial: "t5" });
  assert.equal(transitionOrder(ctx, g.order, "close", { reason: "已拍板不做" }).phase, "closed");

  // 人工关卡单型：manual 班直接挂等你
  const r = openOrder(ctx, { type: "decision", title: "拍板 Q1", shift: "manual", by: "manual", data: { question: "Q1" } });
  assert.equal(transitionOrder(ctx, r.order, "needs_you").phase, "waiting");
});

test("非法迁移拒绝：终态不再迁移、doing 不吃 start/resume、waiting 只吃 resume、找不到单", () => {
  const ctx = makeCtx();
  const a = openOrder(ctx, { type: "craft", title: "A", trial: "t1" });
  assert.throws(() => transitionOrder(ctx, a.order, "resume"), /非法迁移.*待做/); // 待做没有「恢复」一说
  transitionOrder(ctx, a.order, "start");
  assert.throws(() => transitionOrder(ctx, a.order, "start"), /非法迁移/);
  assert.throws(() => transitionOrder(ctx, a.order, "resume"), /非法迁移.*在做/);
  assert.throws(() => transitionOrder(ctx, a.order, "done", { verified: true }), /缺 url/); // 缺 url，账本行写不出，整单不动

  const w = openOrder(ctx, { type: "craft", title: "W", trial: "t2" });
  transitionOrder(ctx, w.order, "needs_you");
  assert.throws(() => transitionOrder(ctx, w.order, "start"), /非法迁移/); // 等你之后只能 resume

  const d = openOrder(ctx, { type: "craft", title: "D", trial: "t3" });
  transitionOrder(ctx, d.order, "done", { verified: false });
  assert.throws(() => transitionOrder(ctx, d.order, "done", { verified: false }), /终态/);
  assert.throws(() => transitionOrder(ctx, d.order, "start"), /非法迁移/);

  const f = openOrder(ctx, { type: "craft", title: "F", trial: "t4" });
  transitionOrder(ctx, f.order, "fail", { reason: "坏了" });
  assert.throws(() => transitionOrder(ctx, f.order, "start"), /非法迁移/);

  assert.throws(() => transitionOrder(ctx, "20991017-craft-9", "start"), /找不到单/);
});

test("开单和迁移事件带 sessionId：环境变量、显式参数，没有就不写", () => {
  const ctx = makeCtx();
  process.env.LOOP_SESSION_ID = "sess-from-shift";
  try {
    const a = openOrder(ctx, { type: "craft", title: "带会话", trial: "t1" });
    assert.equal(listOrders(ctx, {}).find((s) => s.order === a.order).sessionId, "sess-from-shift");
    transitionOrder(ctx, a.order, "start");
    assert.equal(listOrders(ctx, {}).find((s) => s.order === a.order).sessionId, "sess-from-shift");

    const b = openOrder(ctx, { type: "craft", title: "显式会话", trial: "t2", sessionId: "sess-explicit" });
    assert.equal(listOrders(ctx, {}).find((s) => s.order === b.order).sessionId, "sess-explicit");

    delete process.env.LOOP_SESSION_ID;
    const c = openOrder(ctx, { type: "craft", title: "无会话", trial: "t3" });
    assert.equal(listOrders(ctx, {}).find((s) => s.order === c.order).sessionId, undefined);
    transitionOrder(ctx, c.order, "done", { verified: false, sessionId: "sess-on-close" });
    assert.equal(listOrders(ctx, {}).find((s) => s.order === c.order).sessionId, "sess-on-close");
  } finally {
    delete process.env.LOOP_SESSION_ID;
  }
  const lines = readFileSync(join(ctx.daysDir, DAY, "orders.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.filter((e) => e.event === "open" && e.sessionId === "sess-from-shift").length, 1);
  assert.equal(lines.find((e) => e.event === "start").sessionId, "sess-from-shift");
  assert.equal(lines.find((e) => e.event === "done").sessionId, "sess-on-close");
});

test("fail/close/queue 必须写 --reason", () => {
  const ctx = makeCtx();
  const a = openOrder(ctx, { type: "craft", title: "A", trial: "t1" });
  for (const event of ["fail", "close", "queue"]) {
    assert.throws(() => transitionOrder(ctx, a.order, event), /--reason/);
  }
});

test("防重复硬闸：同 key 有核验完成单 → open 拒绝（跨天也拦）；只有未核验完成的不拦；进行中同 key 拒绝", () => {
  const ctx = makeCtx();
  const a = openOrder(ctx, { type: "craft", title: "A", trial: "t1", key: "K1" });
  transitionOrder(ctx, a.order, "done", { verified: true, artifacts: ["https://x.example/a"] });
  assert.throws(() => openOrder(ctx, { type: "craft", title: "A2", trial: "t1", key: "K1" }), /核验完成.*防重复/);

  // 跨天回看：三天后同 key 一样被拦（防重复不看开单日，只看 key）
  const ctx3 = makeCtx({ daysDir: ctx.daysDir, now: () => at("2026-10-20T04:00:00.000Z") });
  assert.throws(() => openOrder(ctx3, { type: "craft", title: "A3", trial: "t1", key: "K1" }), /核验完成/);

  // 未核验的完成单不拦（可以重做同 key）
  const b = openOrder(ctx, { type: "craft", title: "B", trial: "t2", key: "K2" });
  transitionOrder(ctx, b.order, "done", { verified: false });
  assert.equal(openOrder(ctx, { type: "craft", title: "B2", trial: "t2", key: "K2" }).phase, "todo");

  // 失败的单不拦（可以重开）
  const f = openOrder(ctx, { type: "craft", title: "F", trial: "t3", key: "K3" });
  transitionOrder(ctx, f.order, "fail", { reason: "坏了" });
  assert.equal(openOrder(ctx, { type: "craft", title: "F2", trial: "t3", key: "K3" }).phase, "todo");

  // 进行中的同 key 拒绝
  const g = openOrder(ctx, { type: "craft", title: "G", trial: "t4", key: "K4" });
  transitionOrder(ctx, g.order, "start");
  assert.throws(() => openOrder(ctx, { type: "craft", title: "G2", trial: "t4", key: "K4" }), /进行中/);
});

test("caps perDay：patrol 每圈 1，次日放行；不写 --trial 归 defaultTrial", () => {
  const ctx = makeCtx();
  const first = openOrder(ctx, { type: "patrol", title: "巡一圈", key: "i1" });
  assert.equal(listOrders(ctx).find((s) => s.order === first.order).trial, "patrol-line");
  assert.throws(() => openOrder(ctx, { type: "patrol", title: "再巡一圈", key: "i2" }), /每日上限 1/);
  const ctx2 = makeCtx({ daysDir: ctx.daysDir, now: () => at("2026-10-18T04:00:00.000Z") });
  assert.equal(openOrder(ctx2, { type: "patrol", title: "次圈再巡", key: "i3" }).day, "2026-10-18");
});

test("craft 按标题去重 + 每试验每天 ≤5（perDayPer）：同试验第 6 张被拒、别的试验不受影响、同标题重复被拒", () => {
  const ctx = makeCtx();
  for (const title of ["一", "二", "三", "四", "五"]) {
    const o = openOrder(ctx, { type: "craft", title, trial: "t1" });
    assert.equal(o.key, `craft:t1:${DAY}:${title}`);
  }
  assert.throws(() => openOrder(ctx, { type: "craft", title: "六", trial: "t1" }), /trial=t1 今日已开 5 单，达到每日上限 5/);
  assert.equal(openOrder(ctx, { type: "craft", title: "别家一", trial: "t2" }).phase, "todo"); // 不同试验互不影响
  assert.throws(() => openOrder(ctx, { type: "craft", title: "一", trial: "t1" }), /进行中/); // 同标题重复：防重复键带 title
  // 键带圈日：次日同试验同标题可再开
  const tomorrow = makeCtx({ daysDir: ctx.daysDir, now: () => at("2026-10-18T04:00:00.000Z") });
  assert.equal(openOrder(tomorrow, { type: "craft", title: "一", trial: "t1" }).day, "2026-10-18");
});

test("系统故障的单不占每日/每周上限，其余原因的关闭/失败照常计数", () => {
  const type = { id: "x", label: "X", caps: { perDay: 1, perWeek: 1 } };
  const fault = { type: "x", day: DAY, phase: "closed", reason: "系统故障：spawn 网关 ENOENT" };
  assert.equal(isFault(fault), true);
  assert.equal(capProblem(type, [fault], DAY, {}), null);
  assert.equal(isFault({ ...fault, phase: "failed" }), true);
  assert.equal(isFault({ ...fault, phase: "waiting" }), false); // 没关掉的单不算
  assert.match(capProblem(type, [{ ...fault, reason: "选题不要了" }], DAY, {}), /上限/);
  assert.match(capProblem(type, [{ ...fault, phase: "done", reason: undefined }], DAY, {}), /上限/);
  assert.equal(weekOpened(type, [fault], DAY), 0);
});

test("caps perWeek 跨周边界：近 7 个圈日窗口含今天与 6 天前，第 7 天前掉出窗口", () => {
  const type = { id: "x", label: "X", caps: { perWeek: 2 } };
  assert.match(capProblem(type, [{ type: "x", day: "2026-10-11" }, { type: "x", day: DAY }], DAY, {}), /每周上限 2/);
  assert.equal(capProblem(type, [{ type: "x", day: "2026-10-10" }, { type: "x", day: DAY }], DAY, {}), null);
  assert.equal(capProblem(type, [{ type: "x", day: "2026-10-11" }], DAY, {}), null);
});

test("caps perWeekPer（herald 每分组每周 ≤2）：同分组第 3 张拒绝、他分组不受影响、滚动窗口腾名额、缺分组字段拒绝", () => {
  const ctx = makeCtx();
  const open = (iso, channel, tag) => {
    ctx.now = () => at(iso);
    return openOrder(ctx, { type: "herald", title: `传 ${tag}`, data: { channel, tag } });
  };
  open("2026-10-11T04:00:00.000Z", "wire", "1");
  open("2026-10-16T04:00:00.000Z", "wire", "2");
  assert.throws(
    () => open("2026-10-17T05:00:00.000Z", "wire", "3"),
    /channel=wire 近 7 个圈日已开 2 单，达到每周上限 2/,
  );
  open("2026-10-17T05:00:00.000Z", "beam", "1"); // 分组独立
  // 次圈回看窗口 [10-12..10-18]，10-11 那张掉出 → wire 腾出一个名额
  open("2026-10-18T04:00:00.000Z", "wire", "3");
  // 缺分组字段在 open 时兜底拒绝
  ctx.now = () => NOW;
  assert.throws(() => openOrder(ctx, { type: "herald", title: "没分组", data: { tag: "x" } }), /缺 channel 字段/);
});

test("开关：switches/<id>.off 存在 → open 拒绝、next 不给该单型；拍板单不受开关约束", async () => {
  const ctx = makeCtx();
  openOrder(ctx, { type: "patrol", title: "巡一圈", key: "i1" });
  writeFileSync(switchFile(ctx.switchesDir, "patrol"), "");
  assert.throws(() => openOrder(ctx, { type: "patrol", title: "再巡", key: "i2" }), /开关关闭/);
  const next = nextOrder(ctx, { shift: "dawn" });
  assert.notEqual(next.type, "patrol"); // 待做的巡守单也被开关过滤
  assert.equal(next.type, "scout"); // 退而给出本班可建议的 selfStart 单型
  assert.equal(existsSync(switchFile(ctx.switchesDir, "craft")), false);
  // 人工关卡类（switch 声明 null）不受开关约束
  writeFileSync(switchFile(ctx.switchesDir, "decision"), "");
  assert.equal(
    openOrder(ctx, { type: "decision", title: "拍板 Q1", shift: "manual", by: "manual", data: { question: "Q1" } }).phase,
    "todo",
  );

  // CLI 层：拒绝 = 退出码 2 + 中文原因（用不限班次的 scout 验开关，CLI 默认班次是 manual）
  writeFileSync(switchFile(ctx.switchesDir, "scout"), "");
  const root = writeConfigFile(tempDir("orders-root-"));
  const { body, code } = await runMain(["open", "scout", "--title", "x"], {
    root,
    daysDir: ctx.daysDir,
    switchesDir: ctx.switchesDir,
    ledgerFile: ctx.ledgerFile,
    now: () => NOW,
  });
  assert.equal(code, 2);
  assert.equal(body.ok, false);
  assert.match(body.error, /开关关闭/);
});

test("搜索预算：当天已开单估值累计 30 为界，超线只给不耗搜索的单；done --searches 回填实际值修正估值", () => {
  const ctx = makeCtx();
  const open = (topic) => openOrder(ctx, { type: "scout", title: `侦察 ${topic}`, data: { topic } });
  const [r1, r2, r3] = ["kw-a", "kw-b", "kw-c"].map(open);
  // 3 张估值恰 30：候选扣除自己后 20+10=30 ≤ 30 → 边界上还给
  assert.equal(nextOrder(ctx, { shift: "dawn" }).order, r1.order);
  // 第 4 张开出后估值 40：任何 scout 扣除自己仍 ≥30 → 建议分支给不出耗搜索的单型，
  // craft 绝不在此建议（selfStart=false，只能明确 open）
  open("kw-d");
  const over = nextOrder(ctx, { shift: "dawn" });
  assert.equal(over.order, null);
  assert.equal(over.type, null);

  // 回填实际搜索次数：r1 实际 5 次、r2 实际 0 次 → 用量 5+0+10+10=25 → r3 回到可领
  transitionOrder(ctx, r1.order, "done", { verified: false, searches: 5 });
  transitionOrder(ctx, r2.order, "done", { verified: false, searches: 0 });
  assert.equal(nextOrder(ctx, { shift: "dawn" }).order, r3.order);
  assert.equal(listOrders(ctx).find((s) => s.order === r1.order).searches, 5);
  assert.equal(SEARCH_BUDGET, 30);
});

test("next 建议查 activeGroups（type.activeGroups(ctx) 给可用分组）：分组全满不给建议、有未满的才建议、拿不到清单不建议", () => {
  const ctx = makeCtx({ channels: ["wire", "beam"] });
  const post = (iso, channel, tag) => {
    ctx.now = () => at(iso);
    const o = openOrder(ctx, { type: "herald", title: `传 ${tag}`, data: { channel } });
    transitionOrder(ctx, o.order, "done", { verified: false });
    ctx.now = () => NOW;
  };
  post("2026-10-11T04:00:00.000Z", "wire", "1");
  post("2026-10-16T04:00:00.000Z", "wire", "2");
  // wire 满 2、beam 未满 → 仍建议 herald
  assert.equal(nextOrder(ctx, { shift: "dawn" }).type, "herald");
  // beam 也满 → 不建议 herald；把 scout 也关掉，别让建议落到它头上
  post("2026-10-11T04:00:00.000Z", "beam", "1");
  post("2026-10-16T04:00:00.000Z", "beam", "2");
  writeFileSync(switchFile(ctx.switchesDir, "scout"), "");
  assert.equal(nextOrder(ctx, { shift: "dawn" }).type, null, "两个分组都满了不应建议 herald");
  // 拿不到分组清单（ctx.channels 缺失）也不建议——宁可漏建议，不要假建议
  const noList = makeCtx({ daysDir: ctx.daysDir, switchesDir: ctx.switchesDir });
  assert.equal(nextOrder(noList, { shift: "dawn" }).type, null);
});

test("selfStart：next 的建议分支只从自启单型（herald/scout）里挑；全关掉后拿不到任何建议", () => {
  const ctx = makeCtx(); // 无 channels：herald 拿不到分组清单不建议
  for (const shift of ["dawn", "dusk"]) {
    const s = nextOrder(ctx, { shift });
    assert.equal(s.order, null);
    assert.equal(s.type, "scout", `${shift} 班建议出 ${s.type}，不在自启集合`);
  }
  writeFileSync(switchFile(ctx.switchesDir, "scout"), "");
  for (const shift of ["dawn", "dusk"]) {
    const s = nextOrder(ctx, { shift });
    assert.equal(s.type, null); // 绝不拿 craft/patrol 等非自启单型凑数
    assert.match(s.reason, /无可领的单/);
  }
});

test("next 优先级与班次过滤：craft(10) 先于 patrol(40) 先于 scout(60)；patrol 只归早班；额度 null 全部过滤", () => {
  const ctx = makeCtx();
  const patrol = openOrder(ctx, { type: "patrol", title: "巡一圈", shift: "dawn" });
  const craft = openOrder(ctx, { type: "craft", title: "手作", trial: "t" });
  const scout = openOrder(ctx, { type: "scout", title: "侦察", data: { topic: "z" } });
  assert.equal(nextOrder(ctx, { shift: "dawn" }).order, craft.order); // craft 优先级 10 最先
  transitionOrder(ctx, craft.order, "done", { verified: false });
  assert.equal(nextOrder(ctx, { shift: "dawn" }).order, patrol.order);
  assert.equal(nextOrder(ctx, { shift: "dusk" }).order, scout.order); // patrol 不归晚班
  transitionOrder(ctx, scout.order, "start");
  const later = nextOrder(ctx, { shift: "dusk" });
  assert.equal(later.order, null);
  assert.equal(later.type, "scout"); // 领完之后还能建议新的自启单
  assert.throws(() => nextOrder(ctx, { shift: "manual" }), /--shift dawn\/dusk/);

  const noQuota = makeCtx({ daysDir: ctx.daysDir, quotaFn: () => null }); // 额度底线：一个都不给
  const empty = nextOrder(noQuota, { shift: "dawn" });
  assert.equal(empty.order, null);
  assert.equal(empty.type, null);
  assert.match(empty.reason, /无可领的单/);
});

test("LOOP_SHIFT 钉班次身份：合法值优先于 ctx.shiftOf；不合法退回 shiftOf 推算", () => {
  const ctx = makeCtx({ shiftOf: () => "dusk" }); // 钟点推算是晚班
  process.env.LOOP_SHIFT = "dawn";
  try {
    // patrol 只归早班：按 shiftOf 的 dusk 会被拒，env 钉的 dawn 放行
    assert.equal(openOrder(ctx, { type: "patrol", title: "巡" }).phase, "todo");
    // 被拒记录行的 shift 同样用 env 班次（不传 key：撞 dedupe 键，防重复拒绝）
    assert.throws(() => openOrder(ctx, { type: "patrol", title: "再巡" }), /进行中/);
    assert.equal(rejectRows(ctx).at(-1).shift, "dawn");
    process.env.LOOP_SHIFT = "night"; // 不在 shiftIds → 退回 shiftOf 的 dusk
    const c = openOrder(ctx, { type: "craft", title: "X", trial: "t" });
    assert.equal(dayEvents(ctx).find((e) => e.order === c.order).shift, "dusk");
  } finally {
    delete process.env.LOOP_SHIFT;
  }
});

test("班次推算回退：没设 LOOP_SHIFT 用 ctx.shiftOf；连 shiftOf 都没有记 manual", () => {
  const ctx = makeCtx({ shiftOf: () => "dusk" });
  const c = openOrder(ctx, { type: "craft", title: "A", trial: "t" });
  assert.equal(dayEvents(ctx).find((e) => e.order === c.order).shift, "dusk");
  const bare = makeCtx({ shiftOf: undefined });
  const m = openOrder(bare, { type: "craft", title: "B", trial: "t" });
  assert.equal(dayEvents(bare).find((e) => e.order === m.order).shift, "manual");
});

// 既有 delivery 行形状的 fixture（同款字段结构，不抄真实账本内容）
const DELIVERY_ROW = {
  date: "2026-10-17",
  type: "delivery",
  trial: "t9",
  url: "https://crafted.example/handmade-mug/",
  title: "手作马克杯上架",
  verified: true,
  note: "详情页 200、购物车可加购",
};

test("done 且 verified 且 ledgerRow=delivery → 账本行逐字段与既有 delivery 行一致", () => {
  const ctx = makeCtx();
  const craft = openOrder(ctx, { type: "craft", trial: "t9", title: DELIVERY_ROW.title });
  transitionOrder(ctx, craft.order, "done", {
    verified: true,
    artifacts: [DELIVERY_ROW.url],
    ledger: { note: DELIVERY_ROW.note },
  });
  const lines = readFileSync(ctx.ledgerFile, "utf-8").trim().split("\n");
  assert.equal(lines.length, 1);
  const row = JSON.parse(lines[0]);
  // 逐字段：字段清单 = 既有行字段 + 自动补的 ts；每个字段值同构
  assert.deepEqual(Object.keys(row), [...Object.keys(DELIVERY_ROW), "ts"]);
  assert.deepEqual(row, { ...DELIVERY_ROW, ts: NOW.toISOString() });
  assert.equal(row.date, craft.day); // 圈日 = 开单那天
});

test("done 且 verified 且 ledgerRow=chronicle → 走通用合并（data 打底 + --ledger 补丁）；validators 拒绝则整单不动", () => {
  const ctx = makeCtx({ ledgerRows: { chronicle: (r) => (r.entry ? null : "chronicle 行缺 entry") } });
  const c = openOrder(ctx, { type: "chronicle", title: "记一笔", trial: "t", data: { entry: "晨间记事" } });
  transitionOrder(ctx, c.order, "done", { verified: true, ledger: { note: "补记" } });
  const row = JSON.parse(readFileSync(ctx.ledgerFile, "utf-8").trim().split("\n")[0]);
  assert.equal(row.type, "chronicle");
  assert.equal(row.date, c.day);
  assert.equal(row.trial, "t");
  assert.equal(row.entry, "晨间记事"); // data 里的字段打底保留
  assert.equal(row.note, "补记");
  assert.equal(row.verified, true);

  // ctx.ledgerRows 的 validator 拒绝 → done 整体拒绝，单停在做、账本不多行（item 错开判同口径）
  const bad = openOrder(ctx, { type: "chronicle", title: "坏账", key: "k2", data: { note: "x", item: "b2" } });
  transitionOrder(ctx, bad.order, "start");
  assert.throws(() => transitionOrder(ctx, bad.order, "done", { verified: true }), /写账本 chronicle 行被拒：chronicle 行缺 entry/);
  assert.equal(listOrders(ctx).find((s) => s.order === bad.order).phase, "doing");
  assert.equal(readFileSync(ctx.ledgerFile, "utf-8").trim().split("\n").length, 1);
});

test("账本已写、事件未写的半程状态：重试 done 不再写账本行，事件照常补上", () => {
  const ctx = makeCtx();
  const craft = openOrder(ctx, { type: "craft", title: "半程", trial: "t" });
  // 模拟上次 done：账本行已落、done 事件没落（进程被杀）
  addLedgerRow(ctx.ledgerFile, {
    date: craft.day, type: "delivery", trial: "t", url: "https://x.example/half", title: "半程", verified: true, note: "",
  });
  transitionOrder(ctx, craft.order, "done", { verified: true, artifacts: ["https://x.example/half"] });
  assert.equal(readFileSync(ctx.ledgerFile, "utf-8").trim().split("\n").length, 1); // 不翻倍
  assert.equal(dayEvents(ctx).filter((e) => e.event === "done").length, 1); // 事件补上了
  // 换 url 的同日交付不算重复，照常入账
  const other = openOrder(ctx, { type: "craft", title: "另交付", trial: "t2" });
  transitionOrder(ctx, other.order, "done", { verified: true, artifacts: ["https://x.example/other"] });
  assert.equal(readFileSync(ctx.ledgerFile, "utf-8").trim().split("\n").length, 2);
});

test("list：--date/--phase/--type 过滤，phase 接受 id 与中文", () => {
  const ctx = makeCtx();
  const a = openOrder(ctx, { type: "craft", title: "A", trial: "t" });
  openOrder(ctx, { type: "patrol", title: "P", shift: "dawn" });
  ctx.now = () => at("2026-10-18T04:00:00.000Z");
  const c = openOrder(ctx, { type: "craft", title: "C", trial: "t" });
  transitionOrder(ctx, c.order, "needs_you");
  assert.equal(listOrders(ctx).length, 3);
  assert.deepEqual(listOrders(ctx, { date: DAY }).map((s) => s.order).sort(), [a.order, "20261017-patrol-1"].sort());
  assert.equal(listOrders(ctx, { type: "patrol" }).length, 1);
  assert.deepEqual(listOrders(ctx, { phase: "waiting" }).map((s) => s.order), [c.order]);
  assert.deepEqual(listOrders(ctx, { phase: "等你" }).map((s) => s.order), [c.order]);
  assert.equal(listOrders(ctx, { phase: "done" }).length, 0);
});

test("并发安全：两个子进程各 append 200 个事件，最终 400 行不丢不坏", async () => {
  const dir = tempDir("orders-conc-");
  const file = join(dir, "orders.jsonl");
  const ordersMjs = new URL("../src/orders.mjs", import.meta.url).href;
  const appender = join(dir, "appender.mjs");
  writeFileSync(
    appender,
    `import { appendEvent } from ${JSON.stringify(ordersMjs)};\n` +
      "const [, , file, n, tag] = process.argv;\n" +
      'for (let i = 0; i < Number(n); i++) appendEvent(file, { order: `${tag}${i}`, event: "open", type: "craft" });\n',
  );
  const run = (tag) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [appender, file, "200", tag], { stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`子进程 ${tag} 退出码 ${code}：${stderr}`))));
    });
  await Promise.all([run("a-"), run("b-")]);
  const lines = readFileSync(file, "utf-8").split("\n").filter((line) => line.trim() !== "");
  assert.equal(lines.length, 400);
  const counts = { "a-": 0, "b-": 0 };
  for (const line of lines) {
    const event = JSON.parse(line); // 每行都是完整 JSON = 不坏
    assert.equal(event.event, "open");
    counts[event.order.slice(0, 2)] += 1;
  }
  assert.deepEqual(counts, { "a-": 200, "b-": 200 }); // 不丢不重
});

test("CLI：open→start→done 全链输出 JSON；未知单型/缺 --shift/未知命令的退出码与中文原因", async () => {
  const root = writeConfigFile(tempDir("orders-root-"));
  const deps = { root, now: () => NOW };
  const opened = await runMain(["open", "craft", "--trial", "t", "--title", "CLI 单"], deps);
  assert.equal(opened.code, undefined); // 成功不设退出码
  assert.equal(opened.body.ok, true);
  assert.equal(opened.body.phase, "todo");
  const started = await runMain(["start", opened.body.order], deps);
  assert.equal(started.body.phase, "doing");
  const done = await runMain(["done", opened.body.order, "--verified", "false"], deps);
  assert.equal(done.body.phase, "done");
  assert.equal(done.body.verified, false);

  const unknown = await runMain(["open", "nosuch", "--title", "x"], deps);
  assert.equal(unknown.code, 2);
  assert.equal(unknown.body.ok, false);
  assert.match(unknown.body.error, /未知单型/);

  const noShift = await runMain(["next"], deps);
  assert.equal(noShift.code, 2);
  assert.match(noShift.body.error, /--shift dawn\/dusk/);

  const missing = await runMain(["fail", "20991017-craft-9", "--reason", "x"], deps);
  assert.equal(missing.code, 2);
  assert.match(missing.body.error, /找不到单/);

  const badVerified = await runMain(["done", opened.body.order, "--verified", "yes"], deps);
  assert.equal(badVerified.code, 2);
  assert.match(badVerified.body.error, /--verified/);
});

test("withDayLock：无人持锁即执行并释放；新鲜锁重试到超时拒绝；死锁（含无 owner）可抢占；fn 抛错也释放", () => {
  const dir = tempDir("orders-lock-");
  const lockDir = join(dir, ".lock");
  let ran = 0;
  withDayLock(dir, () => ran++);
  assert.equal(ran, 1);
  assert.equal(existsSync(lockDir), false);

  // 新鲜锁（持锁仅 10 秒）：注入时钟与 sleep，重试 5 秒后拒绝，fn 不执行、别人的锁不替它放
  mkdirSync(lockDir);
  writeFileSync(join(lockDir, "owner"), `999 ${Date.parse("2026-10-17T00:00:00Z")}`);
  let clock = Date.parse("2026-10-17T00:00:10Z");
  assert.throws(
    () => withDayLock(dir, () => ran++, { now: () => clock, sleep: () => (clock += LOCK_RETRY_MS) }),
    /单记录正忙/,
  );
  assert.equal(ran, 1);
  assert.equal(existsSync(lockDir), true);

  // 持锁 61 秒 → 死锁抢占
  writeFileSync(join(lockDir, "owner"), `999 ${Date.parse("2026-10-17T00:00:00Z")}`);
  withDayLock(dir, () => ran++, { now: () => Date.parse("2026-10-17T00:01:01Z"), sleep: () => {} });
  assert.equal(ran, 2);
  assert.equal(existsSync(lockDir), false);

  // owner 缺失（抢锁后死在写 owner 前）→ 按锁目录 mtime 判死锁
  mkdirSync(lockDir);
  utimesSync(lockDir, new Date(Date.parse("2026-10-17T00:00:00Z")), new Date(Date.parse("2026-10-17T00:00:00Z")));
  withDayLock(dir, () => ran++, { now: () => Date.parse("2026-10-17T00:01:01Z"), sleep: () => {} });
  assert.equal(ran, 3);

  // fn 抛错也释放，不留死锁
  assert.throws(() => withDayLock(dir, () => { throw new Error("boom"); }), /boom/);
  assert.equal(existsSync(lockDir), false);
});

// 并发竞态子进程：循环尝试 open 同 key 或 done 同一单，回报成功数与拒绝原因清单。
function writeRacer(dir) {
  const fixture = join(dir, "racer.mjs");
  writeFileSync(
    fixture,
    `import { openOrder, transitionOrder } from ${JSON.stringify(new URL("../src/orders.mjs", import.meta.url).href)};\n` +
      `import { makeRegistry } from ${JSON.stringify(new URL("./helpers.mjs", import.meta.url).href)};\n` +
      'const [, , mode, daysDir, switchesDir, ledgerFile, n] = process.argv;\n' +
      'const ctx = { daysDir, switchesDir, ledgerFile, registry: makeRegistry(), ledgerRows: {}, now: () => new Date(Date.parse("2026-10-17T04:00:00.000Z")), quotaFn: () => "ok" };\n' +
      "let ok = 0; const rejects = [];\n" +
      "for (let i = 0; i < Number(n); i++) {\n" +
      "  try {\n" +
      '    if (mode === "open") openOrder(ctx, { type: "craft", title: "抢", trial: "t", key: "race" });\n' +
      '    else transitionOrder(ctx, process.env.RACE_ORDER, "done", { verified: true, artifacts: ["https://x.example/race"] });\n' +
      "    ok += 1;\n" +
      "  } catch (error) { rejects.push(String(error.message)); }\n" +
      "}\n" +
      "process.stdout.write(JSON.stringify({ ok, rejects }));\n",
  );
  return (mode, ctx, n, env = {}) =>
    Promise.all(
      [0, 1].map(
        (k) =>
          new Promise((resolve, reject) => {
            const child = spawn(process.execPath, [fixture, mode, ctx.daysDir, ctx.switchesDir, ctx.ledgerFile, String(n)], {
              env: { ...process.env, ...env, RACE_ORDER: env.RACE_ORDER ?? "" },
              stdio: ["ignore", "pipe", "pipe"],
            });
            let out = "";
            let err = "";
            child.stdout.on("data", (chunk) => (out += chunk));
            child.stderr.on("data", (chunk) => (err += chunk));
            child.on("close", (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`子进程 ${k} 退出码 ${code}：${err}`))));
          }),
      ),
    );
}

const dayEvents = (ctx, day = DAY) =>
  readFileSync(join(ctx.daysDir, day, "orders.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));

const rejectRows = (ctx, day = DAY) =>
  existsSync(join(ctx.daysDir, day, "rejects.jsonl"))
    ? readFileSync(join(ctx.daysDir, day, "rejects.jsonl"), "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line))
    : [];

test("开单竞态：两个子进程各对同一 key 同时 open 50 次 → 恰 1 张成单、其余全拒、单号不重复", async () => {
  const ctx = makeCtx();
  const race = writeRacer(tempDir("orders-race-"));
  const [a, b] = await race("open", ctx, 50);
  assert.equal(a.ok + b.ok, 1); // 同 key 只有 1 张开成功
  assert.equal(a.rejects.length + b.rejects.length, 99); // 其余全部拒绝
  const opens = dayEvents(ctx).filter((e) => e.event === "open");
  assert.equal(opens.length, 1);
  assert.equal(new Set(opens.map((e) => e.order)).size, 1); // 单号唯一
});

test("迁移竞态：两个子进程同时 done 同一单 → 账本只多 1 行、事件只有 1 个 done", async () => {
  const ctx = makeCtx();
  const craft = openOrder(ctx, { type: "craft", title: "T", trial: "t" });
  transitionOrder(ctx, craft.order, "start");
  const race = writeRacer(tempDir("orders-race-"));
  const [a, b] = await race("done", ctx, 50, { RACE_ORDER: craft.order });
  assert.equal(a.ok + b.ok, 1); // 只有一次 done 成立
  assert.equal(dayEvents(ctx).filter((e) => e.event === "done").length, 1);
  const rows = readFileSync(ctx.ledgerFile, "utf-8").trim().split("\n");
  assert.equal(rows.length, 1); // delivery 行没有翻倍
  assert.equal(JSON.parse(rows[0]).url, "https://x.example/race");
});

test("被拒开单落当天 rejects.jsonl：{ts,shift,type,key?,title?,reason}，reason 用 Reject 原文；成功开单不落", () => {
  const ctx = makeCtx();
  openOrder(ctx, { type: "patrol", title: "巡一圈", key: "i1" });
  const craft = openOrder(ctx, { type: "craft", title: "A", trial: "t", key: "K1" });
  assert.equal(rejectRows(ctx).length, 0, "成功开单不落被拒记录");
  transitionOrder(ctx, craft.order, "done", { verified: true, artifacts: ["https://x.example/a"] });
  assert.throws(() => openOrder(ctx, { type: "craft", title: "A2", trial: "t", key: "K1" }), /防重复/);
  assert.throws(() => openOrder(ctx, { type: "patrol", title: "再巡", key: "i2" }), /每日上限 1/);
  writeFileSync(switchFile(ctx.switchesDir, "scout"), "");
  assert.throws(() => openOrder(ctx, { type: "scout", title: "侦察 x", data: { topic: "z" } }), /开关关闭/); // 开关在算 key 之前 → 行里无 key
  assert.throws(() => openOrder(ctx, { type: "nosuch", title: "谜单" }), /未知单型/);
  const rows = rejectRows(ctx);
  assert.equal(rows.length, 4);
  assert.deepEqual(
    rows.map((r) => ({ shift: r.shift, type: r.type, key: r.key, title: r.title })),
    [
      { shift: "dawn", type: "craft", key: "K1", title: "A2" },
      { shift: "dawn", type: "patrol", key: "i2", title: "再巡" },
      { shift: "dawn", type: "scout", key: undefined, title: "侦察 x" },
      { shift: "dawn", type: "nosuch", key: undefined, title: "谜单" },
    ],
  );
  for (const r of rows) {
    assert.equal(r.ts, NOW.toISOString());
    assert.ok(r.reason.length > 0);
  }
  assert.match(rows[0].reason, /防重复/);
  assert.match(rows[1].reason, /每日上限 1/);
  assert.match(rows[2].reason, /开关关闭/);
  assert.match(rows[3].reason, /未知单型/);
});

test("CLI open 被拒：退出码 2 与 JSON 输出不变，rejects.jsonl 照落", async () => {
  const ctx = makeCtx();
  const root = writeConfigFile(tempDir("orders-root-"));
  const deps = { root, daysDir: ctx.daysDir, switchesDir: ctx.switchesDir, ledgerFile: ctx.ledgerFile, now: () => NOW, shiftOf: () => "dawn" };
  const ok = await runMain(["open", "craft", "--title", "首单", "--key", "K9", "--trial", "t"], deps);
  assert.equal(ok.code, undefined);
  assert.equal(rejectRows(ctx).length, 0);
  const dup = await runMain(["open", "craft", "--title", "再开", "--key", "K9", "--trial", "t"], deps);
  assert.equal(dup.code, 2);
  assert.equal(dup.body.ok, false);
  assert.match(dup.body.error, /防重复/);
  const rows = rejectRows(ctx);
  assert.equal(rows.length, 1);
  assert.deepEqual({ type: rows[0].type, key: rows[0].key, shift: rows[0].shift, title: rows[0].title }, {
    type: "craft",
    key: "K9",
    shift: "dawn",
    title: "再开",
  });
});

test("rejects.jsonl 写不了（被占成目录）不掩盖原拒绝：单照拒、锁照放", () => {
  const ctx = makeCtx();
  mkdirSync(join(ctx.daysDir, DAY, "rejects.jsonl"), { recursive: true });
  assert.throws(() => openOrder(ctx, { type: "nosuch", title: "x" }), /未知单型/);
  assert.equal(existsSync(join(ctx.daysDir, ".lock")), false);
});
