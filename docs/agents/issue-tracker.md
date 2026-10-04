# Issue 跟踪

这个仓库的 issue 与方案都存在 GitHub issues 里，用 `gh` CLI 操作（仓库从 `git remote -v` 推断）。

## 为什么用 issues 而不是仓库内的 TODO 文件

**清单写在仓库里会滞后。** 实测过一次：一份写于 2026-10-02 的缺口清单，
到 10-04 逐条核对时发现 **7 项里 6 项早已实现** —— 如果不核对就直接做，会全部重做一遍。

issue 有状态、有评论时间线、能关闭，**滞后会立刻显现**（开着但早就做完了）。

## 常用操作

```powershell
gh issue list --state open                    # 看还开着什么
gh issue view <n> --json body                 # 读正文（不含评论）
gh issue view <n> --json comments             # 读评论
gh issue comment <n> --body-file <文件>        # 加评论（多行用文件，别用 -c）
gh issue close <n> --reason completed         # 关闭
```

**两个坑**：

- `gh issue close` **没有 `--body-file`**，只有 `-c`；而多行 `-c` 会被 shell 拆开
  （报 `accepts 1 arg(s), received 20`）。**要用 PowerShell here-string 变量。**
- 关闭时给一句**结论**（不是"已完成"三个字）—— 半年后回看，那句结论比 issue 正文有用。

## Wayfinder

较大的工作用一个 **map**（父 issue）带若干 **子 ticket**，靠 `wayfinder:*` 标签区分角色：

| 标签 | 角色 |
| --- | --- |
| `wayfinder:map` | 这件事的**权威产物**（一张图，不是一次性文档） |
| `wayfinder:research` | **AFK** 的事实调查（能自己跑，产出结论） |
| `wayfinder:prototype` | **HITL** 的粗糙产物（要人看一眼、给反应） |
| `wayfinder:grilling` | **HITL** 的对话（把问题问清楚） |
| `wayfinder:task` | **人工**要做的活（决策前必须先有它） |

**分这四类的意义**：AFK 的可以并行跑，HITL 的必须等人 —— **混在一起排期会一直卡在等你的那一步。**
