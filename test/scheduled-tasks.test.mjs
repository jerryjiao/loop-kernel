// scheduled-tasks.mjs：登记表校验、到点与顺延、下次运行、停用标记、时区切换。
// 登记表照真实格式在临时目录里造，不读真仓库。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, test } from "node:test";

import { setTimezone } from "../src/dates.mjs";
import {
  beijingParts,
  describeSchedule,
  disabledFlagPath,
  dueShift,
  isDisabled,
  loadTasks,
  nextRun,
  setDisabled,
  zonedParts,
} from "../src/scheduled-tasks.mjs";

const tempDirs = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-tasks-"));
  tempDirs.push(dir);
  return dir;
};
afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop(), { recursive: true, force: true });
  setTimezone("Asia/Shanghai"); // 时区测试别漏到后面的测试
});

const never = () => false;
const ran = (...ids) => (_day, shift) => ids.includes(shift);

/** 上海墙上时钟 → 绝对时刻（UTC+8，无夏令时）。 */
function bj(day, hm) {
  const [y, m, d] = day.split("-").map(Number);
  const [h, min] = hm.split(":").map(Number);
  return new Date(Date.UTC(y, m - 1, d, h - 8, min));
}

// 与真实登记表同格式的样例：三个任务、多班顺延、每周五、单班。
const REGISTRY = {
  tasks: [
    {
      id: "money-loop",
      name: "赚钱循环",
      runbook: "loop/shift.md",
      executor: "Claude Code",
      schedule: {
        slots: [
          { shift: "05", name: "规划班", hour: 2 },
          { shift: "09", name: "执行班一", hour: 3 },
          { shift: "13", name: "执行班二", hour: 4 },
          { shift: "21", name: "执行班三", hour: 5 },
        ],
      },
    },
    {
      id: "friday",
      name: "每周回顾",
      runbook: "loop/friday.md",
      executor: "Claude Code",
      schedule: { weekday: 5, slots: [{ shift: "friday", name: "每周回顾", hour: 17 }] },
    },
    {
      id: "xsync",
      name: "X 收藏同步",
      runbook: "skills/x-bookmarks-sync/RUNBOOK.md",
      executor: "Claude Code",
      schedule: { slots: [{ shift: "xsync", name: "X 收藏同步", hour: 1 }] },
    },
  ],
};

function withTasks(tasks) {
  const root = tempDir();
  mkdirSync(join(root, "loop"), { recursive: true });
  writeFileSync(join(root, "loop", "scheduled-tasks.json"), JSON.stringify({ tasks }));
  return root;
}

const loadRegistry = () => loadTasks(withTasks(REGISTRY.tasks));

function baseTask(over = {}) {
  return {
    id: "alpha",
    name: "甲",
    runbook: "loop/shift.md",
    executor: "Claude Code",
    schedule: { slots: [{ shift: "05", name: "规划班", hour: 2 }] },
    ...over,
  };
}

test("loadTasks 读 <root>/loop/scheduled-tasks.json，三个任务", () => {
  assert.deepEqual(loadRegistry().map((t) => t.id), ["money-loop", "friday", "xsync"]);
});

test("loadTasks 拒绝重复 id、hour 不递增、shift 跨任务重复、非法 id、weekday=7", () => {
  const bad = [
    [[baseTask(), baseTask({ name: "乙" })], /id 重复/],
    [[baseTask({
      schedule: {
        slots: [
          { shift: "05", name: "规划班", hour: 4 },
          { shift: "09", name: "执行班一", hour: 3 },
        ],
      },
    })], /hour 必须严格递增/],
    [[
      baseTask(),
      baseTask({ id: "beta", schedule: { slots: [{ shift: "05", name: "乙", hour: 1 }] } }),
    ], /shift/],
    [[baseTask({ id: "Bad" })], /id 非法/],
    [[baseTask({ schedule: { weekday: 7, slots: [{ shift: "05", name: "规划班", hour: 2 }] } })], /weekday/],
  ];
  for (const [tasks, re] of bad) assert.throws(() => loadTasks(withTasks(tasks)), re);
});

