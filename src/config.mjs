// 配置加载器：内核不认识任何业务，循环的全部差异都在 <root>/loop.config.mjs 里
// （契约见 docs/config.md）。这里只查必填缺失和类型不对，问题列出来让循环自己修，
// 不替它猜。字段与默认值以 docs/config.md 为准。

import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { getTimezone, setTimezone } from "./dates.mjs";

const KIND_CHECK = {
  string: (v) => typeof v === "string",
  function: (v) => typeof v === "function",
  array: Array.isArray,
  object: (v) => typeof v === "object" && v !== null && !Array.isArray(v),
};
const KIND_LABEL = { string: "字符串", function: "函数", array: "数组", object: "对象" };
const FIELD_KINDS = [
  ["root", "string", false],
  ["timezone", "string", false],
  ["loopHome", "string", true],
  ["launchdPrefix", "string", true],
  ["extraPath", "array", false],
  ["shifts", "object", true],
  ["by", "array", false],
  ["orderTypes", "array", true],
  ["ledgerRows", "object", false],
  ["prompt", "function", true],
  ["executor", "object", true],
  ["beforeShift", "function", false],
  ["afterShift", "function", false],
  ["notify", "function", false],
];

/** 校验配置：返回问题列表，空数组 = 合格。只查必填缺失与类型不对（含 shifts 里
 *  alwaysRun、timeLimitMin 的类型），不做别的。 */
export function validateConfig(cfg) {
  if (!KIND_CHECK.object(cfg)) return ["配置必须是对象"];
  const problems = [];
  for (const [field, kind, required] of FIELD_KINDS) {
    if (cfg[field] === undefined) {
      if (required) problems.push(`${field} 缺失`);
    } else if (!KIND_CHECK[kind](cfg[field])) {
      problems.push(`${field} 必须是${KIND_LABEL[kind]}`);
    }
  }
  if (KIND_CHECK.object(cfg.shifts)) {
    for (const [id, shift] of Object.entries(cfg.shifts)) {
      if (!KIND_CHECK.object(shift)) {
        problems.push(`shifts.${id} 必须是对象`);
        continue;
      }
      if (typeof shift.alwaysRun !== "boolean") problems.push(`shifts.${id}.alwaysRun 必须是布尔`);
      if (typeof shift.timeLimitMin !== "number") problems.push(`shifts.${id}.timeLimitMin 必须是数字`);
    }
  }
  return problems;
}

/**
 * 读 `<root>/loop.config.mjs` 的 default 导出，校验、补默认值，按 config.timezone
 * 设圈日时区，返回冻结的配置对象。不合格抛 Error，错误信息把问题列全。
 */
export async function loadConfig(root) {
  const mod = await import(pathToFileURL(join(root, "loop.config.mjs")).href);
  const cfg = mod.default;
  const problems = validateConfig(cfg);
  if (problems.length > 0) throw new Error(`loop.config.mjs 不合格：\n${problems.join("\n")}`);
  const config = {
    root,
    timezone: getTimezone(), // 默认时区只在 dates.mjs 存一份
    by: ["shift", "manual"],
    ledgerRows: {},
    extraPath: ["/opt/homebrew/bin", "/usr/local/bin"],
    ...cfg,
  };
  setTimezone(config.timezone);
  return Object.freeze(config);
}
