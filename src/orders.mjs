// 单框架唯一写入口：班/力工只能经 `node src/orders.mjs <cmd>` 改单，手改
// loop/days/<圈日>/orders.jsonl 一律不算数。规矩在这里由脚本强制：七阶段迁移、
// 防重复硬闸、每日/每周上限（跨 7 个圈日回看）、开关文件、搜索预算（全天 ≤30 次）、
// 额度底线；单型注册表由循环在 loop.config.mjs 的 orderTypes 里注入（order-types.mjs
// 的 createRegistry 组好经 ctx.registry 传进来）。全部输出 JSON，拒绝时退出码 2 + 中文原因。
// days/switches/ledger 路径、时间、额度函数都可注入（--days-dir 等 flag、main 的 deps
// 参数），测试只用临时目录、时间一律注入不碰活墙钟。

import { existsSync, mkdirSync, openSync, closeSync, writeSync, fdatasyncSync, statSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { addLedgerRow, loadLedger } from "./ledger.mjs";
import { diffDays, localDate } from "./dates.mjs";
import { LOCK_RETRY_MS, LOCK_STALE_MS, LOCK_TIMEOUT_MS, withDirLock } from "./dir-lock.mjs";
import { createRegistry, validateRegistry } from "./order-types.mjs";
import { loadConfig } from "./config.mjs";

export const ORDERS_FILE_NAME = "orders.jsonl";

// 事件 → 阶段。七个阶段：待做、排队、在做、等你、完成、失败、关闭。
export const PHASE_OF_EVENT = {
  open: "todo",
  queue: "queued",
  start: "doing",
  resume: "doing",
  needs_you: "waiting",
  done: "done",
  fail: "failed",
  close: "closed",
};
export const PHASE_LABELS = {
  todo: "待做",
  queued: "排队",
  doing: "在做",
  waiting: "等你",
  done: "完成",
  failed: "失败",
  closed: "关闭",
};

// 合法迁移表：键 = 当前阶段，值 = 允许的下一个事件；终态（done/failed/closed）不再迁移。
const LEGAL_TRANSITIONS = {
  todo: ["queue", "start", "needs_you", "done", "fail", "close"],
  queued: ["start", "done", "fail", "close"],
  doing: ["queue", "needs_you", "done", "fail", "close"],
  waiting: ["resume", "done", "fail", "close"],
  done: [],
  failed: [],
  closed: [],
};

// 全天 MCP 搜索预算；next 按单型 search 估值累计当天已领单，超线不再给耗搜索的单。
export const SEARCH_BUDGET = 30;

export class Reject extends Error {}

const ACTIVE_PHASES = ["todo", "queued", "doing", "waiting"];

export function dayFile(daysDir, day) {
  return join(daysDir, day, ORDERS_FILE_NAME);
}

// —— 改单互斥锁 ——
// open/transition 都是「读-检查-写」，不锁住就会双开同 key 单、双写账本行。目录锁本体在
// dir-lock.mjs（抢锁/抢占/重试口径与账本写锁共用一份）；这里只定锁位置（days 目录下 .lock）
// 与拒绝文案。常量再导出，旧导入不断。
export { LOCK_RETRY_MS, LOCK_STALE_MS, LOCK_TIMEOUT_MS };

export function withDayLock(daysDir, fn, { now = Date.now, sleep } = {}) {
  return withDirLock(join(daysDir, ".lock"), fn, {
    now,
    ...(sleep ? { sleep } : {}),
    ensureDir: true,
    busyError: new Reject("单记录正忙：另一进程正在改单，稍后重试"),
  });
}

/** 追加一行事件并写后核验字节增量（单次 write 返回不可当落盘证据）。
 *  O_APPEND 让偏移原子推进，writeSync 循环补齐短写；并发下其他进程会继续追加，
 *  所以核验用「文件至少增长了本行字节」而不是精确相等。 */
export function appendEvent(file, event) {
  const line = Buffer.from(`${JSON.stringify(event)}\n`, "utf-8");
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = existsSync(file) ? statSync(file).size : 0;
    const fd = openSync(file, "a");
    try {
      let written = 0;
      while (written < line.length) written += writeSync(fd, line, written, line.length - written);
      fdatasyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (statSync(file).size >= before + line.length) return event;
  }
  throw new Error(`事件写入核验失败（${file}）：字节增量不符，已重试 3 次`);
}

function readDayEvents(daysDir, day) {
  const file = dayFile(daysDir, day);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf-8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line, i) => {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        throw new Error(`圈日 ${day} 第 ${i + 1} 行不是合法 JSON（${file}）——单记录被写坏，先查并发写入`);
      }
      return { day, event };
    });
}

