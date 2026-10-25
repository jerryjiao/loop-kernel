// Claude Code 无头执行器适配器：循环在 loop.config.mjs 的 executor 字段接自己的
// 网关、key 与模型（env 回调现取，返回 null = 本班没额度，shift 记 skipped:quota 收工）。
// 内核不认识任何网关：baseUrl/key/model 全部来自 env 回调，取 key 的路子（环境变量、
// 钥匙串、配置文件）由循环自己定。countWebSearches 也搬到这里——run 收尾顺手数本班
// 联网搜索次数，经 row.searches 合并进班记录。

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// env 白名单基底：不展开 process.env，防父会话的 ANTHROPIC_*、CLAUDE_CODE_* 等变量串台。
const BASE_ENV_KEYS = ["PATH", "HOME", "USER", "LANG", "SHELL", "TMPDIR", "TERM"];
const DEFAULT_PASS_ENV = ["LOOP_SESSION_ID", "LOOP_SHIFT", "LOOP_GUARD_ROOT"];

/** 数一次会话跑了几次联网搜索：claude 的会话转录在 CLAUDE_CONFIG_DIR/projects/<路径粉碎>/<会话id>.jsonl，
 *  数 WebSearch 的 tool_use 块。转录不在/读不了 → null（只影响统计，不算失败）。 */
export function countWebSearches(configDir, cwd, sessionId, { readImpl = readFileSync } = {}) {
  if (!sessionId || typeof sessionId !== "string") return null;
  const file = join(configDir, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${sessionId}.jsonl`);
  let text;
  try {
    text = readImpl(file, "utf8");
  } catch {
    return null;
  }
  let count = 0;
  for (const line of text.split("\n")) {
    if (!line.includes('"WebSearch"')) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const content = row?.message?.content;
    if (Array.isArray(content)) {
      for (const block of content) if (block?.type === "tool_use" && block?.name === "WebSearch") count++;
    }
  }
  return count;
}

// 子进程万一回显 key，进 stderr 前抹掉。
function redact(text, keys) {
  if (text == null) return text;
  let out = String(text);
  for (const k of keys) if (k) out = out.split(k).join("<KEY>");
  return out;
}

/** 组执行器。opts：env（必填）、configDir（必填，CLAUDE_CONFIG_DIR，循环自定）、
 *  appendSystemPrompt / disallowedTools / settings（可选透传给 claude CLI）、
 *  passEnv（额外透传的环境变量名，只在已设时透传）、maxOutputTokens（默认 "64000"）、
 *  spawnFn（测试注入）。 */
export function claudeCode(opts = {}) {
  if (typeof opts.env !== "function") throw new Error("claudeCode 需要 opts.env: async ({ shift }) => ({ baseUrl, key, model }) | null");
  if (typeof opts.configDir !== "string" || !opts.configDir) throw new Error("claudeCode 需要 opts.configDir（CLAUDE_CONFIG_DIR）");
  const passEnv = opts.passEnv ?? DEFAULT_PASS_ENV;
  const maxOutputTokens = opts.maxOutputTokens ?? "64000";
  return {
    async run({ cwd, prompt, sessionId, timeoutMs, shift }) {
      const creds = await opts.env({ shift });
      if (!creds) return { skip: "quota" };
      mkdirSync(opts.configDir, { recursive: true, mode: 0o700 });
      const env = {};
      for (const k of BASE_ENV_KEYS) if (process.env[k] !== undefined) env[k] = process.env[k];
      for (const k of passEnv) if (process.env[k] !== undefined) env[k] = process.env[k];
      Object.assign(env, {
        CLAUDE_CONFIG_DIR: opts.configDir,
        ANTHROPIC_BASE_URL: creds.baseUrl,
        ANTHROPIC_AUTH_TOKEN: creds.key,
        // 所有模型槽位指向同一个 model：claude 内部换档（子代理/压缩）也不许绕开网关路由
        ANTHROPIC_MODEL: creds.model,
        ANTHROPIC_DEFAULT_OPUS_MODEL: creds.model,
        ANTHROPIC_DEFAULT_SONNET_MODEL: creds.model,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: creds.model,
        CLAUDE_CODE_SUBAGENT_MODEL: creds.model,
        CLAUDE_CODE_MAX_OUTPUT_TOKENS: maxOutputTokens,
        DISABLE_TELEMETRY: "1",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      });
      const args = ["-p", prompt, "--output-format", "json", "--dangerously-skip-permissions"];
      if (opts.appendSystemPrompt !== undefined) args.push("--append-system-prompt", opts.appendSystemPrompt);
      if (Array.isArray(opts.disallowedTools) && opts.disallowedTools.length > 0) args.push("--disallowedTools", ...opts.disallowedTools);
      if (opts.settings !== undefined) args.push("--settings", opts.settings);
      if (sessionId) args.push("--session-id", sessionId);
      return await new Promise((done) => {
        const child = (opts.spawnFn ?? spawn)("claude", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "", stderr = "", timedOut = false, settled = false;
        child.stdout.on("data", (d) => (stdout += d));
        child.stderr.on("data", (d) => (stderr += d));
        const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, timeoutMs);
        const finish = (v) => { if (!settled) { settled = true; clearTimeout(timer); done(v); } };
        // claude 没装等 spawn 失败只触发 error 不触发 close，两路都兜住。
        child.on("error", (err) =>
          finish({ code: -1, json: null, stderr: redact(stderr + String(err), [creds.key]), timedOut, row: { searches: null } }));
        child.on("close", (code) => {
          let json = null;
          try { json = JSON.parse(stdout); } catch { /* 非 JSON 输出按失败处理 */ }
          const sid = (typeof json?.session_id === "string" && json.session_id) || sessionId || null;
          finish({
            code,
            timedOut,
            json,
            stderr: redact(stderr, [creds.key]),
            row: { searches: countWebSearches(opts.configDir, cwd, sid) },
          });
        });
      });
    },
  };
}
