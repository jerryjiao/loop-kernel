// launchd.mjs 的测试：launchctl 全注入假实现，不真调、不写真实 ~/Library（plist/日志都落临时目录）。
// 配置与登记表都在临时循环根里现造，on/off/status 从 deps.root 读。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";

import { agentsFor, loopOff, loopOn, loopStatus, main, nextFire, renderPlist } from "../src/launchd.mjs";
import { loadConfig } from "../src/config.mjs";
import { loadTasks } from "../src/scheduled-tasks.mjs";

const HELPERS_URL = JSON.stringify(new URL("./helpers.mjs", import.meta.url).href);
// 内核班入口的默认路径：本文件在 test/ 下，脚本在 ../src/shift.mjs
const SHIFT_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "shift.mjs");

const tempDirs = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "kern-launchd-"));
  tempDirs.push(dir);
  return dir;
};
afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop(), { recursive: true, force: true });
});

/** 临时循环根：loop.config.mjs + 登记表（两张任务）。extraLines 拼进配置（如 extraPath）。 */
function makeRoot(extraLines = "") {
  const root = tempDir();
  const loopHome = tempDir();
  mkdirSync(join(root, "loop"), { recursive: true });
  writeFileSync(
    join(root, "loop", "scheduled-tasks.json"),
    JSON.stringify({
      tasks: [
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
      ],
    }),
  );
  writeFileSync(
    join(root, "loop.config.mjs"),
    `import { ORDER_TYPES } from ${HELPERS_URL};\n` +
      "export default {\n" +
      `  loopHome: ${JSON.stringify(loopHome)},\n` +
      '  launchdPrefix: "com.example.kern-test",\n' +
      extraLines +
      "  shifts: {\n" +
      '    dawn: { name: "早班", alwaysRun: true, timeLimitMin: 120 },\n' +
      '    dusk: { name: "晚班", alwaysRun: false, timeLimitMin: 90 },\n' +
      '    weekly: { name: "周班", alwaysRun: true, timeLimitMin: 30 },\n' +
      "  },\n" +
      "  orderTypes: ORDER_TYPES,\n" +
      '  prompt: () => "干活",\n' +
      "  executor: { run: async () => ({}) },\n" +
      "};\n",
  );
  return { root, loopHome };
}

/** 假 spawn：记录每次调用，默认全成功；script 可按内容给不同结果。 */
function fakeSpawn(calls, script = () => ({ code: 0, stdout: "", stderr: "" })) {
  return async (opts) => {
    calls.push(opts);
    return script(opts);
  };
}

function makeDeps(overrides = {}) {
  const { root, loopHome } = makeRoot();
  const calls = [];
  const deps = {
    root,
    home: tempDir(),
    nodePath: "/fake/node",
    launchctlPath: "/fake/launchctl",
    uid: 501,
    spawnFn: fakeSpawn(calls),
    now: new Date(2026, 9, 17, 10, 0, 0),
    logFn: () => {},
    ...overrides,
  };
  const plistPath = (label) => join(deps.home, "Library", "LaunchAgents", `${label}.plist`);
  return { calls, deps, root, loopHome, plistPath };
}

test("agentsFor：一个任务一个 agent，label 用配置前缀，calendar 仍是 24 条 Minute=0", async () => {
  const { root } = makeRoot();
  const config = await loadConfig(root);
  const agents = agentsFor(config, loadTasks(root));
  assert.deepEqual(
    agents.map((a) => [a.id, a.label, a.args]),
    [
      ["main", "com.example.kern-test.task.main", ["--task", "main"]],
      ["weekly", "com.example.kern-test.task.weekly", ["--task", "weekly"]],
    ],
  );
  for (const a of agents) assert.deepEqual(a.calendar, Array.from({ length: 24 }, () => ({ Minute: 0 })));
});

