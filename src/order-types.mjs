// 单型注册表框架：一种单的登记规矩——哪班能做、算不算交付物、防重复键、每天/每周上限、
// 搜索估值、「等你」超时收尾、总开关、next 能不能建议新开（selfStart）。上限/防重复/开关
// 由 orders.mjs（唯一写入口）按注册表强制，这里只有数据与纯函数；内核不认识任何具体业务，
// 每个循环在 loop.config.mjs 的 orderTypes 里登记自己的单型，班次编号与班名由 shifts 声明
// （内核只追加 "manual"，人工关卡类单型用）。
// dedupe 收到开单草稿 { day, type, trial, title, data }，返回防重复键；键里带圈日的，
// 天然不挡隔天的同型单。

export const MANUAL_SHIFT = "manual";

/** 圈日所在的 ISO 周（周一起）：按周防重复的单型用（dedupe: (d) => `x:${weekOf(d.day)}`）。 */
export function weekOf(day) {
  const date = new Date(`${day}T00:00:00Z`);
  const monday = new Date(date);
  monday.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return monday.toISOString().slice(0, 10);
}

/** 按圈日算防重复键的 dedupe 帮手：byDay("patrol")(draft) = "patrol:<圈日>"。 */
export const byDay = (prefix) => (draft) => `${prefix}:${draft.day}`;

// 注册表统一补默认值与开关路径（switch 只是声明，真正的开关检查在 orders.mjs 按 id 找文件）；
// 声明里 switch 为 null 的人工关卡类保持 null，不落 .off 路径。
const DEFAULTS = { shifts: "any", deliverable: false, ledgerRow: null, center: null, caps: {}, search: 0, quota: "support", selfStart: false };

/** 组注册表：types 补默认值；shiftIds = 循环声明的班编号 + "manual"；shiftName 给显示用
 *  班名；by = 单的处理人取值清单（openOrder 校验用）。 */
export function createRegistry({ orderTypes, shifts, by }) {
  const types = orderTypes.map((spec) => ({
    ...DEFAULTS,
    ...spec,
    caps: { ...spec.caps },
    switch: "switch" in spec ? spec.switch : `loop/switches/${spec.id}.off`,
  }));
  const shiftIds = [...Object.keys(shifts ?? {}), MANUAL_SHIFT];
  return {
    types,
    getType: (id) => types.find((t) => t.id === id) ?? null,
    shiftIds,
    shiftName: (id) => shifts?.[id]?.name ?? (id === MANUAL_SHIFT ? "手动" : `${id} 班`),
    by,
  };
}

/** 内置拍板单型：账本 question 行 ↔ 拍板单的同步（decision-sync.mjs）只认它，循环把它放进
 *  自己的 orderTypes 才启用拍板同步。switch 为 null：开关挡不住等人的事，48 小时后会静默
 *  按默认执行。 */
export const DECISION_TYPE = {
  id: "decision",
  center: null,
  label: "拍板",
  shifts: [MANUAL_SHIFT],
  priority: 5,
  switch: null,
  dedupe: (draft) => `decision:${draft.data.question}`,
  quota: "business",
  needsYou: { timeoutHours: 48, onTimeout: "default" }, // 48h 默认；不可逆题永不（category 在 neverDefaultCategories 里）
  verify: "账本 decision 行",
};

/** 注册表自检：启动/测试时跑一遍，返回问题清单（空数组 = 合格）。center/quota/ledgerRow
 *  只查字符串或 null，取值由循环自己约定。 */
export function validateRegistry(registry) {
  const problems = [];
  const seen = new Set();
  for (const t of registry.types) {
    const where = t.id ?? "<缺 id>";
    if (!t.id) problems.push("有单型缺 id");
    if (seen.has(t.id)) problems.push(`重复单型：${t.id}`);
    seen.add(t.id);
    if (!t.label) problems.push(`${where} 缺 label`);
    if (t.shifts !== "any" && !(Array.isArray(t.shifts) && t.shifts.length > 0 && t.shifts.every((s) => registry.shiftIds.includes(s)))) {
      problems.push(`${where} shifts 必须是 "any" 或 ${registry.shiftIds.join("/")} 的非空子集`);
    }
    if (typeof t.priority !== "number") problems.push(`${where} priority 必须是数字`);
    if (typeof t.deliverable !== "boolean") problems.push(`${where} deliverable 必须是布尔`);
    if (!(t.ledgerRow === null || typeof t.ledgerRow === "string")) problems.push(`${where} ledgerRow 必须是字符串或 null`);
    if (!(t.center === null || typeof t.center === "string")) problems.push(`${where} center 必须是字符串或 null`);
    if (typeof t.dedupe !== "function") problems.push(`${where} 缺 dedupe 函数`);
    if (!(t.quota === null || typeof t.quota === "string")) problems.push(`${where} quota 必须是字符串或 null`);
    if (typeof t.search !== "number" || t.search < 0) problems.push(`${where} search 必须是非负数字`);
    if (typeof t.selfStart !== "boolean") problems.push(`${where} selfStart 必须是布尔`);
    if (t.switch !== null && (typeof t.switch !== "string" || !t.switch.endsWith(".off"))) {
      problems.push(`${where} switch 路径必须是 <id>.off 或 null（人工关卡类）`);
    }
    if ("suggestable" in t && typeof t.suggestable !== "function") problems.push(`${where} suggestable 必须是函数`);
    if ("activeGroups" in t && typeof t.activeGroups !== "function") problems.push(`${where} activeGroups 必须是函数`);
    if (typeof t.verify !== "string" || !t.verify) problems.push(`${where} 缺 verify 说明指针`);
    for (const key of ["perDay", "perWeek"]) {
      const v = t.caps?.[key];
      if (v !== undefined && (!Number.isInteger(v) || v < 1)) problems.push(`${where} caps.${key} 必须是正整数`);
    }
    for (const key of ["perWeekPer", "perDayPer"]) {
      if (t.caps?.[key] !== undefined && typeof t.caps[key] !== "string") {
        problems.push(`${where} caps.${key} 必须是分组字段名（data 字段或 trial）`);
      }
    }
    if (t.needsYou) {
      const { timeoutHours, onTimeout } = t.needsYou;
      if (!(timeoutHours === null || (typeof timeoutHours === "number" && timeoutHours > 0))) {
        problems.push(`${where} needsYou.timeoutHours 必须是正数或 null`);
      }
      if (!["default", "withdraw", null].includes(onTimeout ?? null)) {
        problems.push(`${where} needsYou.onTimeout 必须是 default/withdraw/null`);
      }
    }
  }
  return problems;
}
