# loop-kernel

> A tiny kernel for self-running "loops": an hourly scheduler wakes shifts, each shift takes work orders from a pool by priority and runs a headless Claude Code session on them, and anything that needs a human becomes a decision in an append-only ledger. Docs are in Chinese. Built for the author's own loops; MIT, use at your own risk.

循环的通用内核：到点分班 → 从单池按优先级领单 → 起无头会话干活 → 需要人判断的写成拍板题进账本。内核不认识任何业务；每个循环在自己仓库里写 `loop.config.mjs`（见 [docs/config.md](docs/config.md)），术语见 [GLOSSARY.md](GLOSSARY.md)。

## 用法

在循环仓库的 package.json 里钉 commit 依赖：

```json
"dependencies": { "loop-kernel": "github:<owner>/loop-kernel#<commit>" }
```

升级 = 改 commit → `npm install` → 跑本循环的测试。

## 模块

| 模块 | 做什么 |
|---|---|
| `dir-lock` | 目录锁 |
| `dates` | 圈日（时区可配） |
| `scheduled-tasks` | 定时任务登记表、判班 |
| `config` | 加载并校验 loop.config.mjs |

## 谁能改

内核只由维护者改。循环发现内核问题，开改进单写提议与证据，不直接改内核。