test("renderPlist：node 绝对路径 + 参数数组 + 日志 + 环境变量；每小时 24 条 Minute=0；没有 RunAtLoad（装上不许立刻跑）", () => {
  const xml = renderPlist({
    label: "com.example.kern-test.task.main",
    nodePath: "/fake/node",
    scriptPath: SHIFT_SCRIPT,
    args: ["--task", "main"],
    logFile: "/fake/home/loop-home/logs/task-main.log",
    env: { PATH: "/fake/bin:/usr/bin", LOOP_CWD: "/fake/root" },
    home: "/fake/home",
  });
  assert.match(xml, /<string>\/fake\/node<\/string>/);
  assert.ok(xml.includes(`<string>${SHIFT_SCRIPT}</string>`));
  assert.match(xml, /<string>--task<\/string>\s*<string>main<\/string>/);
  assert.match(xml, /<string>\/fake\/home<\/string>/); // WorkingDirectory = $HOME
  assert.equal(xml.split("/fake/home/loop-home/logs/task-main.log").length - 1, 2, "stdout/stderr 都指向同一日志");
  assert.match(xml, /<key>PATH<\/key>\s*<string>\/fake\/bin:\/usr\/bin<\/string>/);
  assert.match(xml, /<key>LOOP_CWD<\/key>\s*<string>\/fake\/root<\/string>/);
  assert.equal(xml.match(/<key>Minute<\/key>\s*<integer>0<\/integer>/g).length, 24, "每小时整点触发（StartCalendarInterval 睡醒会补一次）");
  assert.ok(!xml.includes("Hour"), "班次不钉在本机时刻上（时区随出行变）");
  assert.ok(!xml.includes("RunAtLoad"), "装上不能立刻触发一班");
});

test("nextFire：每小时 agent 取下一个整点（本地时间，严格晚于 now）", () => {
  const cal = Array.from({ length: 24 }, () => ({ Minute: 0 }));
  const sat10 = new Date(2026, 9, 17, 10, 0, 0);
  assert.deepEqual(nextFire(cal, sat10), new Date(2026, 9, 17, 11, 0, 0));
  assert.deepEqual(nextFire(cal, new Date(2026, 9, 17, 23, 30, 0)), new Date(2026, 9, 18, 0, 0, 0), "跨天到下一个整点");
  assert.deepEqual(nextFire(cal, new Date(2026, 9, 17, 10, 0, 30)), new Date(2026, 9, 17, 11, 0, 0), "整点过 30 秒也取下一个");
});

test("loopOn：逐个装 agent；scriptPath 默认指向内核 shift.mjs，LOOP_CWD 是配置根，日志在 loopHome/logs", async () => {
  const { calls, deps, root, loopHome, plistPath } = makeDeps();
  await loopOn(deps);
  const labels = ["com.example.kern-test.task.main", "com.example.kern-test.task.weekly"];
  assert.deepEqual(
    calls.map((c) => [c.args[0], c.args[1]]),
    labels.flatMap((l) => [["bootout", `gui/501/${l}`], ["bootstrap", "gui/501"]]),
  );
  for (const c of calls) {
    assert.equal(c.command, "/fake/launchctl");
    assert.ok(Array.isArray(c.args), "launchctl 一律参数数组");
  }
  const main = readFileSync(plistPath("com.example.kern-test.task.main"), "utf8");
  assert.match(main, /<string>--task<\/string>\s*<string>main<\/string>/);
  assert.ok(main.includes(`<string>${SHIFT_SCRIPT}</string>`), "默认叫醒内核自己的班入口");
  assert.match(main, /task-main\.log/, "日志文件 task-<id>.log");
  assert.match(main, /<string>\/fake:\/opt\/homebrew\/bin:\/usr\/local\/bin:\/usr\/bin:\/bin:\/usr\/sbin:\/sbin<\/string>/, "PATH = node 目录 + extraPath + 系统路径");
  const envIdx = main.indexOf("<key>LOOP_CWD</key>");
  assert.ok(main.slice(envIdx, envIdx + 200).includes(root), "LOOP_CWD 指向配置根");
  assert.ok(main.includes(join(loopHome, "logs", "task-main.log")), "日志落 config.loopHome/logs");
  for (const l of labels) assert.ok(existsSync(plistPath(l)));
});

