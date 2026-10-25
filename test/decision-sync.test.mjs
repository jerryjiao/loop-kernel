// decision-sync.mjs：账本拍板 ↔ 拍板单同步——未拍题开单推「等你」、生效 decision 行收尾
// （done / default 关单）、窗内补登记、幂等、开关不约束拍板单、CLI（含 --dry-run）。
// 全部临时目录 + 注入时间；注册表用 helpers 的小注册表（含内置拍板单型）。
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { makeCtx as kernelMakeCtx, switchFile } from "../src/orders.mjs";
import { loadLedger } from "../src/ledger.mjs";
import { main as dsyncMain, scanTodoOrders, syncDecisions } from "../src/decision-sync.mjs";
import { testConfig, writeConfigFile } from "./helpers.mjs";

const tempDirs = [];
const tempDir = (prefix = "dsync-") => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
};
afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop(), { recursive: true, force: true });
});

// 北京 2026-10-16 正午；窗口 = [10-10, 10-16]
const NOW = new Date("2026-10-16T04:00:00.000Z");
const TODAY = "2026-10-16";

const QUESTION = {
  date: "2026-10-15",
  type: "question",
  id: "F20261015-1",
  trial: "t1",
  category: "普通",
  recommend: "过",
  options: ["过", "否"],
  text: "标题用 A 还是 B",
  ts: "2026-10-15T06:00:00.000Z",
};

function makeCtx(over = {}) {
  return kernelMakeCtx(testConfig(), {
    daysDir: tempDir("dsync-days-"),
    switchesDir: tempDir("dsync-sw-"),
    ledgerFile: join(tempDir("dsync-ledger-"), "ledger.jsonl"),
    now: () => NOW,
    ...over,
  });
}

const byKey = (ctx) => scanTodoOrders(ctx.daysDir).byKey;
const phaseOf = (ctx, key) => byKey(ctx).get(key)?.phase;

test("未拍题首次同步：开拍板单推「等你」，shift/by 记 manual/shift；再跑零事件", () => {
  const ctx = makeCtx();
  const r1 = syncDecisions({ rows: [QUESTION], now: NOW, ctx });
  assert.deepEqual(r1.ops.map((o) => o.event), ["open", "needs_you"]);
  assert.equal(r1.skipped, 0);
  const s = byKey(ctx).get("decision:F20261015-1");
  assert.equal(s.phase, "waiting");
  assert.equal(s.day, TODAY);
  assert.equal(`${s.shift}/${s.by}`, "manual/shift"); // 人工关卡单不按开单时刻推算班次
  assert.equal(s.data.question, "F20261015-1");
  assert.equal(s.title, QUESTION.text);
  // 幂等：连跑两次第二次零事件，清单不变
  assert.equal(syncDecisions({ rows: [QUESTION], now: NOW, ctx }).ops.length, 0);
});

test("源已办推进：生效 decision 行 → done(verified)；再跑零事件", () => {
  const ctx = makeCtx();
  syncDecisions({ rows: [QUESTION], now: NOW, ctx });
  const decided = [
    QUESTION,
    { date: TODAY, type: "decision", question: "F20261015-1", choice: "过", source: "workbench", ts: "2026-10-16T08:00:00.000Z" },
  ];
  const r2 = syncDecisions({ rows: decided, now: NOW, ctx });
  assert.deepEqual(r2.ops.map((o) => o.event), ["done"]);
  assert.equal(phaseOf(ctx, "decision:F20261015-1"), "done");
  assert.equal(syncDecisions({ rows: decided, now: NOW, ctx }).ops.length, 0);
});

test("默认拍掉 → close「按推荐默认」；再跑零事件", () => {
  const ctx = makeCtx();
  const rows = [QUESTION, { date: TODAY, type: "decision", question: "F20261015-1", choice: "过", source: "default" }];
  syncDecisions({ rows, now: NOW, ctx });
  const s = byKey(ctx).get("decision:F20261015-1");
  assert.equal(s.phase, "closed");
  assert.match(s.reason, /按推荐默认/);
  assert.equal(syncDecisions({ rows, now: NOW, ctx }).ops.length, 0);
});