/** 按事件折叠出一张单的当前态：open 的字段打底，后续事件覆盖 reason/artifacts/verified/
 *  searches，data 浅合并（后者赢）。phase 是推导出的七阶段之一。 */
export function foldOrder(events, day) {
  const state = { day };
  for (const e of events) {
    Object.assign(state, {
      order: e.order,
      type: e.type,
      // shortcut: trial 是赚钱循环的叫法，内核只当可选的归属字段透传，第二个循环需要别的归属语义时再改名
      trial: e.trial ?? state.trial ?? "-",
      shift: e.shift ?? state.shift,
      by: e.by ?? state.by,
      key: e.key ?? state.key,
      title: e.title ?? state.title,
    });
    state.data = { ...state.data, ...(e.data ?? {}) };
    if (e.reason !== undefined) state.reason = e.reason;
    if (e.artifacts !== undefined) state.artifacts = e.artifacts;
    if (e.verified !== undefined) state.verified = e.verified;
    if (e.searches !== undefined) state.searches = e.searches;
    if (e.sessionId !== undefined) state.sessionId = e.sessionId;
    state.event = e.event;
    state.phase = PHASE_OF_EVENT[e.event];
    state.ts = e.ts;
  }
  state.phaseLabel = PHASE_LABELS[state.phase];
  return state;
}

/** 扫全部圈日的单记录并折叠（单事件都留在开单那天的文件里，按目录序即时间序）。
 *  单文件很小、一天一目录，全量扫多年也够快；上限/防重复靠全量才不漏跨天。 */
export function scanOrders(daysDir) {
  if (!existsSync(daysDir)) return [];
  const byId = new Map();
  for (const day of readdirSync(daysDir).sort()) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue; // 圈日目录之外的（如 .lock）不是单记录
    for (const { event } of readDayEvents(daysDir, day)) {
      if (!event?.order) continue;
      const rec = byId.get(event.order) ?? { day, events: [] };
      byId.set(event.order, rec);
      rec.events.push(event);
    }
  }
  return [...byId.values()].map((rec) => foldOrder(rec.events, rec.day));
}

export function listOrders(ctx, { date, phase, type } = {}) {
  let states = scanOrders(ctx.daysDir);
  if (date) states = states.filter((s) => s.day === date);
  if (phase) states = states.filter((s) => s.phase === phase || s.phaseLabel === phase);
  if (type) states = states.filter((s) => s.type === type);
  return states;
}

/** 防重复硬闸：同 key 已有核验完成的单 → 拒绝；同 key 还有进行中的单 → 也拒绝。 */
export function dedupeProblem(type, key, states) {
  for (const s of states) {
    if (s.type !== type.id || s.key !== key) continue;
    if (s.phase === "done" && s.verified === true) {
      return `同 key（${key}）已有核验完成的单 ${s.order}（${s.day}），防重复拒绝`;
    }
    if (ACTIVE_PHASES.includes(s.phase)) {
      return `同 key（${key}）已有进行中的单 ${s.order}（${s.day}，${s.phaseLabel}），防重复拒绝`;
    }
  }
  return null;
}

/** 因系统故障（脚本/环境/网关坏了，不是内容问题）关掉或失败的单：reason 以「系统故障」开头，
 *  不占每日/每周上限。其余原因的关闭/失败照常计数。 */
export function isFault(s) {
  return (s.phase === "closed" || s.phase === "failed") && String(s.reason ?? "").startsWith("系统故障");
}

/** 分组字段在已开单上的取值（perWeekPer/perDayPer 共用）：trial 是单的顶层字段不在
 *  data 里，特判取 s.trial；其余按 data[field]。 */
function groupOfState(s, field) {
  return field === "trial" ? s.trial : s.data?.[field];
}

/** 本周（[day-6, day]）该单型已开的单数：capProblem 的计数口径。perWeekPer 单型给
 *  value（分组值）只数该组，不给数全部（工作台配额显示用同一口径）。 */
