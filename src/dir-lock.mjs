// 通用目录锁：mkdir 原子抢锁，锁内 owner 记 pid+抢锁时刻；拿不到每 50ms 重试共 5 秒后拒绝；
// 持锁超 60 秒视为持锁进程已死（死锁）可抢占。now/sleep 可注入，锁逻辑可直接单测。
// 用法：withDirLock(lockDir, fn, { ensureDir }) —— lockDir 即锁目录本身（调用方定位置，
// 如 days 目录下的 .lock、账本旁的 <file>.lock）；ensureDir 给父目录未必存在的场景先建父目录。

import { mkdirSync, writeFileSync, readFileSync, statSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

export const LOCK_RETRY_MS = 50;
export const LOCK_TIMEOUT_MS = 5000;
export const LOCK_STALE_MS = 60000;

export class LockBusy extends Error {}

const sleepReal = (ms) => {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms; // worker 等不支持 Atomics.wait 的环境退化忙等
    while (Date.now() < end);
  }
};

export function withDirLock(lockDir, fn, { now = Date.now, sleep = sleepReal, ensureDir = false, busyError = null } = {}) {
  const deadline = now() + LOCK_TIMEOUT_MS;
  if (ensureDir) mkdirSync(dirname(lockDir), { recursive: true });
  for (;;) {
    try {
      mkdirSync(lockDir);
      writeFileSync(join(lockDir, "owner"), `${process.pid} ${now()}\n`);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let heldSince = null;
      try {
        heldSince = Number(readFileSync(join(lockDir, "owner"), "utf-8").trim().split(" ")[1]);
      } catch {} // owner 还没写完的窗口，按目录 mtime 兜底
      if (heldSince === null || !Number.isFinite(heldSince)) {
        heldSince = statSync(lockDir).mtimeMs;
      }
      if (now() - heldSince > LOCK_STALE_MS) {
        rmSync(lockDir, { recursive: true, force: true }); // 死锁抢占
        continue;
      }
      if (now() >= deadline) throw busyError ?? new LockBusy(`目录锁被占：${lockDir}（另一进程正在写，稍后重试）`);
      sleep(LOCK_RETRY_MS);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}
