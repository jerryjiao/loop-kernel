// order-types.mjs：createRegistry 补默认值/班次、validateRegistry 规则（含 activeGroups、
// center/quota/ledgerRow 只查字符串或 null）、内置拍板单型、weekOf/byDay。
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { byDay, createRegistry, DECISION_TYPE, validateRegistry, weekOf } from "../src/order-types.mjs";
import { makeRegistry } from "./helpers.mjs";

test("createRegistry：补默认值、switch 默认路径（声明 null 保留）、shiftIds 带 manual、shiftName、getType/by", () => {
  const registry = createRegistry({
    orderTypes: [{ id: "alpha", label: "甲", priority: 1, dedupe: byDay("alpha"), verify: "v" }, DECISION_TYPE],
    shifts: { dawn: { name: "早班", alwaysRun: true, timeLimitMin: 60 } },
    by: ["shift"],
  });
  const alpha = registry.getType("alpha");
  assert.equal(alpha.shifts, "any");
  assert.equal(alpha.deliverable, false);
  assert.equal(alpha.ledgerRow, null);
  assert.equal(alpha.center, null, "不写 center 默认 null，不挡开单");
  assert.deepEqual(alpha.caps, {});
  assert.equal(alpha.search, 0);
  assert.equal(alpha.quota, "support");
  assert.equal(alpha.selfStart, false);
  assert.equal(alpha.switch, "loop/switches/alpha.off");
  assert.equal(registry.getType("decision").switch, null); // 声明 null 的人工关卡类原样保留
  assert.equal(registry.getType("nope"), null);
  assert.deepEqual(registry.shiftIds, ["dawn", "manual"]);
  assert.equal(registry.shiftName("dawn"), "早班");
  assert.equal(registry.shiftName("manual"), "手动");
  assert.equal(registry.shiftName("night"), "night 班"); // 未知班号
  assert.deepEqual(registry.by, ["shift"]);
  assert.deepEqual(registry.types.map((t) => t.id), ["alpha", "decision"]);
});

test("validateRegistry：小注册表（内置拍板单型 + 假单型）全部合格", () => {
  assert.deepEqual(validateRegistry(makeRegistry()), []);
});

test("validateRegistry：逐条列出问题——班次不在 shifts、center/quota/ledgerRow 非字符串、activeGroups 非函数等", () => {
  const bad = createRegistry({
    orderTypes: [
      {
        id: "beta",
        label: "乙",
        shifts: ["night"], // 不在 shiftIds
        priority: "1",
        deliverable: 1,
        ledgerRow: 3,
        center: 5,
        dedupe: "x",
        quota: 7,
        search: -1,
        selfStart: "yes",
        switch: "beta.on",
        suggestable: "x",
        activeGroups: "x",
        caps: { perDay: 0, perWeekPer: 2 },
        needsYou: { timeoutHours: 0, onTimeout: "boom" },
        verify: "",
      },
    ],
    shifts: {},
    by: [],
  });
  assert.deepEqual(validateRegistry(bad), [
    'beta shifts 必须是 "any" 或 manual 的非空子集',
    "beta priority 必须是数字",
    "beta deliverable 必须是布尔",
    "beta ledgerRow 必须是字符串或 null",
    "beta center 必须是字符串或 null",
    "beta 缺 dedupe 函数",
    "beta quota 必须是字符串或 null",
    "beta search 必须是非负数字",
    "beta selfStart 必须是布尔",
    "beta switch 路径必须是 <id>.off 或 null（人工关卡类）",
    "beta suggestable 必须是函数",
    "beta activeGroups 必须是函数",
    "beta 缺 verify 说明指针",
    "beta caps.perDay 必须是正整数",
    "beta caps.perWeekPer 必须是分组字段名（data 字段或 trial）",
    "beta needsYou.timeoutHours 必须是正数或 null",
    "beta needsYou.onTimeout 必须是 default/withdraw/null",
  ]);
});

test("内置拍板单型：人工关卡（switch null、manual 班）、48h 默认、按题号防重复", () => {
  assert.equal(DECISION_TYPE.id, "decision");
  assert.equal(DECISION_TYPE.center, null);
  assert.equal(DECISION_TYPE.switch, null);
  assert.deepEqual(DECISION_TYPE.shifts, ["manual"]);
  assert.deepEqual(DECISION_TYPE.needsYou, { timeoutHours: 48, onTimeout: "default" });
  assert.equal(DECISION_TYPE.dedupe({ data: { question: "F1" } }), "decision:F1");
  assert.equal(DECISION_TYPE.verify, "账本 decision 行");
});

test("weekOf：周四归所在周周一、周一归自己", () => {
  assert.equal(weekOf("2026-10-15"), "2026-10-12"); // 周四 → 本周周一
  assert.equal(weekOf("2026-10-19"), "2026-10-19"); // 周一 → 自己
});

test("byDay：按圈日给防重复键", () => {
  assert.equal(byDay("patrol")({ day: "2026-10-17" }), "patrol:2026-10-17");
});
