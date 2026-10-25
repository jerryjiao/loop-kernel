# loop.config.mjs 契约

每个循环在自己仓库根目录放一个 `loop.config.mjs`，`export default` 一个对象。内核只通过它认识这个循环。

## 数据布局（固定，不可配）

```
<root>/loop/scheduled-tasks.json   定时任务登记表（工作台可读写，所以是 JSON）
<root>/loop/ledger.jsonl           账本
<root>/loop/days/<圈日>/           orders.jsonl、shifts.jsonl、rejects.jsonl 等
<root>/loop/switches/<单型>.off    单型总开关
```

## 字段

| 字段 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `root` | 否 | 配置文件所在目录 | 循环仓库根 |
| `timezone` | 否 | `"Asia/Shanghai"` | 圈日按这个时区算 |
| `loopHome` | 是 | — | 本机状态目录（班锁、日志、任务停用标记），每个循环各用各的 |
| `launchdPrefix` | 是 | — | launchd label 前缀，如 `"com.example.loop"` |
| `extraPath` | 否 | `["/opt/homebrew/bin","/usr/local/bin"]` | launchd 里给会话用的额外 PATH（拼在 node 所在目录之后、系统路径之前） |
| `shifts` | 是 | — | `{ <班编号>: { name, timeLimitMin, alwaysRun } }`；`alwaysRun:false` = 有单才起；登记表里出现的每个班编号都必须在 shifts 里 |
| `by` | 否 | `["shift","manual"]` | 单的处理人取值 |
| `orderTypes` | 是 | — | 单型登记数组（字段见 order-types.mjs） |
| `ledgerRows` | 否 | `{}` | `{ <行类型>: (row) => 问题字符串或 null }`，各循环自己的账本行校验 |
| `prompt` | 是 | — | `(shift, { dryRun }) => string`，起会话的提示词 |
| `executor` | 是 | — | `{ run({ cwd, prompt, sessionId, timeoutMs, shift }) }` → `{ code, timedOut, json, stderr, skip?, row? }`；`skip` 给原因则本班记 skipped 不跑，`row` 合并进班记录 |
| `beforeShift` | 否 | 无 | `async ({ root, shift, log }) => void`，拿到锁后、起会话前 |
| `afterShift` | 否 | 无 | `async ({ root, shift, log, result }) => void`，班记录写完后 |
| `notify` | 否 | 无 | `async (text) => void`，推送简报等 |
| `quotaFn` | 否 | 放行 `() => "ok"` | `(单草稿) => 字符串或 null`，null = 没额度不领 |
| `shiftOf` | 否 | 无（记 `manual`） | `(date) => 班编号`，没有 `LOOP_SHIFT` 时用来推当前班 |
| `suggestExtras` | 否 | `{}` | 对象，展开进单型 `suggestable` 的参数（循环补自家材料） |
| `neverDefaultCategories` | 否 | `[]` | 这些 category 的拍板题永不按推荐默认（`ledger.pendingQuestions` / `decision-sync`） |
| `loopRowTypes` | 否 | `["delivery","decision"]` | 空转计数（`ledger.emptyStreak`）的下界行类型 |

## 最小示例

```js
import { claudeCode } from "loop-kernel/executor-claude";
import orderTypes from "./loop/order-types.mjs";

export default {
  loopHome: `${process.env.HOME}/.my-loop`,
  launchdPrefix: "com.example.myloop",
  shifts: { plan: { name: "规划班", timeLimitMin: 120, alwaysRun: true }, work: { name: "执行班", timeLimitMin: 90, alwaysRun: false } },
  orderTypes,
  prompt: (shift) => `你是本循环的${shift}，照 loop/shift.md 执行`,
  executor: claudeCode({ env: async () => ({ baseUrl: process.env.MY_BASE_URL, key: process.env.MY_KEY, model: "my-model" }) }),
};
```