export function weekOpened(type, states, day, value = null) {
  const field = type.caps?.perWeekPer;
  return states.filter((s) => {
    if (s.type !== type.id || isFault(s)) return false;
    const d = diffDays(day, s.day);
    if (!(d >= 0 && d <= 6)) return false;
    return field === undefined || value === null || groupOfState(s, field) === value;
  }).length;
}

/** 上限检查（跨 7 个圈日回看：[day-6, day]）。返回 null = 放行，否则给中文原因。
 *  caps.perWeek 配 perWeekPer 时按分组各算一个 perWeek，caps.perDay 配 perDayPer 时
 *  同理各算一个 perDay（开单侧的分组值：trial 取 trial 参数，其余取 data[field]）。 */
export function capProblem(type, states, day, data = {}, trial = undefined) {
  const caps = type.caps ?? {};
  const ofType = states.filter((s) => s.type === type.id && !isFault(s));
  const openingValue = (field) => (field === "trial" ? trial : data[field]); // 开单侧的分组值
  if (caps.perDay !== undefined) {
    const field = caps.perDayPer;
    if (field) {
      const value = openingValue(field);
      if (typeof value !== "string" || !value) {
        return `单型 ${type.id} 缺 ${field} 字段（按 ${field} 分组限每日 ${caps.perDay} 单）`;
      }
      const n = ofType.filter((s) => s.day === day && groupOfState(s, field) === value).length;
      if (n >= caps.perDay) return `${field}=${value} 今日已开 ${n} 单，达到每日上限 ${caps.perDay}`;
    } else {
      const n = ofType.filter((s) => s.day === day).length;
      if (n >= caps.perDay) return `单型 ${type.id}（${type.label}）今日已开 ${n} 单，达到每日上限 ${caps.perDay}`;
    }
  }
  if (caps.perWeek !== undefined) {
    const field = caps.perWeekPer;
    const value = field ? openingValue(field) : undefined;
    if (field && (typeof value !== "string" || !value)) {
      return `单型 ${type.id} 缺 ${field} 字段（按 ${field} 分组限每周 ${caps.perWeek} 单）`;
    }
    const n = weekOpened(type, states, day, field ? value : null);
    if (n >= caps.perWeek) {
      return field
        ? `${field}=${value} 近 7 个圈日已开 ${n} 单，达到每周上限 ${caps.perWeek}`
        : `单型 ${type.id}（${type.label}）近 7 个圈日已开 ${n} 单，达到每周上限 ${caps.perWeek}`;
    }
  }
  return null;
}

export function switchFile(switchesDir, typeId) {
  return join(switchesDir, `${typeId}.off`);
}

function switchProblem(ctx, type) {
  if (type.switch === null) return null; // 人工关卡类单型（拍板等）不受开关约束
  return existsSync(switchFile(ctx.switchesDir, type.id))
    ? `单型 ${type.id}（${type.label}）已被开关关闭（${type.switch}）`
    : null;
}

/** 当天搜索用量：圈日 = day 的每张单，done 时回填的实际搜索次数（--searches）优先，
 *  否则按单型 search 估值；exceptOrder 用于给候选单扣除它自己已计入的那份。 */
export function searchUsage(ctx, states, day, exceptOrder = null) {
  let total = 0;
  for (const s of states) {
    if (s.day !== day || s.order === exceptOrder) continue;
    total += s.searches ?? ctx.registry.getType(s.type)?.search ?? 0;
  }
  return total;
}

/** 班次推算：班次进程（起会话前）设了 LOOP_SHIFT 就优先用它（registry.shiftIds 里的合法值
 *  才认——多个班钟点挨着开时，按钟点推算会把半夜全算成夜班）；没设/不合法用 ctx.shiftOf
 *  （循环在 loop.config.mjs 里按钟点推班）；都没有记 manual（人工关卡类单型不归任何班）。 */
function currentShift(ctx, date) {
  const env = process.env.LOOP_SHIFT;
  if (env && ctx.registry.shiftIds.includes(env)) return env;
  if (typeof ctx.shiftOf === "function") return ctx.shiftOf(date);
  return "manual";
}

/** 开单。input: { type, title, trial?, key?, data?, shift?, by? }。
 *  全程持锁：防重复/上限检查与写入之间不再有窗口（两个进程同 key 只成一张、单号不撞）。 */
export function openOrder(ctx, input = {}) {
  return withDayLock(ctx.daysDir, () => openOrderLocked(ctx, input));
}

