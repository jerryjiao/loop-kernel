// 「今天是几号」一律按配置时区算，不依赖系统时区：定时任务按 Mac 系统时区触发，
// Mac 出行切时区会让同一圈日跑两圈（2026-10-16 实证），落账/简报/判空转的日期必须
// 钉在一个时区上。默认 Asia/Shanghai，循环在 loop.config.mjs 的 timezone 里改。
// date 字符串的加减与差值用纯日历算术，不经任何时区。

let timezone = "Asia/Shanghai";

// en-CA 的 date 样式天然是 YYYY-MM-DD；formatter 只建一次（Intl 格式化开销大），换时区才重建。
const makeDateFmt = (tz) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
let dateFmt = makeDateFmt(timezone);

/** 换圈日时区。非法时区让 Intl 直接抛（不静默回退），抛错时原时区不动。 */
export function setTimezone(tz) {
  new Intl.DateTimeFormat("en-CA", { timeZone: tz });
  if (tz === timezone) return;
  timezone = tz;
  dateFmt = makeDateFmt(tz);
}

export function getTimezone() {
  return timezone;
}

export function localDate(date) {
  return dateFmt.format(date);
}

/** date 字符串 ±n 天 → 新 date 字符串（纯日历算术，不经任何时区）。 */
export function addDaysStr(dateStr, n) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  const pad = (v) => String(v).padStart(2, "0");
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** 两个 date 字符串的天数差（a-b），与时区无关。 */
export function diffDays(a, b) {
  return Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000);
}
