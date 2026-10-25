// config.mjs：默认值补齐、必填缺失、类型不对、时区落进 dates、冻结。临时目录里造 loop.config.mjs。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { loadConfig, validateConfig } from "../src/config.mjs";
import { getTimezone, setTimezone } from "../src/dates.mjs";

const tempDirs = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-cfg-"));
  tempDirs.push(dir);
  return dir;
};
afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop(), { recursive: true, force: true });
  setTimezone("Asia/Shanghai"); // 时区测试别漏到后面的测试
});

function writeConfig(source) {
  const root = tempDir();
  writeFileSync(join(root, "loop.config.mjs"), source);
  return root;
}

const MINIMAL = `export default {
  loopHome: "/tmp/loop-home",
  launchdPrefix: "com.example.testloop",
  shifts: { plan: { name: "规划班", timeLimitMin: 120, alwaysRun: true } },
  orderTypes: [],
  prompt: () => "干活",
  executor: { run: async () => ({}) },
};`;

const baseCfg = () => ({
  loopHome: "/tmp/loop-home",
  launchdPrefix: "com.example.testloop",
  shifts: { plan: { name: "规划班", timeLimitMin: 120, alwaysRun: true } },
  orderTypes: [],
  prompt: () => "干活",
  executor: { run: async () => ({}) },
});

test("loadConfig 补默认值、冻结，timezone 落到 dates", async () => {
  const root = writeConfig(MINIMAL);
  const config = await loadConfig(root);
  assert.equal(config.root, root);
  assert.equal(config.timezone, "Asia/Shanghai");
  assert.deepEqual(config.by, ["shift", "manual"]);
  assert.deepEqual(config.ledgerRows, {});
  assert.deepEqual(config.extraPath, ["/opt/homebrew/bin", "/usr/local/bin"]);
  assert.equal(Object.isFrozen(config), true);
  assert.equal(getTimezone(), "Asia/Shanghai");
});

test("loadConfig 保留显式给的 root/by/ledgerRows，并按配置设时区", async () => {
  const root = writeConfig(`export default {
    root: "/elsewhere",
    timezone: "UTC",
    loopHome: "/tmp/loop-home",
    launchdPrefix: "com.example.testloop",
    by: ["shift"],
    shifts: {},
    orderTypes: [],
    ledgerRows: { note: () => null },
    prompt: () => "干活",
    executor: { run: async () => ({}) },
  };`);
  const config = await loadConfig(root);
  assert.equal(config.root, "/elsewhere");
  assert.deepEqual(config.by, ["shift"]);
  assert.equal(typeof config.ledgerRows.note, "function");
  assert.equal(getTimezone(), "UTC");
});

test("loadConfig 缺必填报全部问题；没有 default 导出也一样不合格", async () => {
  const root = writeConfig("export default { loopHome: '/tmp/loop-home' };");
  await assert.rejects(
    () => loadConfig(root),
    /launchdPrefix 缺失[\s\S]*shifts 缺失[\s\S]*orderTypes 缺失[\s\S]*prompt 缺失[\s\S]*executor 缺失/,
  );
  await assert.rejects(() => loadConfig(writeConfig("export const x = 1;")), /配置必须是对象/);
});

test("validateConfig：最小合格配置无问题；非对象一律不合格", () => {
  assert.deepEqual(validateConfig(baseCfg()), []);
  assert.deepEqual(validateConfig(null), ["配置必须是对象"]);
  assert.deepEqual(validateConfig([]), ["配置必须是对象"]);
});

test("validateConfig：必填缺失与类型不对逐条列出（含 shifts 里两个字段）", () => {
  assert.deepEqual(validateConfig({}), [
    "loopHome 缺失",
    "launchdPrefix 缺失",
    "shifts 缺失",
    "orderTypes 缺失",
    "prompt 缺失",
    "executor 缺失",
  ]);
  const cfg = baseCfg();
  cfg.timezone = 8;
  cfg.by = "shift";
  cfg.notify = "x";
  cfg.shifts = { plan: { name: "规划班", timeLimitMin: "120", alwaysRun: 1 } };
  assert.deepEqual(validateConfig(cfg), [
    "timezone 必须是字符串",
    "by 必须是数组",
    "notify 必须是函数",
    "shifts.plan.alwaysRun 必须是布尔",
    "shifts.plan.timeLimitMin 必须是数字",
  ]);
});
