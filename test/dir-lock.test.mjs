// dir-lock.mjs：抢锁/释放、占着超时拒绝、死锁抢占、ensureDir。now/sleep 注入，不真等。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { LockBusy, withDirLock } from "../src/dir-lock.mjs";

const tempDirs = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-lock-"));
  tempDirs.push(dir);
  return dir;
};
afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop(), { recursive: true, force: true });
});

test("抢到锁跑 fn，跑完释放；fn 抛错也释放", () => {
  const lockDir = join(tempDir(), ".lock");
  assert.equal(withDirLock(lockDir, () => 42), 42);
  assert.equal(existsSync(lockDir), false);
  assert.throws(() => withDirLock(lockDir, () => { throw new Error("boom"); }), /boom/);
  assert.equal(existsSync(lockDir), false);
});

test("锁被活进程占着：重试到超时抛 LockBusy（now/sleep 注入，不真等）", () => {
  const lockDir = join(tempDir(), ".lock");
  mkdirSync(lockDir);
  writeFileSync(join(lockDir, "owner"), `123 ${Date.now()}\n`); // 刚抢的，不算死锁
  let t = Date.now();
  const now = () => (t += 1000); // 每查一次走 1 秒，先把 5 秒超时耗完（到不了 60 秒死锁线）
  assert.throws(() => withDirLock(lockDir, () => {}, { now, sleep: () => {} }), LockBusy);
});

test("持锁超 60 秒视为死锁，抢占后照常跑", () => {
  const lockDir = join(tempDir(), ".lock");
  mkdirSync(lockDir);
  writeFileSync(join(lockDir, "owner"), `123 ${Date.now() - 61000}\n`);
  let owner = null;
  withDirLock(lockDir, () => {
    owner = readFileSync(join(lockDir, "owner"), "utf8");
  });
  assert.match(owner, new RegExp(`^${process.pid} `)); // owner 已换成自己
  assert.equal(existsSync(lockDir), false);
});

test("ensureDir 先建父目录", () => {
  const lockDir = join(tempDir(), "days", "2026-10-25", ".lock");
  assert.equal(withDirLock(lockDir, () => "ok", { ensureDir: true }), "ok");
  assert.equal(existsSync(lockDir), false);
});