/** 被拒的开单落当天 rejects.jsonl（班小结要读，班手不用自己记）：reason 用 Reject 原文；
 *  记录失败不打扰原拒绝（open 的退出码与输出保持不变）。全程在 withDayLock 内追加。 */
function appendReject(ctx, rec, error) {
  try {
    const now = ctx.now();
    const file = join(ctx.daysDir, localDate(now), "rejects.jsonl");
    mkdirSync(dirname(file), { recursive: true });
    const row = { ts: now.toISOString(), shift: rec.shift ?? currentShift(ctx, now), type: rec.type };
    if (rec.key !== undefined) row.key = rec.key;
    if (rec.title !== undefined) row.title = rec.title;
    row.reason = error.message;
    appendEvent(file, row);
  } catch {}
}

function openOrderLocked(ctx, input = {}) {
  const rec = { type: input.type, shift: input.shift, key: input.key, title: input.title };
  try {
    return openOrderChecked(ctx, input, rec);
  } catch (error) {
    if (error instanceof Reject) appendReject(ctx, rec, error);
    throw error;
  }
}

function openOrderChecked(ctx, input, rec) {
  const type = ctx.registry.getType(input.type);
  if (!type) throw new Reject(`未知单型：${input.type}（注册表见 loop.config.mjs 的 orderTypes）`);
  if (!input.title) throw new Reject("open 需要一句 --title 说明这张单干什么");
  const now = ctx.now();
  const day = localDate(now);
  const shift = input.shift ?? currentShift(ctx, now);
  rec.shift = shift;
  const by = input.by ?? "shift";
  if (!ctx.registry.shiftIds.includes(shift)) {
    throw new Reject(`shift 必须是 ${ctx.registry.shiftIds.join("/")} 之一，收到 ${shift}`);
  }
  if (!ctx.registry.by.includes(by)) {
    throw new Reject(`by 必须是 ${ctx.registry.by.join("/")} 之一，收到 ${by}`);
  }
  if (by === "shift" && type.shifts !== "any" && !type.shifts.includes(shift)) {
    const shiftName = (s) => ctx.registry.shiftName(s);
    throw new Reject(`单型 ${type.id}（${type.label}）只允许${type.shifts === "any" ? "任意班" : type.shifts.map(shiftName).join("/")}，不接受${shiftName(shift)}开单`);
  }
  const off = switchProblem(ctx, type);
  if (off) throw new Reject(off);
  const data = input.data ?? {};
  if (data === null || typeof data !== "object" || Array.isArray(data)) throw new Reject("data 必须是 JSON 对象");
  const trial = input.trial || type.defaultTrial || "-"; // 单型声明了 defaultTrial 就不用每张开单都写 --trial
  const key = input.key ?? type.dedupe({ day, type: type.id, trial, title: input.title, data });
  rec.key = key;
  if (typeof key !== "string" || !key) throw new Reject(`单型 ${type.id} 没算出防重复键（补 --key 或修注册表 dedupe）`);
  const states = scanOrders(ctx.daysDir);
  const dup = dedupeProblem(type, key, states);
  if (dup) throw new Reject(dup);
  const cap = capProblem(type, states, day, data, trial);
  if (cap) throw new Reject(cap);
  const seq = states.filter((s) => s.day === day && s.type === type.id).length + 1;
  const order = `${day.replaceAll("-", "")}-${type.id}-${seq}`;
  mkdirSync(dirname(dayFile(ctx.daysDir, day)), { recursive: true });
  const sessionId = input.sessionId ?? ctx.sessionId ?? process.env.LOOP_SESSION_ID;
  appendEvent(dayFile(ctx.daysDir, day), {
    ts: now.toISOString(),
    order,
    event: "open",
    type: type.id,
    trial,
    shift,
    by,
    key,
    title: input.title,
    ...(sessionId ? { sessionId } : {}),
    data,
  });
  return { order, day, type: type.id, key, phase: "todo", phaseLabel: "待做" };
}

/** 账本幂等判同：delivery 看 date+type+url，其余看 date+type+item+pages，都要求 verified=true。
 *  「账本已写、事件未写」的半程状态靠它兜住，重试 done 不翻倍。 */