test("loopOn：配置里的 extraPath 换掉默认 PATH 追加段", async () => {
  const { deps, plistPath } = makeDeps();
  const { root: root2 } = makeRoot('  extraPath: ["/custom/bin"],\n');
  Object.assign(deps, { root: root2 });
  await loopOn(deps);
  const xml = readFileSync(plistPath("com.example.kern-test.task.main"), "utf8");
  assert.match(xml, /<string>\/fake:\/custom\/bin:\/usr\/bin:\/bin:\/usr\/sbin:\/sbin<\/string>/);
  assert.ok(!xml.includes("/opt/homebrew/bin"));
});

test("loopOn：bootstrap 失败抛错（exit 非 0 + stderr）", async () => {
  const { deps } = makeDeps({
    spawnFn: fakeSpawn([], ({ args }) => (args[0] === "bootstrap" ? { code: 9, stdout: "", stderr: "Input/output error" } : { code: 0, stdout: "", stderr: "" })),
  });
  await assert.rejects(() => loopOn(deps), /bootstrap com\.example\.kern-test\.task\.main 失败/);
});

test("loopOff：bootout + 删 plist；bootout 非零（本就未加载）不算错", async () => {
  const { calls, deps, plistPath } = makeDeps();
  await loopOn(deps);
  calls.length = 0;
  deps.spawnFn = fakeSpawn(calls, () => ({ code: 1, stdout: "", stderr: "No such process" }));
  await loopOff(deps);
  assert.deepEqual(
    calls.map((c) => [c.args[0], c.args[1]]),
    [["bootout", "gui/501/com.example.kern-test.task.main"], ["bootout", "gui/501/com.example.kern-test.task.weekly"]],
  );
  assert.ok(!existsSync(plistPath("com.example.kern-test.task.main")));
  assert.ok(!existsSync(plistPath("com.example.kern-test.task.weekly")));
});

test("loopStatus：已装与否看 launchctl print，下次触发（下个整点）与最近一条 shifts 记录一起返回", async () => {
  const { deps, root } = makeDeps({
    spawnFn: fakeSpawn([], ({ args }) => (args[0] === "print" && args[1]?.endsWith("com.example.kern-test.task.main") ? { code: 0, stdout: "", stderr: "" } : { code: 1, stdout: "", stderr: "" })),
  });
  const dayDir = join(root, "loop", "days", "2026-10-17");
  mkdirSync(dayDir, { recursive: true });
  writeFileSync(join(dayDir, "shifts.jsonl"), `${JSON.stringify({ shift: "dawn", start: "2026-10-16T18:00:00.000Z", end: "2026-10-16T18:19:00.000Z", exit: 0, timedOut: false, searches: 2 })}\n`);
  const s = await loopStatus(deps);
  assert.deepEqual(s.agents.map((a) => `${a.id}:${a.loaded}`), ["main:true", "weekly:false"]);
  assert.deepEqual(s.agents.map((a) => a.nextFire), ["2026-10-17 11:00", "2026-10-17 11:00"]);
  assert.equal(s.lastShift.shift, "dawn");
  assert.equal(s.lastShift.searches, 2);
  assert.equal(s.shiftName("dawn"), "早班");
  assert.equal(s.shiftName("没登记"), "没登记", "配置里没有的班号回退编号");
});

test("main：on/off/status 返回 0，未知命令返回 1，status 有人话输出", async () => {
  const lines = [];
  const base = makeDeps({ logFn: (...args) => lines.push(args.join(" ")) });
  const dayDir = join(base.root, "loop", "days", "2026-10-17");
  mkdirSync(dayDir, { recursive: true });
  writeFileSync(join(dayDir, "shifts.jsonl"), `${JSON.stringify({ shift: "dawn", start: "2026-10-16T18:00:00.000Z", exit: 0 })}
`);
  assert.equal(await main(["on"], base.deps), 0);
  assert.equal(await main(["status"], base.deps), 0);
  assert.ok(lines.some((l) => l.includes("com.example.kern-test.task.main")));
  assert.ok(lines.some((l) => l.includes("最近一班：早班 ")), "用配置里的班名，不拼「编号 班」");
  assert.equal(await main(["off"], base.deps), 0);
  assert.equal(await main(["nonsense"], base.deps), 1);
});
