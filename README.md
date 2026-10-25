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
| `ledger` | 账本：JSONL 追加与读、拍板题/拍板行、空转 |
| `order-types` | 单型注册表（createRegistry/validateRegistry、内置拍板单型） |
| `orders` | 单：七阶段、防重复、上限、开关、搜索预算、next |
| `decision-sync` | 账本拍板 ↔ 拍板单同步 |
| `shift` | 班入口：判班、领单（有单才起）、起会话、写班记录 |
| `executor-claude` | Claude Code 无头执行器适配器（网关/key/模型由循环的 `env` 回调接） |
| `launchd` | launchd 闹钟：装（on）/卸（off）/看（status） |

## 起一个新循环

1. 建循环仓库，`npm i github:<owner>/loop-kernel#<commit>` 把内核钉在某个 commit 上。
2. 仓库根写 `loop.config.mjs`（字段见 [docs/config.md](docs/config.md)）：班表、提示词、executor——网关、key、模型都在这里接。
3. 写 `loop/scheduled-tasks.json`（定时任务登记表）与本循环的手册（班照哪本手册跑）。
4. 空跑一班验通路：`node node_modules/loop-kernel/src/shift.mjs --shift <班> --dry-run`。
5. 装闹钟：`node node_modules/loop-kernel/src/launchd.mjs on`，之后每小时整点自动判班。

## 谁能改

内核只由维护者改。循环发现内核问题，开改进单写提议与证据，不直接改内核。改法见 CONTRIBUTING.md，升级前看 CHANGELOG.md。