// shortcut: 判同口径是赚钱循环的两类账本行（delivery=url、其余=item+pages）；第二个循环登记别的 ledgerRow 行型时再泛化
function ledgerRowExists(ctx, row) {
  if (!existsSync(ctx.ledgerFile)) return false;
  return loadLedger(ctx.ledgerFile).some(
    (existing) =>
      existing.date === row.date &&
      existing.type === row.type &&
      existing.verified === true &&
      (row.type === "delivery"
        ? existing.url === row.url
        : (existing.item ?? null) === (row.item ?? null) &&
          JSON.stringify(existing.pages ?? []) === JSON.stringify(row.pages ?? [])),
  );
}

/** 核验通过且单型登记了账本行 → 写一行：ledgerRow="delivery" 走既有 delivery 形状
 *  （date,type,trial,url,title,verified,note），其余走通用合并（data 打底 + --ledger 补丁）。
 *  --ledger json 用来补/覆盖字段，date/type/verified 由单记录钉死不许覆盖。
 *  行类型校验由 ctx.ledgerRows（循环的 validators）在 addLedgerRow 里补。 */
function writeLedgerRow(ctx, state, type, extra) {
  const patch = extra.ledger ?? {};
  let row;
  if (type.ledgerRow === "delivery") {
    const url = patch.url ?? extra.artifacts?.[0] ?? state.artifacts?.[0] ?? state.data?.url;
    if (!url) throw new Reject(`单 ${state.order} 写 delivery 行缺 url：done 时给 --artifacts 或 data.url`);
    row = {
      date: state.day,
      type: "delivery",
      trial: patch.trial ?? state.trial,
      url,
      title: patch.title ?? state.title,
      verified: true,
      note: patch.note ?? "",
    };
  } else {
    row = { ...state.data, ...patch, date: state.day, type: type.ledgerRow, trial: patch.trial ?? state.trial, verified: true };
  }
  if (ledgerRowExists(ctx, row)) return row; // 幂等：上次 done 账本已写、事件没写成，重试不再翻倍
  try {
    return addLedgerRow(ctx.ledgerFile, row, { now: ctx.now(), validators: ctx.ledgerRows });
  } catch (error) {
    throw new Reject(`写账本 ${type.ledgerRow} 行被拒：${error?.message ?? error}（单 ${state.order} 未改阶段）`);
  }
}

/** 推进一张单到下一事件。extra: { reason?, data?, verified?, artifacts?, searches?, ledger? }。
 *  全程持锁：阶段判定与写入之间不再有窗口（两个进程同时 done 只成一个、账本只多一行）。 */
export function transitionOrder(ctx, orderId, event, extra = {}) {
  return withDayLock(ctx.daysDir, () => transitionOrderLocked(ctx, orderId, event, extra));
}

function transitionOrderLocked(ctx, orderId, event, extra = {}) {
  const state = scanOrders(ctx.daysDir).find((s) => s.order === orderId);
  if (!state) throw new Reject(`找不到单：${orderId}（跨天的单留在开单那天的文件里）`);
  const type = ctx.registry.getType(state.type);
  const legal = LEGAL_TRANSITIONS[state.phase] ?? [];
  if (!legal.includes(event)) {
    throw new Reject(
      `非法迁移：单 ${orderId} 现在是「${state.phaseLabel}」，不接受 ${event}` +
        (legal.length ? `（允许：${legal.join("/")}）` : "（已是终态）"),
    );
  }
  if (["fail", "close", "queue"].includes(event) && !(extra.reason ?? "").trim()) {
    throw new Reject(`${event} 必须写 --reason 原因`);
  }
  const verified = event === "done" ? extra.verified === true : undefined;
  if (verified && type?.ledgerRow) writeLedgerRow(ctx, state, type, extra);
  const ev = { ts: ctx.now().toISOString(), order: orderId, event, type: state.type };
  if (extra.reason !== undefined) ev.reason = extra.reason;
  if (extra.data !== undefined) ev.data = extra.data;
  if (verified !== undefined) ev.verified = verified;
  if (extra.artifacts !== undefined) ev.artifacts = extra.artifacts;
  if (extra.searches !== undefined) ev.searches = extra.searches;
  const sessionId = extra.sessionId ?? ctx.sessionId ?? process.env.LOOP_SESSION_ID;
  if (sessionId) ev.sessionId = sessionId;
  appendEvent(dayFile(ctx.daysDir, state.day), ev);
  const phase = PHASE_OF_EVENT[event];
  const result = { order: orderId, phase, phaseLabel: PHASE_LABELS[phase] };
  if (verified !== undefined) result.verified = verified;
  return result;
}

