// 定时任务登记表（术语见 GLOSSARY.md「班 / 定时任务」）：每个任务一条 launchd，
// 每小时整点叫醒，脚本按配置时区查这张表判断该不该跑。钟点是「最早几点能开」，
// 前一班没跑完后一班顺延到下一个整点。zonedParts 的真源在这里；beijingParts 是
// 旧名别名，赚钱循环还在用。

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

import { addDaysStr, getTimezone } from "./dates.mjs";

const ID_RE = /^[a-z][a-z0-9-]*$/;
const WEEKDAY_CHAR = ["日", "一", "二", "三", "四", "五", "六"];

// 时区跟 dates 模块走，换过 setTimezone 才重建 formatter（Intl 格式化开销大）。
let partsFmt = null;
let partsTz = null;
function zonedFormat(date) {
  const tz = getTimezone();
  if (partsTz !== tz) {
    partsFmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric", month: "2-digit", day: "2-digit", weekday: "short",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    });
    partsTz = tz;
  }
  return partsFmt.formatToParts(date);
}

const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** 任一时刻按配置时区分解：圈日、星期（0=周日）、当日分钟数。与本机时区无关。 */
export function zonedParts(date) {
  const get = (type) => zonedFormat(date).find((p) => p.type === type)?.value ?? "";
  return {
    day: `${get("year")}-${get("month")}-${get("day")}`,
    weekday: WEEKDAYS[get("weekday")] ?? -1,
    minutes: Number(get("hour")) * 60 + Number(get("minute")),
  };
}

export const beijingParts = zonedParts;

function bad(taskId, field, detail) {
  const who = taskId ? `任务 ${taskId} 的 ` : "";
  throw new Error(`${who}${field} ${detail}`);
}

function requireText(task, field) {
  if (typeof task[field] !== "string" || task[field].length === 0) bad(task.id, field, "必须是非空字符串");
}

/** 读 `<root>/loop/scheduled-tasks.json`，校验后返回 tasks。不合格抛中文 Error，指出任务与字段。 */
export function loadTasks(root) {
  const raw = JSON.parse(readFileSync(join(root, "loop", "scheduled-tasks.json"), "utf8"));
  const tasks = raw?.tasks;
  if (!Array.isArray(tasks) || tasks.length === 0) bad("", "tasks", "必须是非空数组");

  const ids = new Set();
  const shifts = new Map();
  for (const task of tasks) {
    const id = task?.id;
    if (typeof id !== "string" || !ID_RE.test(id)) bad("", "id", `非法：${id}`);
    if (ids.has(id)) bad(id, "id", "重复");
    ids.add(id);
    requireText(task, "name");
    requireText(task, "runbook");
    requireText(task, "executor");

    const schedule = task.schedule;
    if (!schedule || typeof schedule !== "object") bad(id, "schedule", "缺失");
    if (schedule.weekday !== undefined) {
      const w = schedule.weekday;
      if (!Number.isInteger(w) || w < 0 || w > 6) bad(id, "schedule.weekday", "必须是 0–6 的整数");
    }
    const slots = schedule.slots;
    if (!Array.isArray(slots) || slots.length === 0) bad(id, "schedule.slots", "必须是非空数组");

    let prevHour = -1;
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      const where = `schedule.slots[${i}]`;
      if (typeof slot?.shift !== "string" || slot.shift.length === 0) bad(id, `${where}.shift`, "必须是非空字符串");
      if (typeof slot?.name !== "string" || slot.name.length === 0) bad(id, `${where}.name`, "必须是非空字符串");
      if (!Number.isInteger(slot.hour) || slot.hour < 0 || slot.hour > 23) bad(id, `${where}.hour`, "必须是 0–23 的整数");
      if (slot.hour <= prevHour) bad(id, `${where}.hour`, "必须严格递增");
      prevHour = slot.hour;
      const owner = shifts.get(slot.shift);
      if (owner) bad(id, `${where}.shift`, `「${slot.shift}」与任务 ${owner} 重复`);
      shifts.set(slot.shift, id);
    }
  }
  return tasks;
}

