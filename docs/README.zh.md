# 文档索引 —— 统一 D1–D7 分支

[English](README.md) | 中文

本目录记录承载 D1–D7 进程生命周期工作的**非官方个人分支**。本树下的上游文档保持原样；下列页面均为新增。

| 页面 | 回答的问题 |
| --- | --- |
| [architecture/d1-d7-overview.zh.md](architecture/d1-d7-overview.zh.md) | D1–D7 各自负责什么，以及它们如何协作 |
| [architecture/windows-job-runner-lifecycle.zh.md](architecture/windows-job-runner-lifecycle.zh.md) | Windows Job 对象如何创建、归属、观察与关闭 |
| [architecture/shell-managed-range-contract.zh.md](architecture/shell-managed-range-contract.zh.md) | `waitForExit` / `terminateRange` / `verifyRange` 的语义 |
| [development/windows.zh.md](development/windows.zh.md) | 在 Windows 上构建与测试 |
| [development/linux-wsl.zh.md](development/linux-wsl.zh.md) | 在 Linux / WSL 上构建与测试，含原生 addon |
| [validation/d7-r2-final-acceptance.zh.md](validation/d7-r2-final-acceptance.zh.md) | 本分支 HEAD 背后的验收运行 |
| [known-limitations.zh.md](known-limitations.zh.md) | 未闭合风险 R21/R23/R24/R25 与已知基线失败 |

## 范围与诚实性规则

- 本目录中的每个数字都来自本分支的一次真实运行记录，没有任何预测或估算。
- 当证据是分层的（单元 + 协议 + 产品）而非端到端时，页面会明确说明。
- `CONTRIBUTING.md` **未**修改，仍是上游文档；本分支的本地约定记录在此索引与 [development/windows.zh.md](development/windows.zh.md) 中。
