// dates.mjs：圈日钉配置时区、纯日历算术、时区切换与非法时区。
import assert from "node:assert/strict";
import { test } from "node:test";

import { addDaysStr, diffDays, getTimezone, localDate, setTimezone } from "../src/dates.mjs";

test("默认时区 Asia/Shanghai", () => {
  assert.equal(getTimezone(), "Asia/Shanghai");
});

test("localDate 按配置时区取日历日，不随系统时区漂移", () => {
  // 北京 2026-10-17 05:30（UTC 还是 10-16 21:30）——Mac 挂在美西时区时同一圈日会跑两圈的那类时刻
  assert.equal(localDate(new Date("2026-10-16T21:30:00Z")), "2026-10-17");
  assert.equal(localDate(new Date("2026-10-16T15:59:59Z")), "2026-10-16");
});

test("addDaysStr 纯日历算术：美国夏令时切换日 ±1 天照常", () => {
  assert.equal(addDaysStr("2026-03-08", 1), "2026-03-09");
  assert.equal(addDaysStr("2026-11-01", -1), "2026-10-31");
});

test("diffDays 纯日历差值，跨月跨年", () => {
  assert.equal(diffDays("2026-10-17", "2026-10-16"), 1);
  assert.equal(diffDays("2026-10-16", "2026-10-17"), -1);
  assert.equal(diffDays("2027-01-01", "2026-12-31"), 1);
});

test("setTimezone 换时区后 formatter 重建；非法时区抛错且原时区不动", () => {
  setTimezone("America/Los_Angeles");
  assert.equal(getTimezone(), "America/Los_Angeles");
  assert.equal(localDate(new Date("2026-10-16T21:30:00Z")), "2026-10-16"); // 美西 14:30
  assert.throws(() => setTimezone("Mars/Olympus"), RangeError);
  assert.equal(getTimezone(), "America/Los_Angeles");
  setTimezone("Asia/Shanghai"); // 还原，别影响后面的测试
  assert.equal(localDate(new Date("2026-10-16T21:30:00Z")), "2026-10-17");
});
