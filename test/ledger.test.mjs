// ledger.mjs：追加校验（date/type、question 行 options/recommend、validators 注入）、
// 读侧纯函数（待拍题/生效拍板/最近行/空转）、并发与锁、CLI。全部临时账本 + 注入时间。
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  addLedgerRow,
  effectiveDecisions,
  emptyStreak,
  main,
  pendingQuestions,
  questionTime,
  recentRows,
} from "../src/ledger.mjs";

const tempDirs = [];
function tempFile(name = "ledger.jsonl") {
  const dir = mkdtempSync(join(tmpdir(), "loop-kernel-ledger-"));
  tempDirs.push(dir);
  return join(dir, name);
}
afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop(), { recursive: true, force: true });
});

const NOW = new Date("2026-10-15T04:00:00Z"); // 北京 10-15 正午，圈日落在 10-15
const LEDGER_MJS = fileURLToPath(new URL("../src/ledger.mjs", import.meta.url)); // 子进程 import 用
const d = (offset) => {
  const dt = new Date(2026, 9, 15 + offset);
  const pad = (n) => String(n).padStart(2, "0");
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
};

test("addLedgerRow：合法行追加一行 JSON；缺 date/type 报错", () => {
  const file = tempFile();
  const row = addLedgerRow(file, {
    date: "2026-10-15",
    type: "delivery",
    trial: "t1",
    url: "https://crafted.example/a/",
    title: "A",
    verified: true,
  });
  assert.equal(row.type, "delivery");
  const lines = readFileSync(file, "utf-8").trim().split("\n");
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]).title, "A");

  assert.throws(() => addLedgerRow(file, { type: "delivery" }), /date/);
  assert.throws(() => addLedgerRow(file, { date: "2026-10-15" }), /type/);
  assert.throws(() => addLedgerRow(file, { date: "20261015", type: "delivery" }), /date/);
  assert.throws(() => addLedgerRow(file, "不是对象"), /对象/);
});

test("recentRows：最近 N 天含今天，未来行不计，可按 type 过滤，date 升序", () => {
  const file = tempFile();
  const rows = [
    { date: d(-9), type: "daily" },
    { date: d(-7), type: "delivery" },
    { date: d(-1), type: "delivery" },
    { date: d(0), type: "daily" },
    { date: d(0), type: "delivery" },
    { date: d(1), type: "delivery" }, // 未来行
  ];
  for (const row of rows) addLedgerRow(file, row);

  assert.deepEqual(recentRows(file, { days: 7, now: NOW }).map((r) => `${r.date}:${r.type}`), [
    `${d(-1)}:delivery`,
    `${d(0)}:daily`,
    `${d(0)}:delivery`,
  ]);
  assert.deepEqual(recentRows(file, { days: 7, type: "delivery", now: NOW }).map((r) => r.date), [d(-1), d(0)]);
  assert.deepEqual(recentRows(file, { days: 1, now: NOW }).map((r) => r.type), ["daily", "delivery"]);
});

test("emptyStreak：当天有交付记 0；无交付往前数到最近 delivery；无循环行记 0；decision 行当下界", () => {
  assert.equal(emptyStreak([{ type: "delivery", date: d(0) }], d(0)), 0);
  assert.equal(emptyStreak([{ type: "delivery", date: d(-2) }], d(0)), 2);
  // 没有任何循环行（只有别的行类型）→ 0，不用历史背锅
  assert.equal(emptyStreak([{ type: "daily", date: d(-30) }, { type: "clicks", date: d(-1) }], d(0)), 0);
  // 只有 decision 行（D-3）→ 下界 D-3，D-3..今天共 4 天空转
  assert.equal(emptyStreak([{ type: "decision", date: d(-3) }], d(0)), 4);
  // delivery 也是循环行，会把下界拉到它自己——数到它为止
  assert.equal(emptyStreak([{ type: "decision", date: d(-3) }, { type: "delivery", date: d(-9) }], d(0)), 9);
  // 循环行日期晚于目标日（回看历史日期）→ 0
  assert.equal(emptyStreak([{ type: "decision", date: d(1) }], d(0)), 0);
});

