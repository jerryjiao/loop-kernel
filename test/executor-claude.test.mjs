// executor-claude.mjs 的测试：spawnFn 全注入假子进程，不起真 claude、不碰真配置目录。
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { claudeCode, countWebSearches } from "../src/executor-claude.mjs";

const tempDirs = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "kern-exec-"));
  tempDirs.push(dir);
  return dir;
};
const savedEnv = {};
const SET_ENV = ["LOOP_SESSION_ID", "LOOP_SHIFT", "LOOP_GUARD_ROOT", "ANTHROPIC_API_KEY", "MY_KEY"];
afterEach(() => {
  for (const k of SET_ENV) {
    if (k in savedEnv) process.env[k] = savedEnv[k];
    else delete process.env[k];
    delete savedEnv[k];
  }
  while (tempDirs.length) rmSync(tempDirs.pop(), { recursive: true, force: true });
});
const setEnv = (k, v) => {
  if (!(k in savedEnv)) savedEnv[k] = process.env[k];
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
};

const CREDS = { baseUrl: "https://gw.example", key: "sk-secret-123", model: "test-model" };
const env = async () => CREDS;

/** 假子进程：stdout/stderr 是 emitter，kill 记录信号；测试自己 emit data/close/error。 */
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kills = [];
  child.kill = (sig) => child.kills.push(sig);
  return child;
}

/** 记录型 spawnFn：记 command/args/opts，假子进程推进 children 供测试重放。 */
function recordingSpawn(log, children) {
  return (command, args, opts) => {
    log.push({ command, args, opts });
    const child = fakeChild();
    children.push(child);
    return child;
  };
}

/** 跑完收尾：emit 一段 stdout JSON（可空）与 stderr，再 close。 */
const finish = (child, { stdout = "", stderr = "", code = 0 } = {}) => {
  if (stdout) child.stdout.emit("data", stdout);
  if (stderr) child.stderr.emit("data", stderr);
  child.emit("close", code);
};

/** run 的 env 回调是异步的：等一拍微任务+宏任务，spawn 一定已发生。 */
const tick = () => new Promise((r) => setImmediate(r));

test("opts 校验：缺 env / 缺 configDir 直接抛", () => {
  assert.throws(() => claudeCode({ configDir: "/c" }), /opts\.env/);
  assert.throws(() => claudeCode({ env }), /opts\.configDir/);
});

test("env 回调返回 null → { skip: \"quota\" }，不 spawn", async () => {
  const log = [];
  const children = [];
  const exec = claudeCode({ env: async () => null, configDir: tempDir(), spawnFn: recordingSpawn(log, children) });
  const r = await exec.run({ cwd: "/w", prompt: "干活", sessionId: "sid", timeoutMs: 1000, shift: "dawn" });
  assert.deepEqual(r, { skip: "quota" });
  assert.equal(log.length, 0);
});

