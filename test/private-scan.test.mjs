// 私人信息扫描：这仓库要开源，私人信息进了提交历史就得改写历史才清得掉，
// 所以每次 npm test 把被跟踪文件全量扫一遍，命中一处即失败，报 文件:行号 + 规则名。
// 两层：通用规则内置在本文件（开源也无妨）；私人词表只在运行时从
// LOOP_KERNEL_DENYLIST（默认 ~/.config/loop-kernel/denylist.txt）读，内容不进仓库。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = relative(ROOT, fileURLToPath(import.meta.url));

// 「绝对路径」要求 /Users、/home 前面不是单词字符，免得 /fake/home/x 这类仿造路径误报。
const RULES = [
  ["邮箱地址", /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, (m) =>
    !/(?:@users\.noreply\.github\.com|@example\.com)$/i.test(m[0])],
  ["本机绝对路径", /(?:^|[^\w/])\/(?:Users|home)\/[^\s/]+/g],
  ["sk- 密钥", /sk-[A-Za-z0-9_-]{20,}/g],
  ["ghp_ token", /ghp_[A-Za-z0-9]{20,}/g],
];

function tracked() {
  const out = spawnSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(out.status, 0, `git ls-files 失败：${out.error ?? out.stderr}`);
  return out.stdout.split("\0").filter(Boolean);
}

// 逐文件读文本、逐行过一遍规则，返回 ["文件:行号 规则名", ...]。正则迭代用 matchAll。
function scanLayer(lineRules) {
  const hits = [];
  for (const rel of tracked()) {
    if (rel === SELF) continue; // 跳过本文件：规则正则的字面文本会命中自己
    const lines = readFileSync(join(ROOT, rel), "utf8").split("\n");
    lines.forEach((line, i) => {
      for (const rule of lineRules(line)) hits.push(`${rel}:${i + 1} ${rule}`);
    });
  }
  return hits;
}

test("通用规则：邮箱/本机绝对路径/sk-密钥/ghp_ token 不得进仓库", () => {
  const hits = scanLayer((line) => {
    const found = [];
    for (const [name, re, allow] of RULES) {
      for (const m of line.matchAll(re)) {
        if (!allow || allow(m)) { found.push(name); break; }
      }
    }
    return found;
  });
  assert.ok(hits.length === 0, `发现私人信息（文件:行号 规则）：\n${hits.join("\n")}`);
});

test("私人词：denylist 词表里的词不得进仓库", (t) => {
  const file = process.env.LOOP_KERNEL_DENYLIST ||
    join(homedir(), ".config", "loop-kernel", "denylist.txt");
  if (!existsSync(file)) {
    t.skip(`没有私人词表（${file} 不存在），别人 clone 时也没有，跳过这层`);
    return;
  }
  // 每行一个词，忽略空行和 # 开头的行；不分大小写的子串匹配。词本身不打印。
  const words = readFileSync(file, "utf8").split("\n")
    .map((w) => w.trim())
    .filter((w) => w && !w.startsWith("#"))
    .map((w) => w.toLowerCase());
  const hits = scanLayer((line) =>
    words.some((w) => line.toLowerCase().includes(w)) ? ["私人词"] : []);
  assert.ok(hits.length === 0, `发现私人词（文件:行号）：\n${hits.join("\n")}`);
});