/** 此刻该跑的班编号；没有则 null。按 slots 顺序取第一个已到点且今天没跑过的，所以前一班没跑完会占住后一班。 */
export function dueShift(task, now, hasRun) {
  const { day, weekday, minutes } = zonedParts(now);
  const only = task.schedule.weekday;
  if (only !== undefined && only !== weekday) return null;
  for (const slot of task.schedule.slots) {
    if (minutes >= slot.hour * 60 && !hasRun(day, slot.shift)) return slot.shift;
  }
  return null;
}

// shortcut: 只算准 UTC+8；配了非 +8 无夏令时时区的循环用到 nextRun 时再按偏移重算。
/** 圈日某整点的 ISO。UTC+8 无夏令时，hour-8 交给 Date.UTC 跨日。 */
function atZoned(day, hour) {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, hour - 8, 0, 0)).toISOString();
}

function weekdayOf(day) {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** 下一次开工。欠着：overdue，at 为该班今天的开工时刻。否则取最近的将来时刻
 *  （今天剩下的未跑过的班；没有则之后最近一天的第一个班）。有 weekday 时最多再找 8 天。 */
export function nextRun(task, now, hasRun) {
  const parts = zonedParts(now);
  const due = dueShift(task, now, hasRun);
  if (due) {
    const slot = task.schedule.slots.find((s) => s.shift === due);
    return { at: atZoned(parts.day, slot.hour), overdue: true };
  }
  const only = task.schedule.weekday;
  if (only === undefined || only === parts.weekday) {
    for (const slot of task.schedule.slots) {
      if (parts.minutes < slot.hour * 60 && !hasRun(parts.day, slot.shift)) {
        return { at: atZoned(parts.day, slot.hour), overdue: false };
      }
    }
  }
  const horizon = only === undefined ? 1 : 8;
  for (let i = 1; i <= horizon; i++) {
    const day = addDaysStr(parts.day, i);
    if (only !== undefined && weekdayOf(day) !== only) continue;
    const slot = task.schedule.slots[0];
    if (!slot) return null;
    return { at: atZoned(day, slot.hour), overdue: false };
  }
  return null;
}

const hhmm = (hour) => `${String(hour).padStart(2, "0")}:00`;

// shortcut: 文案钉死「北京时间」；配了别的时区的循环要显示本时区名时再改。
/** 中文一句话：单班「每天/每周几 HH:00 起（北京时间）」；多班再注明前一班没跑完顺延。 */
export function describeSchedule(task) {
  const { slots, weekday } = task.schedule;
  const when = weekday === undefined ? "每天" : `每周${WEEKDAY_CHAR[weekday]}`;
  const times = slots.map((s) => hhmm(s.hour)).join(" / ");
  const tail = slots.length > 1 ? "，前一班没跑完顺延" : "";
  return `${when} ${times} 起（北京时间${tail}）`;
}

/** `<loopHome>/disabled/<id>`。id 过登记表同款白名单，resolve 后必须仍在 disabled 目录里。 */
export function disabledFlagPath(loopHome, id) {
  if (typeof id !== "string" || !ID_RE.test(id)) throw new Error(`任务 id 非法：${id}`);
  const base = resolve(loopHome, "disabled");
  const target = resolve(base, id);
  if (!target.startsWith(base + sep)) throw new Error(`任务 id 非法：${id}`);
  return target;
}

export function isDisabled(loopHome, id) {
  return existsSync(disabledFlagPath(loopHome, id));
}

/** 停用写一个空文件（内容是停用时刻 ISO）；启用则删除，文件不在不报错。 */
export function setDisabled(loopHome, id, disabled) {
  const file = disabledFlagPath(loopHome, id);
  if (!disabled) {
    try {
      unlinkSync(file);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    return;
  }
  mkdirSync(resolve(loopHome, "disabled"), { recursive: true });
  writeFileSync(file, new Date().toISOString());
}