test("emptyStreak：loopRowTypes 注入——循环用自家的行类型当空转下界", () => {
  const rows = [{ type: "note", date: d(-2) }, { type: "daily", date: d(-9) }];
  // note 在清单里 → 下界 D-2，D-2..今天共 3 天空转（daily 不在清单不算）
  assert.equal(emptyStreak(rows, d(0), { loopRowTypes: ["delivery", "note"] }), 3);
  // 缺省清单不认 note：没有任何 delivery/decision 行 → 0
  assert.equal(emptyStreak(rows, d(0)), 0);
});

test("addLedgerRow：行内没有 ts 自动补注入 now 的 ISO 时间；已有 ts 不覆盖", () => {
  const file = tempFile();
  const first = addLedgerRow(file, { date: "2026-10-15", type: "delivery", trial: "t" }, { now: NOW });
  assert.equal(first.ts, NOW.toISOString());
  const kept = "2026-10-15T08:00:00.000Z";
  const second = addLedgerRow(file, { date: "2026-10-15", type: "delivery", trial: "t", ts: kept }, { now: NOW });
  assert.equal(second.ts, kept);
  const lines = readFileSync(file, "utf-8").trim().split("\n");
  assert.equal(JSON.parse(lines[0]).ts, NOW.toISOString());
  assert.equal(JSON.parse(lines[1]).ts, kept);
});

test("addLedgerRow：question 行 options 必须是非空字符串数组，recommend 若给须是其中一项；不给 recommend 合法（= 永不默认）；旧格式不带 options 照常", () => {
  const file = tempFile();
  const base = { date: "2026-10-15", type: "question", id: "F1", category: "普通", text: "题面" };
  assert.throws(() => addLedgerRow(file, { ...base, options: "选项1" }), /options/);
  assert.throws(() => addLedgerRow(file, { ...base, options: [] }), /options/);
  assert.throws(() => addLedgerRow(file, { ...base, options: ["选项1", 2] }), /options/);
  assert.throws(() => addLedgerRow(file, { ...base, recommend: "选项1", options: ["选项2", "选项3"] }), /recommend/);
  addLedgerRow(file, { ...base, options: ["选项1", "选项2"] }, { now: NOW }); // 不给 recommend 合法
  addLedgerRow(file, { ...base, id: "F2", recommend: "选项1", options: ["选项1", "选项2"] }, { now: NOW });
  addLedgerRow(file, { ...base, id: "F3", recommend: "过" }, { now: NOW }); // 旧格式无 options 照常
  const lines = readFileSync(file, "utf-8").trim().split("\n");
  assert.equal(lines.length, 3);
  assert.equal(JSON.parse(lines[0]).recommend, undefined);
});

test("addLedgerRow：validators 注入——validators[row.type] 返回非空字符串则拒绝，null 照常入账", () => {
  const file = tempFile();
  const validators = { delivery: (r) => (r.url ? null : "delivery 行缺 url") };
  assert.throws(
    () => addLedgerRow(file, { date: "2026-10-15", type: "delivery", trial: "t" }, { now: NOW, validators }),
    /delivery 行缺 url/,
  );
  addLedgerRow(file, { date: "2026-10-15", type: "delivery", trial: "t", url: "https://x.example/a/" }, { now: NOW, validators });
  addLedgerRow(file, { date: "2026-10-15", type: "note", body: "x" }, { now: NOW, validators }); // 没登记 validator 的类型照常
  assert.equal(readFileSync(file, "utf-8").trim().split("\n").length, 2);
});

test("pendingQuestions：没拍的题附 deadline（入账+48h）与 irreversible；已拍的（含改判）不列", () => {
  const rows = [
    // 普通题无 ts：deadline = date 当地 05:00 + 48h
    { type: "question", id: "F1", date: d(-2), category: "普通", recommend: "过", options: ["过", "否"] },
    // 判死题带 ts：deadline = ts + 48h
    { type: "question", id: "F2", date: d(-2), ts: "2026-10-13T06:00:00.000Z", category: "判死", recommend: "判死" },
    { type: "question", id: "F3", date: d(-2), category: "对外不可逆", recommend: "提审" },
    // 已拍（改判行靠后生效）→ 不列
    { type: "question", id: "F4", date: d(-2), category: "普通", recommend: "过" },
    { type: "decision", date: d(-1), question: "F4", choice: "过", source: "default" },
    { type: "decision", date: d(0), question: "F4", choice: "否", source: "workbench", supersedes: d(-1) },
  ];
  const pending = pendingQuestions(rows, { neverDefaultCategories: ["判死", "对外不可逆"] });
  assert.deepEqual(pending.map((r) => r.id), ["F1", "F2", "F3"]);
  const [f1, f2, f3] = pending;
  // 无 ts 按 date 当地 05:00 起算 + 48h；期望值用相对推导，不耦合墙钟
  assert.equal(f1.deadline, new Date(2026, 9, 15, 5, 0, 0).toISOString());
  assert.equal(f2.deadline, "2026-10-15T06:00:00.000Z");
  assert.deepEqual([f1.irreversible, f2.irreversible, f3.irreversible], [false, true, true]);
  // 原行字段原样保留
  assert.deepEqual(f1.options, ["过", "否"]);
  assert.equal(f1.recommend, "过");
});

