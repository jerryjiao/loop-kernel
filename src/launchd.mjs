// 循环宿主的 launchd 侧：一个定时任务一个闹钟（<launchdPrefix>.task.<id>），每小时整点
// 叫醒内核的 src/shift.mjs --task <id>。跑不跑、跑哪班由 shift.mjs 按配置时区查登记表决定
// （Mac 本机时区随出行变，不能拿本机时刻表当班次表）。任务清单不在模块加载时读登记表
// （内核不知道循环的根在哪）：agentsFor(config, tasks) 由 on/off/status 现读现组。
// plist 由本脚本生成；外部命令（launchctl）一律 spawn 参数数组、可注入——测试绝不真调、
// 不写真实 ~/Library。

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadConfig } from "./config.mjs";
import { loadTasks } from "./scheduled-tasks.mjs";
import { lastShiftRow } from "./shift.mjs";

// 默认叫醒内核自己的班入口（本文件在 src/ 下）
const SHIFT_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "shift.mjs");
const DEFAULT_EXTRA_PATH = ["/opt/homebrew/bin", "/usr/local/bin"];

/** 每小时整点，24 条同值——launchd 允许字典只带部分字段。这是本机验证过能每小时触发的写法。 */
const HOURLY = Array.from({ length: 24 }, () => ({ Minute: 0 }));

/** 一个任务一个 agent。label = `<launchdPrefix>.task.<id>`。 */
export function agentsFor(config, tasks) {
  return tasks.map((task) => ({
    id: task.id,
    label: `${config.launchdPrefix}.task.${task.id}`,
    args: ["--task", task.id],
    calendar: HOURLY,
  }));
}

const XML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };
const escapeXml = (value) => String(value).replace(/[&<>"']/g, (ch) => XML_ESCAPES[ch]);

/** 渲染 LaunchAgent plist。nodePath 取安装时的 process.execPath（launchd 不继承 shell 的
 *  PATH，node 必须绝对路径）；会话要用的外部命令在 extraPath 里补。 */
export function renderPlist({ label, nodePath, scriptPath, args, logFile, env = {}, home = homedir(), calendar = HOURLY }) {
  const dict = (entry) =>
    `      <dict>\n${Object.entries(entry)
      .map(([k, v]) => `        <key>${k}</key>\n        <integer>${v}</integer>`)
      .join("\n")}\n      </dict>`;
  const envDict = Object.entries(env)
    .map(([k, v]) => `    <key>${escapeXml(k)}</key>\n    <string>${escapeXml(v)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(nodePath)}</string>
    <string>${escapeXml(scriptPath)}</string>
${args.map((a) => `    <string>${escapeXml(a)}</string>`).join("\n")}
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(home)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${envDict}
  </dict>
  <key>StartCalendarInterval</key>
  <array>
${calendar.map(dict).join("\n")}
  </array>
  <key>StandardOutPath</key>
  <string>${escapeXml(logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(logFile)}</string>
</dict>
</plist>
`;
}

/** 某时刻之后这个 calendar 项的下一次触发（本地时间）；只带 Minute 的项 = 每小时整点。 */
function nextFireOf({ Weekday, Hour, Minute }, now) {
  for (let i = 0; i < 8; i++) {
    for (const h of Hour === undefined ? [...Array(24).keys()] : [Hour]) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i, h, Minute, 0, 0);
      if (d <= now) continue;
      if (Weekday === undefined || d.getDay() === (Weekday % 7)) return d;
    }
  }
  return null;
}

/** 下一次触发时间：calendar 各项取最近。没有匹配（不会发生）返回 null。 */
export function nextFire(calendar, now) {
  const fires = calendar.map((c) => nextFireOf(c, now)).filter(Boolean);
  return fires.length ? fires.reduce((a, b) => (a < b ? a : b)) : null;
}

/** 默认起子进程：stdin ignore（launchctl 不读 stdin，没有 EPIPE 风险）。 */
function defaultSpawn({ command, args, stdio = "pipe" }) {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { stdio: stdio === "pipe" ? ["ignore", "pipe", "pipe"] : stdio });
    let stdout = "";
    let stderr = "";
    if (child.stdout) child.stdout.on("data", (chunk) => { stdout += chunk; });
    if (child.stderr) child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", fail);
    child.on("close", (code) => done({ code, stdout, stderr }));
  });
}

