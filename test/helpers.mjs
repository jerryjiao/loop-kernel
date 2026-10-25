// 测试共用：现造一个小注册表（内置拍板单型 + 几个假单型，不带任何真实循环的业务单型名），
// 以及可 loadConfig 的临时配置文件。假单型刻意覆盖内核机制点：ledgerRow 两种形状、
// perDay/perWeekPer 上限、selfStart + suggestable + activeGroups、defaultTrial、按班限定。
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { byDay, createRegistry, DECISION_TYPE } from "../src/order-types.mjs";

export const SHIFTS = {
  dawn: { name: "早班", alwaysRun: true, timeLimitMin: 120 },
  dusk: { name: "晚班", alwaysRun: false, timeLimitMin: 90 },
};
export const BY = ["shift", "manual"];

// 手作：交付单（delivery 账本行、按 trial 分组每日上限）
export const CRAFT = {
  id: "craft",
  center: null,
  label: "手作",
  priority: 10,
  deliverable: true,
  ledgerRow: "delivery",
  dedupe: (d) => `craft:${d.trial}:${d.day}:${d.title}`,
  caps: { perDay: 5, perDayPer: "trial" },
  quota: "business",
  verify: "验收指针",
};
// 巡守：只归早班、每日一张、defaultTrial 兜底
export const PATROL = {
  id: "patrol",
  center: null,
  label: "巡守",
  shifts: ["dawn"],
  priority: 40,
  defaultTrial: "patrol-line",
  dedupe: byDay("patrol"),
  caps: { perDay: 1 },
  quota: "support",
  verify: "验收指针",
};
// 侦察：可自启、耗搜索 10
export const SCOUT = {
  id: "scout",
  center: null,
  label: "侦察",
  priority: 60,
  selfStart: true,
  search: 10,
  dedupe: (d) => `scout:${d.data.topic ?? d.day}`,
  quota: "support",
  verify: "验收指针",
};
// 传书：可自启、按分组（channel）每周上限，suggestable 查 activeGroups
export const HERALD = {
  id: "herald",
  center: null,
  label: "传书",
  priority: 50,
  selfStart: true,
  search: 1,
  dedupe: (d) => `herald:${d.data.channel}:${d.day}`,
  caps: { perWeek: 2, perWeekPer: "channel" },
  suggestable: ({ type, states, day, activeGroups, capProblem: cap }) =>
    Array.isArray(activeGroups) && activeGroups.some((c) => cap(type, states, day, { channel: c }) === null),
  activeGroups: (ctx) => ctx.channels,
  quota: "support",
  verify: "验收指针",
};
// 记事：通用账本行（ledgerRow 非交付形状，走 data 打底 + ledger 补丁合并）
export const CHRONICLE = {
  id: "chronicle",
  center: null,
  label: "记事",
  priority: 30,
  ledgerRow: "chronicle",
  dedupe: byDay("chronicle"),
  quota: "support",
  verify: "验收指针",
};

export const ORDER_TYPES = [DECISION_TYPE, CRAFT, PATROL, SCOUT, HERALD, CHRONICLE];

export const makeRegistry = (orderTypes = ORDER_TYPES) => createRegistry({ orderTypes, shifts: SHIFTS, by: BY });

/** 直接喂 makeCtx（orders.mjs）用的配置对象（loadConfig 产物同形）。 */
export const testConfig = (over = {}) => ({
  root: "/tmp/loop-kernel-test",
  loopHome: "/tmp/loop-kernel-test-home",
  launchdPrefix: "com.example.kern-test",
  shifts: SHIFTS,
  by: BY,
  orderTypes: ORDER_TYPES,
  ledgerRows: {},
  prompt: () => "干活",
  executor: { run: async () => ({}) },
  ...over,
});

/** 在 root 里写一个可 loadConfig 的 loop.config.mjs（单型用上面的假注册表）。 */
export function writeConfigFile(root) {
  writeFileSync(
    join(root, "loop.config.mjs"),
    `import { SHIFTS, BY, ORDER_TYPES } from ${JSON.stringify(new URL(import.meta.url).href)};\n` +
      "export default {\n" +
      `  loopHome: ${JSON.stringify(join(root, "loop-home"))},\n` +
      '  launchdPrefix: "com.example.kern-test",\n' +
      "  shifts: SHIFTS,\n" +
      "  by: BY,\n" +
      "  orderTypes: ORDER_TYPES,\n" +
      "  ledgerRows: {},\n" +
      '  prompt: () => "干活",\n' +
      "  executor: { run: async () => ({}) },\n" +
      "};\n",
  );
  return root;
}