test("neverDefaultCategories 注入：名单里的 category 才 irreversible；缺省名单谁都不标（无 recommend 仍 neverDefault）", () => {
  const rows = [
    { type: "question", id: "Q1", date: d(-2), category: "花钱", recommend: "花" },
    { type: "question", id: "Q2", date: d(-2), category: "判死", recommend: "停" },
    { type: "question", id: "Q3", date: d(-2), category: "花钱" }, // 无 recommend
  ];
  const marked = new Map(pendingQuestions(rows, { neverDefaultCategories: ["花钱"] }).map((q) => [q.id, q]));
  assert.equal(marked.get("Q1").irreversible, true);
  assert.equal(marked.get("Q1").neverDefault, true);
  assert.equal(marked.get("Q2").irreversible, false); // 不在名单：内核不认识任何 category
  assert.equal(marked.get("Q3").neverDefault, true); // 无 recommend 永不默认，与名单无关
  const bare = new Map(pendingQuestions(rows).map((q) => [q.id, q]));
  assert.equal(bare.get("Q1").irreversible, false); // 缺省名单 = 全放行
});

test("questionTime：有 ts 用 ts；没有 ts（旧行）按 date 当地 05:00", () => {
  const withTs = questionTime({ date: "2026-10-10", ts: "2026-10-10T22:30:00.000Z" });
  assert.equal(withTs.toISOString(), "2026-10-10T22:30:00.000Z");
  const noTs = questionTime({ date: "2026-10-10" });
  assert.deepEqual(noTs, new Date(2026, 9, 10, 5, 0, 0));
});

test("effectiveDecisions：同题号多行 decision 以账本靠后为准；supersedes 只作记录不参与判断", () => {
  const rows = [
    { type: "decision", date: d(-1), question: "F1", choice: "过", source: "reply" },
    {
      type: "decision",
      date: d(0),
      question: "F1",
      choice: "停",
      source: "workbench",
      supersedes: "2026-10-15T00:00:00.000Z",
    },
    { type: "delivery", date: d(0) }, // 非 decision 行不进结果
    { type: "decision", date: d(0) }, // 缺题号的 decision 跳过
  ];
  const effective = effectiveDecisions(rows);
  assert.equal(effective.size, 1);
  assert.equal(effective.get("F1").choice, "停");
  assert.equal(effective.get("F1").source, "workbench");
});

test("addLedgerRow：两进程并发追加都在、行不交叉损坏；锁目录用完被删除", async () => {
  const file = tempFile();
  // 子进程脚本：各写 25 行（url 带进程标签）；不锁时并发 append 的小写入可能交叉产生坏行
  const script = (tag) => `import { addLedgerRow } from ${JSON.stringify(LEDGER_MJS)};
for (let i = 0; i < 25; i++) addLedgerRow(${JSON.stringify(file)}, { date: "2026-10-15", type: "delivery", trial: "${tag}", url: "https://x/${tag}-" + i, verified: true });`;
  const run = (tag) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script(tag)], { stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    child.stderr.on("data", (c) => { err += c; });
    return new Promise((resolve) => child.on("close", (code) => resolve({ code, err })));
  };
  const results = await Promise.all([run("a"), run("b")]);
  assert.deepEqual(results.map((r) => r.code), [0, 0], results.map((r) => r.err).join("\n"));
  const lines = readFileSync(file, "utf-8").split("\n").filter((line) => line.trim());
  assert.equal(lines.length, 50);
  const urls = new Set(lines.map((line) => JSON.parse(line).url)); // 有一行写坏这里就炸 = 锁没锁住
  assert.equal(urls.size, 50);
  assert.equal(existsSync(`${file}.lock`), false);
});

