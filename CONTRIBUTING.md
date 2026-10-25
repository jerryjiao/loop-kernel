# 贡献指南

内核只由维护者改。改法如下。

## 什么能进内核

内核只放机制，业务一律通过 `loop.config.mjs` 的钩子接。判断方法是问：「一个完全不懂这个业务的循环会不会也需要它？」需要才进内核。内核里不出现任何具体循环的业务词。

## 怎么改

1. 在分支上做改动，`npm test` 通过。测试里有私人信息扫描，可选读本机 `~/.config/loop-kernel/denylist.txt` 作为私人词表，也可用环境变量 `LOOP_KERNEL_DENYLIST` 指定词表路径。
2. push 分支后，让用到内核的循环在自己的 worktree 里钉这个分支上的 commit 试跑。
3. 循环试跑和内核测试都过了，再合进 main。

## 怎么合进 main

只用普通合并或快进，**不 squash、不 rebase**：循环试过的那个 commit 必须原样留在 main 的历史里，这样升级的人钉的才真是试过的那个。

## 每个改动都要做的事

- 在 CHANGELOG.md 写一条。会弄坏现有循环的改动标「破坏性」，并写明 `loop.config.mjs` 要怎么改。
- 提交邮箱用 GitHub noreply 地址。