function allowsShift(type, shift) {
  return type.shifts === "any" || type.shifts.includes(shift);
}

/** next 建议分支的可行性检查：suggestable 拿 activeGroups（type.activeGroups(ctx) 给可用
 *  分组值清单，配 caps.perWeekPer 用）与循环经 ctx.suggestExtras 补的参数（如自家台账的
 *  头部清单）；材料拿不到/条件不满足就不建议——宁可漏建议，不要假建议。
 *  没登记 suggestable 的单型只查每日/每周上限。 */
function suggestableNow(ctx, type, states, today) {
  if (!type.suggestable) return capProblem(type, states, today, {}) === null;
  try {
    return (
      type.suggestable({
        ...ctx.suggestExtras,
        type,
        ctx,
        states,
        day: today,
        activeGroups: type.activeGroups?.(ctx),
        capProblem,
        weekOpened,
      }) === true
    );
  } catch {
    return false; // 建议条件的材料坏了（如台账文件坏行）→ 宁可漏建议，不要假建议
  }
}

/** 本班下一张单：优先给已开未领（待做）的单——按单型优先级、先开先领；
 *  没有就按注册表优先级建议本班可开的新单型（只从 selfStart 单型里挑）。
 *  已过滤开关、每日/每周上限、额度、搜索预算。 */
export function nextOrder(ctx, { shift } = {}) {
  const scheduled = ctx.registry.shiftIds.filter((s) => s !== "manual");
  if (!scheduled.includes(shift)) throw new Reject(`next 需要 --shift ${scheduled.join("/")}`);
  const today = localDate(ctx.now());
  const states = scanOrders(ctx.daysDir);
  const off = (type) => switchProblem(ctx, type);

  const pickup = states
    .filter((s) => {
      if (s.phase !== "todo") return false;
      const type = ctx.registry.getType(s.type);
      if (!type || !allowsShift(type, shift) || off(type)) return false;
      if (ctx.quotaFn(s) === null) return false;
      return type.search === 0 || searchUsage(ctx, states, today, s.order) + type.search <= SEARCH_BUDGET;
    })
    .sort((a, b) => (ctx.registry.getType(a.type)?.priority ?? 999) - (ctx.registry.getType(b.type)?.priority ?? 999) || (a.ts ?? "").localeCompare(b.ts ?? ""));
  if (pickup[0]) {
    const type = ctx.registry.getType(pickup[0].type);
    return { order: pickup[0].order, type: type.id, label: type.label, priority: type.priority, title: pickup[0].title };
  }

  const suggestion = [...ctx.registry.types]
    .sort((a, b) => a.priority - b.priority)
    .filter((type) => {
      if (!type.selfStart) return false; // 只建议可自启单型；业务/规划等必须明确 open
      if (!allowsShift(type, shift) || off(type)) return false;
      if (ctx.quotaFn({ day: today, type: type.id, trial: "-", data: {} }) === null) return false;
      if (type.search > 0 && searchUsage(ctx, states, today) + type.search > SEARCH_BUDGET) return false;
      return suggestableNow(ctx, type, states, today);
    })[0];
  if (suggestion) {
    return { order: null, type: suggestion.id, label: suggestion.label, priority: suggestion.priority };
  }
  return { order: null, type: null, reason: "本班无可领的单（班次/开关/上限/额度/搜索预算过滤后为空）" };
}

// —— CLI ——

/** 按配置组 ctx：路径从 config.root 推（<root>/loop/…），deps 可覆盖（测试用临时目录、
 *  注入时间），deps 里其余字段原样落进 ctx（循环给 activeGroups/suggestable 用的材料）。
 *  quotaFn 默认放行。供 shift 与循环脚本复用；CLI 的 main 自己 loadConfig。 */