test("窗内补登记：已拍但没单的题补开并直接收尾；窗外不补", () => {
  const ctx = makeCtx();
  const rows = [{ date: "2026-10-14", type: "decision", question: "F-GHOST", choice: "过", source: "reply", ts: "2026-10-14T08:00:00.000Z" }];
  const r = syncDecisions({ rows, now: NOW, ctx });
  assert.deepEqual(r.ops.map((o) => o.event), ["open", "done"]);
  assert.equal(phaseOf(ctx, "decision:F-GHOST"), "done");
  assert.equal(byKey(ctx).get("decision:F-GHOST").title, "F-GHOST"); // 账本里没有题面，title 用题号
  assert.equal(syncDecisions({ rows, now: NOW, ctx }).ops.length, 0);

  // 窗外（8 天前）已拍的题：不补登记
  const stale = [{ date: "2026-10-08", type: "decision", question: "F-OLD", choice: "过", source: "reply" }];
  assert.equal(syncDecisions({ rows: stale, now: NOW, ctx: makeCtx() }).ops.length, 0);
});

test("neverDefaultCategories 的题永不到期：sync 只开单，72 小时后仍在等你", () => {
  const ctx = makeCtx();
  const killer = { ...QUESTION, id: "K1", category: "花钱", text: "买不买" };
  syncDecisions({ rows: [killer], now: NOW, ctx, neverDefaultCategories: ["花钱"] });
  const later = new Date("2026-10-19T04:00:00.000Z"); // 72h 后
  assert.equal(syncDecisions({ rows: [killer], now: later, ctx, neverDefaultCategories: ["花钱"] }).ops.length, 0);
  assert.equal(phaseOf(ctx, "decision:K1"), "waiting");
});

test("拍板单不受开关约束：decision.off 存在仍照常开单", () => {
  const ctx = makeCtx();
  writeFileSync(switchFile(ctx.switchesDir, "decision"), "");
  syncDecisions({ rows: [QUESTION], now: NOW, ctx });
  assert.equal(phaseOf(ctx, "decision:F20261015-1"), "waiting");
});

test("syncDecisions 必须传 ctx（不允许静默写真实 days）", () => {
  assert.throws(() => syncDecisions({ rows: [QUESTION], now: NOW }), /必须传 ctx/);
});

test("CLI：读配置与账本跑一次能同步出单、二次幂等；--dry-run 真实 days 不落盘；未知参数退出码 1", async () => {
  const root = writeConfigFile(tempDir("dsync-root-"));
  const ledgerFile = join(root, "loop", "ledger.jsonl");
  mkdirSync(join(root, "loop"), { recursive: true });
  writeFileSync(ledgerFile, `${JSON.stringify(QUESTION)}\n`);
  const daysDir = join(root, "loop", "days");

  const stdout = process.stdout.write.bind(process.stdout);
  let out = "";
  process.stdout.write = (s) => ((out += s), true);
  try {
    assert.equal(await dsyncMain([], { root, now: () => NOW }), 0);
    const body = JSON.parse(out);
    assert.equal(body.ok, true);
    assert.deepEqual(body.ops.map((o) => o.event), ["open", "needs_you"]);
    assert.ok(existsSync(join(daysDir, TODAY, "orders.jsonl")));

    out = "";
    assert.equal(await dsyncMain([], { root, now: () => NOW }), 0);
    assert.equal(JSON.parse(out).ops.length, 0); // 幂等

    // dry-run：days 拷进临时副本跑，真实 days 一个字节不动（这里先删掉，跑完必须仍不存在）
    rmSync(daysDir, { recursive: true, force: true });
    out = "";
    assert.equal(await dsyncMain(["--dry-run"], { root, now: () => NOW }), 0);
    const dry = JSON.parse(out);
    assert.equal(dry.dryRun, true);
    assert.deepEqual(dry.ops.map((o) => o.event), ["open", "needs_you"]); // 空副本重放出同样的开单
    assert.equal(existsSync(daysDir), false, "dry-run 不许写真实 days");

    assert.equal(await dsyncMain(["--bogus"], { root, now: () => NOW }), 1);
  } finally {
    process.stdout.write = stdout;
  }
  // 账本只读：CLI 跑完不添行
  assert.equal(loadLedger(ledgerFile).length, 1);
});