test("addLedgerRow：残留的过期锁（账本旁 <file>.lock）会被抢占，写入不卡死", () => {
  const file = tempFile();
  // 手工埋一个死锁：owner 时间戳远旧于 LOCK_STALE_MS
  mkdirSync(`${file}.lock`);
  writeFileSync(join(`${file}.lock`, "owner"), `999 ${Date.now() - 120000}\n`);
  addLedgerRow(file, { date: "2026-10-15", type: "delivery", trial: "t", url: "https://x/t", verified: true }, { now: NOW });
  assert.equal(readFileSync(file, "utf-8").trim().split("\n").length, 1);
  assert.equal(existsSync(`${file}.lock`), false);
});

test("addLedgerRow：行校验失败不抢锁不留锁（校验在锁外先跑）", () => {
  const file = tempFile();
  assert.throws(() => addLedgerRow(file, { type: "delivery" }), /date/);
  assert.equal(existsSync(`${file}.lock`), false);
});

test("CLI pending：打印待拍题 JSON（没拍的原样列出、已拍的不列），只读不写账", async () => {
  const file = tempFile();
  addLedgerRow(file, { date: d(0), type: "question", id: "F1", category: "普通", recommend: "过", options: ["过", "否"] }, { now: NOW });
  addLedgerRow(file, { date: d(0), type: "question", id: "F2", category: "判死", recommend: "判死", options: ["判死", "再观察"] }, { now: NOW });
  addLedgerRow(file, { date: d(0), type: "decision", question: "F2", choice: "再观察", source: "workbench" }, { now: NOW });

  const chunks = [];
  const origWrite = process.stdout.write;
  process.stdout.write = (chunk) => {
    chunks.push(chunk);
    return true;
  };
  let pending;
  try {
    await main(["pending"], { ledgerFile: file });
    pending = JSON.parse(chunks.join(""));
  } finally {
    process.stdout.write = origWrite;
  }
  assert.deepEqual(pending.map((r) => r.id), ["F1"]);
  assert.equal(pending[0].irreversible, false); // 不传 config：谁都不标不可逆
  assert.equal(readFileSync(file, "utf-8").trim().split("\n").length, 3); // 只读
});

test("CLI 读循环配置：pending 认 neverDefaultCategories，add 走 ledgerRows 校验", async () => {
  const root = mkdtempSync(join(tmpdir(), "loop-kernel-ledger-cli-"));
  tempDirs.push(root);
  mkdirSync(join(root, "loop"));
  writeFileSync(
    join(root, "loop.config.mjs"),
    `export default {
      loopHome: ${JSON.stringify(join(root, "home"))},
      launchdPrefix: "com.example.testloop",
      shifts: { plan: { name: "规划班", timeLimitMin: 120, alwaysRun: true } },
      orderTypes: [],
      neverDefaultCategories: ["判死"],
      ledgerRows: { question: (row) => (row.text ? null : "question 行缺 text") },
      prompt: () => "干活",
      executor: { run: async () => ({}) },
    };\n`,
  );
  const ledgerFile = join(root, "loop", "ledger.jsonl");
  writeFileSync(
    ledgerFile,
    `${JSON.stringify({
      date: "2026-10-15",
      type: "question",
      id: "D1",
      category: "判死",
      recommend: "判死",
      options: ["判死", "再观察"],
      text: "要不要判死",
    })}\n`,
  );
  // cwd 不是 root：launchd 的 WorkingDirectory 是 home，得靠 LOOP_CWD 找到配置
  const env = { ...process.env, LOOP_CWD: root };
  const run = (args) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [LEDGER_MJS, ...args], {
        cwd: tmpdir(),
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c) => {
        stdout += c;
      });
      child.stderr.on("data", (c) => {
        stderr += c;
      });
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });

  const pending = await run(["pending"]);
  assert.equal(pending.code, 0, pending.stderr);
  const rows = JSON.parse(pending.stdout);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].neverDefault, true);
  assert.equal(rows[0].irreversible, true);

  const before = readFileSync(ledgerFile, "utf-8");
  const rejected = await run([
    "add",
    JSON.stringify({ date: "2026-10-15", type: "question", id: "D2", category: "普通", options: ["过", "否"] }),
  ]);
  assert.equal(rejected.code, 1);
  assert.match(rejected.stderr, /question 行缺 text/);
  assert.equal(readFileSync(ledgerFile, "utf-8"), before);
});