/** 各路径与外部命令的注入点；config/tasks 缺省从 cwd 读。 */
async function resolveDeps(deps = {}) {
  const config = deps.config ?? (await loadConfig(deps.root ?? process.cwd()));
  const tasks = deps.tasks ?? loadTasks(config.root);
  const home = deps.home ?? homedir();
  const nodePath = deps.nodePath ?? process.execPath;
  // launchd 只给 /usr/bin:/bin；会话里的外部命令多半在 node 同目录或 Homebrew 下
  const PATH = [dirname(nodePath), ...(config.extraPath ?? DEFAULT_EXTRA_PATH), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");
  return {
    config,
    agents: agentsFor(config, tasks),
    home,
    nodePath,
    scriptPath: deps.scriptPath ?? SHIFT_SCRIPT,
    env: { PATH, LOOP_CWD: config.root },
    plistDir: deps.plistDir ?? join(home, "Library", "LaunchAgents"),
    logsDir: deps.logsDir ?? join(config.loopHome, "logs"),
    launchctlPath: deps.launchctlPath ?? "/bin/launchctl",
    uid: deps.uid ?? process.getuid(),
    spawnFn: deps.spawnFn ?? defaultSpawn,
    now: deps.now ?? new Date(),
    logFn: deps.logFn ?? ((...args) => console.log(...args)),
  };
}

/** bootout 一个 label 并删它的 plist。没装过（bootout 非零、plist 不在）不算错。 */
async function unload(d, label) {
  await d.spawnFn({ command: d.launchctlPath, args: ["bootout", `gui/${d.uid}/${label}`], stdio: "ignore" });
  rmSync(join(d.plistDir, `${label}.plist`), { force: true });
}

/** on：写各 agent 的 plist → bootout（已加载才有效，未加载报错属预期）→ bootstrap。 */
export async function loopOn(deps = {}) {
  const d = await resolveDeps(deps);
  mkdirSync(d.plistDir, { recursive: true });
  mkdirSync(d.logsDir, { recursive: true });
  const results = [];
  for (const agent of d.agents) {
    const plistPath = join(d.plistDir, `${agent.label}.plist`);
    const logFile = join(d.logsDir, `task-${agent.id}.log`);
    writeFileSync(plistPath, renderPlist({ label: agent.label, nodePath: d.nodePath, scriptPath: d.scriptPath, args: agent.args, logFile, env: d.env, home: d.home }));
    await d.spawnFn({ command: d.launchctlPath, args: ["bootout", `gui/${d.uid}/${agent.label}`], stdio: "ignore" });
    const bootstrap = await d.spawnFn({ command: d.launchctlPath, args: ["bootstrap", `gui/${d.uid}`, plistPath], stdio: "pipe" });
    if (bootstrap.code !== 0) throw new Error(`launchctl bootstrap ${agent.label} 失败（exit ${bootstrap.code}）：${bootstrap.stderr.trim()}`);
    results.push({ label: agent.label, plistPath, args: agent.args });
  }
  for (const r of results) d.logFn(`已装 ${r.label}（${r.args.join(" ")}）→ ${r.plistPath}`);
  return results;
}

/** off：卸掉各任务的 agent。登录后不再有闹钟，直到下次 on。 */
export async function loopOff(deps = {}) {
  const d = await resolveDeps(deps);
  for (const agent of d.agents) await unload(d, agent.label);
  d.logFn(`循环宿主已关闭（${d.agents.length} 个 agent 已卸载、plist 已删；重新打开：launchd.mjs on）`);
}

/** status：只读。每个 agent 是否已装（launchctl print 是否找得到）、下次触发、最近一条 shifts 记录。 */
export async function loopStatus(deps = {}) {
  const d = await resolveDeps(deps);
  const pad = (v) => String(v).padStart(2, "0");
  // launchd 按本机时钟触发，「下次触发」也按本机时间显示（圈日才用配置时区）
  const ymd = (dt) => `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
  const agents = [];
  for (const agent of d.agents) {
    let loaded = false;
    try {
      loaded = (await d.spawnFn({ command: d.launchctlPath, args: ["print", `gui/${d.uid}/${agent.label}`], stdio: "ignore" })).code === 0;
    } catch {
      loaded = false;
    }
    const fire = nextFire(agent.calendar, d.now);
    agents.push({
      id: agent.id,
      label: agent.label,
      loaded,
      plistExists: existsSync(join(d.plistDir, `${agent.label}.plist`)),
      nextFire: fire ? `${ymd(fire)} ${pad(fire.getHours())}:${pad(fire.getMinutes())}` : null,
    });
  }
  return { agents, lastShift: lastShiftRow(d.config.root, { now: d.now }) };
}

/** CLI 入口：从 cwd 读配置。返回退出码（0 成功），便于测试断言与 shell 使用。 */
export async function main(argv, deps = {}) {
  const [command] = argv;
  const logErr = deps.logErrFn ?? ((...args) => console.error(...args));
  try {
    if (command === "on") {
      await loopOn(deps);
      return 0;
    }
    if (command === "off") {
      await loopOff(deps);
      return 0;
    }
    if (command === "status") {
      const s = await loopStatus(deps);
      for (const a of s.agents) {
        (deps.logFn ?? ((...args) => console.log(...args)))(
          `${a.label}：${a.loaded ? "已装" : "未装"}${a.plistExists ? "" : "（plist 不存在）"}，下次触发 ${a.nextFire ?? "—"}`,
        );
      }
      (deps.logFn ?? ((...args) => console.log(...args)))(
        `最近一班：${s.lastShift ? `${s.lastShift.shift} 班 ${s.lastShift.start} exit=${s.lastShift.exit}${s.lastShift.skipped ? ` skipped=${s.lastShift.skipped}` : ""}` : "无记录"}`,
      );
      return 0;
    }
    logErr("用法：node launchd.mjs on | off | status");
    return 1;
  } catch (error) {
    logErr(`launchd ${command ?? ""} 失败：${error?.message ?? error}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