test("正常跑完：参数、白名单 env（全部模型槽位同一个 model、不继承父会话变量）、stdout 解析、stderr 抹 key、searches 数转录", async () => {
  setEnv("LOOP_SESSION_ID", "sid-1");
  setEnv("LOOP_SHIFT", "dawn");
  setEnv("LOOP_GUARD_ROOT", "/w");
  setEnv("ANTHROPIC_API_KEY", "别串台");
  const configDir = tempDir();
  const cwd = "/w";
  const projDir = join(configDir, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(projDir, { recursive: true });
  writeFileSync(
    join(projDir, "s1.jsonl"),
    [
      JSON.stringify({ message: { content: [{ type: "tool_use", name: "WebSearch", input: {} }] } }),
      JSON.stringify({ message: { content: [{ type: "text", text: "提过 WebSearch 这个词不算" }] } }),
      JSON.stringify({ message: { content: [{ type: "tool_use", name: "Bash", input: {} }, { type: "tool_use", name: "WebSearch", input: {} }] } }),
      "坏行不算",
    ].join("\n"),
  );
  const log = [];
  const children = [];
  const exec = claudeCode({ env, configDir, spawnFn: recordingSpawn(log, children) });
  const p = exec.run({ cwd, prompt: "干活", sessionId: "sid-1", timeoutMs: 60_000, shift: "dawn" });
  await tick();
  assert.equal(log.length, 1);
  const { command, args, opts } = log[0];
  assert.equal(command, "claude");
  assert.deepEqual(args, ["-p", "干活", "--output-format", "json", "--dangerously-skip-permissions", "--session-id", "sid-1"]);
  assert.equal(opts.cwd, cwd);
  assert.deepEqual(opts.stdio, ["ignore", "pipe", "pipe"]);
  assert.equal(opts.env.ANTHROPIC_BASE_URL, CREDS.baseUrl);
  assert.equal(opts.env.ANTHROPIC_AUTH_TOKEN, CREDS.key);
  for (const k of ["ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL"]) {
    assert.equal(opts.env[k], CREDS.model, `${k} 指向同一个 model`);
  }
  assert.equal(opts.env.CLAUDE_CONFIG_DIR, configDir);
  assert.equal(opts.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, "64000");
  assert.equal(opts.env.DISABLE_TELEMETRY, "1");
  assert.equal(opts.env.LOOP_SESSION_ID, "sid-1");
  assert.equal(opts.env.LOOP_SHIFT, "dawn");
  assert.equal(opts.env.LOOP_GUARD_ROOT, "/w");
  assert.equal(opts.env.ANTHROPIC_API_KEY, undefined, "父会话的 ANTHROPIC_* 不许串进子进程");
  assert.equal(opts.env.HOME !== undefined || opts.env.PATH !== undefined, true, "白名单基底变量透传");
  finish(children[0], {
    stdout: `${JSON.stringify({ session_id: "s1", result: "干完了" })}\n`,
    stderr: `boom ${CREDS.key} tail`,
    code: 0,
  });
  const r = await p;
  assert.equal(r.code, 0);
  assert.equal(r.timedOut, false);
  assert.equal(r.json.session_id, "s1");
  assert.equal(r.json.result, "干完了");
  assert.equal(r.stderr.includes(CREDS.key), false, "stderr 抹掉 key");
  assert.match(r.stderr, /boom <KEY> tail/);
  assert.equal(r.row.searches, 2, "数转录里 WebSearch tool_use 的次数（按回传的 session_id 找转录）");
});

test("非 JSON stdout → json:null；不回 session_id 用预先定的号数转录", async () => {
  const configDir = tempDir();
  const cwd = "/w";
  const projDir = join(configDir, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(projDir, { recursive: true });
  writeFileSync(join(projDir, "preset.jsonl"), `${JSON.stringify({ message: { content: [{ type: "tool_use", name: "WebSearch", input: {} }] } })}\n`);
  const log = [];
  const children = [];
  const exec = claudeCode({ env, configDir, spawnFn: recordingSpawn(log, children) });
  const p = exec.run({ cwd, prompt: "干活", sessionId: "preset", timeoutMs: 60_000, shift: "dawn" });
  await tick();
  finish(children[0], { stdout: "不是 JSON\n", code: 1 });
  const r = await p;
  assert.equal(r.code, 1);
  assert.equal(r.json, null);
  assert.equal(r.row.searches, 1, "转录按预先定的会话号找");
});

test("可选参数：appendSystemPrompt / disallowedTools / settings 进参数；passEnv 可换名单；maxOutputTokens 可改", async () => {
  setEnv("MY_KEY", "yes");
  setEnv("LOOP_SHIFT", undefined);
  const log = [];
  const children = [];
  const exec = claudeCode({
    env,
    configDir: tempDir(),
    appendSystemPrompt: "你是某循环的班",
    disallowedTools: ["Bash", "WebFetch"],
    settings: "/s/hooks.json",
    passEnv: ["MY_KEY"],
    maxOutputTokens: "1000",
    spawnFn: recordingSpawn(log, children),
  });
  const p = exec.run({ cwd: "/w", prompt: "干活", sessionId: "sid", timeoutMs: 60_000, shift: "dawn" });
  await tick();
  assert.deepEqual(
    log[0].args,
    ["-p", "干活", "--output-format", "json", "--dangerously-skip-permissions", "--append-system-prompt", "你是某循环的班", "--disallowedTools", "Bash", "WebFetch", "--settings", "/s/hooks.json", "--session-id", "sid"],
  );
  assert.equal(log[0].opts.env.MY_KEY, "yes");
  assert.equal(log[0].opts.env.LOOP_SHIFT, undefined, "换了 passEnv 名单就不再透传默认的");
  assert.equal(log[0].opts.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, "1000");
  finish(children[0]);
  await p;
});

test("json.result 里的 key 抹成 <KEY>；key 为空串或不是字符串时不抹", async () => {
  const log = [];
  const children = [];
  const exec = claudeCode({ env, configDir: tempDir(), spawnFn: recordingSpawn(log, children) });
  const p = exec.run({ cwd: "/w", prompt: "干活", sessionId: "sid", timeoutMs: 60_000, shift: "dawn" });
  await tick();
  finish(children[0], { stdout: `${JSON.stringify({ session_id: "s1", result: `回显了 ${CREDS.key} 一段`, note: CREDS.key })}\n` });
  const r = await p;
  assert.equal(r.json.result, "回显了 <KEY> 一段");
  assert.equal(r.json.note, CREDS.key, "只抹 result，别的字符串字段不动");
  assert.equal(JSON.stringify(r.json).split(CREDS.key).length - 1, 1);

  for (const key of ["", 0]) {
    const kids = [];
    const exec2 = claudeCode({ env: async () => ({ ...CREDS, key }), configDir: tempDir(), spawnFn: recordingSpawn([], kids) });
    const p2 = exec2.run({ cwd: "/w", prompt: "干活", sessionId: "sid", timeoutMs: 60_000, shift: "dawn" });
    await tick();
    finish(kids[0], { stdout: `${JSON.stringify({ result: "原文不动" })}\n` });
    assert.equal((await p2).json.result, "原文不动");
  }
});

test("不传 sessionId 就不带 --session-id 参数", async () => {
  const log = [];
  const children = [];
  const exec = claudeCode({ env, configDir: tempDir(), spawnFn: recordingSpawn(log, children) });
  const p = exec.run({ cwd: "/w", prompt: "干活", timeoutMs: 60_000, shift: "dawn" });
  await tick();
  assert.equal(log[0].args.includes("--session-id"), false);
  finish(children[0]);
  const r = await p;
  assert.equal(r.row.searches, null);
});

test("超时 → SIGTERM、timedOut:true；spawn 失败（error 事件）→ code:-1 兜住", async () => {
  const log = [];
  const children = [];
  const exec = claudeCode({ env, configDir: tempDir(), spawnFn: recordingSpawn(log, children) });
  const p = exec.run({ cwd: "/w", prompt: "干活", sessionId: "sid", timeoutMs: 20, shift: "dawn" });
  await tick();
  await new Promise((done) => setTimeout(done, 40));
  assert.deepEqual(children[0].kills, ["SIGTERM"]);
  finish(children[0], { code: null });
  const r = await p;
  assert.equal(r.timedOut, true);

  const log2 = [];
  const children2 = [];
  const exec2 = claudeCode({ env, configDir: tempDir(), spawnFn: recordingSpawn(log2, children2) });
  const p2 = exec2.run({ cwd: "/w", prompt: "干活", sessionId: "sid", timeoutMs: 60_000, shift: "dawn" });
  await tick();
  children2[0].emit("error", new Error("spawn claude ENOENT"));
  const r2 = await p2;
  assert.equal(r2.code, -1);
  assert.equal(r2.json, null);
  assert.match(r2.stderr, /ENOENT/);
  assert.equal(r2.stderr.includes(CREDS.key), false);
  assert.equal(r2.row.searches, null);
});

test("countWebSearches：数转录里的 WebSearch tool_use，文件缺失/无会话 id → null", () => {
  const configDir = tempDir();
  const cwd = "/some/workspace";
  const projDir = join(configDir, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(projDir, { recursive: true });
  writeFileSync(
    join(projDir, "s1.jsonl"),
    [
      JSON.stringify({ message: { content: [{ type: "tool_use", name: "WebSearch", input: { query: "a" } }] } }),
      JSON.stringify({ message: { content: [{ type: "text", text: "提过 WebSearch 这个词不算" }] } }),
      JSON.stringify({ message: { content: [{ type: "tool_use", name: "Bash", input: {} }, { type: "tool_use", name: "WebSearch", input: { query: "b" } }] } }),
      "坏行不算",
    ].join("\n"),
  );
  assert.equal(countWebSearches(configDir, cwd, "s1"), 2);
  assert.equal(countWebSearches(configDir, cwd, "missing"), null);
  assert.equal(countWebSearches(configDir, cwd, null), null);
});