export function makeCtx(config, deps = {}) {
  const root = deps.root ?? config.root;
  const now = deps.now ?? (() => new Date());
  return {
    ...deps,
    daysDir: deps.daysDir ?? join(root, "loop", "days"),
    switchesDir: deps.switchesDir ?? join(root, "loop", "switches"),
    ledgerFile: deps.ledgerFile ?? join(root, "loop", "ledger.jsonl"),
    registry: createRegistry({ orderTypes: config.orderTypes, shifts: config.shifts, by: config.by }),
    ledgerRows: deps.ledgerRows ?? config.ledgerRows ?? {},
    shiftOf: deps.shiftOf ?? config.shiftOf,
    suggestExtras: deps.suggestExtras ?? config.suggestExtras ?? {},
    quotaFn: deps.quotaFn ?? config.quotaFn ?? (() => "ok"),
    now: typeof now === "function" ? now : () => now,
  };
}

function parseFlags(rest) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    if (!rest[i].startsWith("--")) {
      pos.push(rest[i]);
      continue;
    }
    const key = rest[i].slice(2);
    const value = rest[++i] ?? "";
    if (key === "artifacts") (flags.artifacts ??= []).push(value);
    else flags[key] = value;
  }
  return { pos, flags };
}

function parseJsonFlag(flags, key, fallback) {
  if (flags[key] === undefined) return fallback;
  let value;
  try {
    value = JSON.parse(flags[key]);
  } catch {
    throw new Reject(`--${key} 不是合法 JSON`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Reject(`--${key} 必须是 JSON 对象`);
  return value;
}

function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
}

export async function main(argv, deps = {}) {
  const [cmd, ...rest] = argv;
  const { pos, flags } = parseFlags(rest);
  try {
    const config = await loadConfig(deps.root ?? process.cwd());
    const ctx = makeCtx(config, {
      ...deps,
      daysDir: flags["days-dir"] ?? deps.daysDir,
      switchesDir: flags["switches-dir"] ?? deps.switchesDir,
      ledgerFile: flags.ledgerFile ?? deps.ledgerFile,
    });
    const problems = validateRegistry(ctx.registry);
    if (problems.length > 0) throw new Reject(`单型注册表不合格：${problems.join("；")}`);
    switch (cmd) {
      case "open":
        emit({ ok: true, ...openOrder(ctx, { type: pos[0], title: flags.title, trial: flags.trial, key: flags.key, data: parseJsonFlag(flags, "data", {}), shift: flags.shift, by: flags.by }) });
        return;
      case "start":
      case "resume":
        emit({ ok: true, ...transitionOrder(ctx, pos[0], cmd, { data: parseJsonFlag(flags, "data", undefined) }) });
        return;
      case "needs-you":
      case "needs_you":
        emit({ ok: true, ...transitionOrder(ctx, pos[0], "needs_you", { data: parseJsonFlag(flags, "data", undefined) }) });
        return;
      case "done": {
        let verified = false;
        if (flags.verified !== undefined) {
          if (flags.verified !== "true" && flags.verified !== "false") throw new Reject("--verified 只接受 true 或 false");
          verified = flags.verified === "true";
        }
        let searches;
        if (flags.searches !== undefined) {
          searches = Number(flags.searches);
          if (!Number.isInteger(searches) || searches < 0) throw new Reject("--searches 必须是非负整数");
        }
        emit({
          ok: true,
          ...transitionOrder(ctx, pos[0], "done", {
            verified,
            artifacts: flags.artifacts,
            searches,
            ledger: parseJsonFlag(flags, "ledger", {}),
          }),
        });
        return;
      }
      case "fail":
      case "close":
      case "queue":
        emit({ ok: true, ...transitionOrder(ctx, pos[0], cmd, { reason: flags.reason }) });
        return;
      case "list": {
        const orders = listOrders(ctx, { date: flags.date, phase: flags.phase, type: flags.type });
        emit({ ok: true, count: orders.length, orders });
        return;
      }
      case "next":
        emit({ ok: true, ...nextOrder(ctx, { shift: flags.shift }) });
        return;
      default:
        process.stderr.write(
          "用法: orders open <单型> --title … [--trial --key --data <json> --shift --by] | start|resume|needs-you <单号> [--data <json>]\n" +
            "      orders done <单号> --verified true|false [--artifacts <url>]… [--searches N] [--ledger <json>]\n" +
            "      orders fail|close|queue <单号> --reason … | list [--date --phase --type] | next --shift <班编号>\n",
        );
        process.exitCode = 1;
    }
  } catch (error) {
    if (error instanceof Reject) {
      emit({ ok: false, error: error.message });
      process.exitCode = 2;
      return;
    }
    process.stderr.write(`orders ${cmd ?? ""} 失败: ${error?.message ?? error}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