test("weekday 0（周日）合法，只在周日放行，周一则指向下周日", () => {
  const task = loadTasks(withTasks([baseTask({
    schedule: { weekday: 0, slots: [{ shift: "sun", name: "周日", hour: 9 }] },
  })]))[0];
  assert.equal(dueShift(task, bj("2026-10-18", "09:00"), never), "sun");
  assert.equal(dueShift(task, bj("2026-10-19", "09:00"), never), null);
  assert.deepEqual(nextRun(task, bj("2026-10-19", "10:00"), never), {
    at: "2026-10-25T01:00:00.000Z",
    overdue: false,
  });
});

test("dueShift：没到点不跑，到点跑最早欠着的班，前一班没跑完后一班让路", () => {
  const money = loadRegistry().find((t) => t.id === "money-loop");
  const day = "2026-10-21";
  assert.equal(dueShift(money, bj(day, "01:30"), never), null);
  assert.equal(dueShift(money, bj(day, "02:00"), never), "05");
  assert.equal(dueShift(money, bj(day, "02:30"), ran("05")), null);
  assert.equal(dueShift(money, bj(day, "03:00"), never), "05");
});

test("dueShift：周五任务只在周五到点后跑", () => {
  const friday = loadRegistry().find((t) => t.id === "friday");
  assert.equal(dueShift(friday, bj("2026-10-16", "16:59"), never), null);
  assert.equal(dueShift(friday, bj("2026-10-16", "17:00"), never), "friday");
  assert.equal(dueShift(friday, bj("2026-10-17", "17:00"), never), null);
});

test("zonedParts 按配置时区跨日；beijingParts 是旧名别名", () => {
  assert.equal(beijingParts, zonedParts);
  assert.deepEqual(zonedParts(new Date("2026-10-20T17:30:00Z")), {
    day: "2026-10-21",
    weekday: 3,
    minutes: 90,
  });
  setTimezone("UTC");
  assert.deepEqual(zonedParts(new Date("2026-10-20T17:30:00Z")), {
    day: "2026-10-20",
    weekday: 2,
    minutes: 1050,
  });
});

test("nextRun：欠着报今天的开工时刻；否则今天后面、明天、或下个周五", () => {
  const tasks = loadRegistry();
  const money = tasks.find((t) => t.id === "money-loop");
  const friday = tasks.find((t) => t.id === "friday");
  assert.deepEqual(nextRun(money, bj("2026-10-21", "03:00"), never), {
    at: "2026-10-20T18:00:00.000Z",
    overdue: true,
  });
  assert.deepEqual(nextRun(money, bj("2026-10-21", "02:30"), ran("05")), {
    at: "2026-10-20T19:00:00.000Z",
    overdue: false,
  });
  assert.deepEqual(nextRun(money, bj("2026-10-21", "06:00"), ran("05", "09", "13", "21")), {
    at: "2026-10-21T18:00:00.000Z",
    overdue: false,
  });
  assert.deepEqual(nextRun(friday, bj("2026-10-17", "17:00"), never), {
    at: "2026-10-23T09:00:00.000Z",
    overdue: false,
  });
});

test("describeSchedule 三种文案", () => {
  const byId = Object.fromEntries(loadRegistry().map((t) => [t.id, t]));
  assert.equal(describeSchedule(byId.xsync), "每天 01:00 起（北京时间）");
  assert.equal(describeSchedule(byId.friday), "每周五 17:00 起（北京时间）");
  assert.equal(
    describeSchedule(byId["money-loop"]),
    "每天 02:00 / 03:00 / 04:00 / 05:00 起（北京时间，前一班没跑完顺延）",
  );
});

test("停用标记往返；非法 id 抛错", () => {
  const home = tempDir();
  assert.equal(isDisabled(home, "money-loop"), false);
  setDisabled(home, "money-loop", true);
  assert.equal(isDisabled(home, "money-loop"), true);
  const file = disabledFlagPath(home, "money-loop");
  assert.equal(file, resolve(home, "disabled", "money-loop"));
  assert.ok(file.startsWith(resolve(home, "disabled") + "/"));
  assert.match(readFileSync(file, "utf8"), /^\d{4}-\d{2}-\d{2}T/);
  setDisabled(home, "money-loop", false);
  assert.equal(isDisabled(home, "money-loop"), false);
  assert.equal(existsSync(file), false);
  setDisabled(home, "money-loop", false);
  for (const id of ["../x", "Bad", "a/b", ""]) {
    assert.throws(() => disabledFlagPath(home, id), /非法/);
    assert.throws(() => isDisabled(home, id), /非法/);
    assert.throws(() => setDisabled(home, id, true), /非法/);
  }
});
