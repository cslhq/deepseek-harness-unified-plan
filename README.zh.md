# DeepSeek Harness —— 统一 D1–D7 分支

[English](README.md) | 中文

> **非官方个人开发分支。** 由 [@cslhq](https://github.com/cslhq) 维护，基于 [DeepSeek-ai/DeepSeek-Harness](https://github.com/DeepSeek-ai/DeepSeek-Harness) 的 `dsh-v0.2.2-rc.1` 标签派生。它不是 DeepSeek 的官方发布，也未获得 DeepSeek 背书。

## 这个分支解决什么问题

根进程退出并不等于进程已经结束。Windows 上命令跑在 Job 对象里，POSIX 上跑在进程组里，两者都可能比启动它的那个进程活得更久。把"根进程退出了"当成"一切都清理干净了"，正是孤儿 worker、迟迟不释放的临时目录、只释放了一半的 ACL 授权不断堆积的原因。

本分支把这条生命周期显式化：可靠清理、每个资源只有一个所有者、观察受管进程范围、终止该范围，以及在无法证明时拒绝报告成功的最终结算。

## D1–D7 一览

| 阶段 | 归属包 | 职责 |
| --- | --- | --- |
| D1 | `dsh-sandbox-windows-acl` | `AclWriteGrant` 幂等释放；失败时保留 SID 以便重试 |
| D2 | `dsh-sandbox-local` | 引用计数的资源租约；最后一个持有者释放共享资源 |
| D3 | `dsh-sandbox-local` | Session drain 状态机：`open → draining → drained / residue` |
| D4 | `dsh-sandbox-windows-acl` | `ResidueLedger` 记录始终未被确认的释放，以便重试 |
| D5 | `dsh-sandbox-local` | `QuarantineStore` 以原子写入与重试状态持久化被隔离的资源 |
| D6 | `dsh-shell` | `ShellProcess.waitForExit` 契约：只观察，绝不终止 |
| D7 | `dsh-win32-process`、`dsh-subprocess-local`、`dsh-shell`、`dsh-tool-*` | Windows Job 所有权、`terminateRange` / `verifyRange`、`settleManagedRange`、作业结算 |

## 核心不变量

- **根进程的 `done` ≠ 受管范围为空。** `ShellProcess.done` 只结算直连进程；后代仍可能活在 Job 里。
- **`verifyRange` 只观察。** 它重新读取范围并报告 runner 能证明的结果，绝不终止任何东西。
- **`terminateRange` 请求终止。** 它请 runner 终止范围里仍然存活的部分，并报告得到的状态。
- **`waitForExit` 等待范围清空。** 它从不终止；`false` 表示本次等待被取消，`reject` 表示范围无法观察。
- **`drained` 与 `residue`。** 只有被证明为空的范围才是 `drained`；任何无法证明的情况都是 `residue`，而 `residue` 会映射为 `failed` 作业，绝不会变成 `completed`。

## Run from source

```bash
git clone --branch audit/d7-r2-integration --single-branch https://github.com/cslhq/deepseek-harness-unified-plan.git
cd deepseek-harness-unified-plan
corepack enable
corepack prepare pnpm@11.28.5 --activate
pnpm install --frozen-lockfile
pnpm run build
pnpm dsh web
```

环境要求：Node.js `>=24.9.0`（本分支在 24.19.0 上实测）与 pnpm 11.28.5。Web UI 监听 `http://127.0.0.1:3080`；`pnpm run build` 构建的是包与 Web 产物，不会安装 Windows 桌面程序。

## Run

官方 npm 包运行的是正式发布版，不包含本仓库的 D1–D7 改动：

```bash
npx @deepseek-ai/dsh web
```

桌面安装包是另一条 Electron 流水线（`pnpm run package:desktop`），不属于上面的源码运行流程。

## 验证程度

| 检查 | 结果 |
| --- | --- |
| Windows `pnpm run typecheck` | 5 / 5 门禁 |
| Windows `pnpm run build:artifacts` | 8 / 8 门禁 |
| Windows 各包测试 | win32-process 83、subprocess-local 225（跳过 19）、shell 26、pwsh-local 47（跳过 1）、tool-pwsh 161 |
| Linux / WSL bash 套件 | 9 / 9 文件 |
| Linux 原生构建 | `build:ts` 与 `build:native` 均 exit 0；glibc `system.node` 可加载 |
| `sandbox-windows-acl` | 2 失败 / 197 通过 —— 两条失败在 D7 之前的基线上同样复现 |

完整记录与复现命令见 [docs/validation/d7-r2-final-acceptance.zh.md](docs/validation/d7-r2-final-acceptance.zh.md)。

## 已知限制

- **R21** —— `settleManagedRange` 的探测与证明边界是常量（250 ms / 5 s）；极慢的拆除会报 `residue` 而不是继续等待。
- **R23** —— Landlock 助手可以构建并执行，但没有任何测试断言 Landlock 策略在运行时被强制执行。
- **R24** —— 没有产品级故障注入开关；P-07 依赖五层证据，而不是一次真实的 `TerminateJobObject` 失败。
- **R25** —— `waitForManagedRange` 会忽略解析为 `false` 的 provider；今天安全，因为 signal 从未被转发，一旦改变必须重新审查。
- **Windows ACL 基线失败** —— `dispose aggregates a failing revocation` 与 `dispose aggregates a failing SID free` 在 D7 之前就已失败，仍未闭合。
- **P-07 是分层证据** —— 不要把它读成已完成的产品级注入。
- **Landlock 构建成功** —— 原生构建变绿不等于运行时策略已验证。

以上各项均登记在 [docs/known-limitations.zh.md](docs/known-limitations.zh.md)。

## Contributing

这是个人开发分支。[CONTRIBUTING.zh.md](CONTRIBUTING.zh.md) 保留上游正文并在文件末尾追加分支说明；上游规则描述的是官方项目如何接受改动，与本仓库的做法不同。

- 在[本仓库的追踪入口](https://github.com/cslhq/deepseek-harness-unified-plan/issues)提交的 issue 只在这里跟踪，不会被转交上游项目。
- Pull request 由分支维护者决定是否接受；这里发起的任何内容都不会被转交或合并进 DeepSeek Harness 官方仓库。
- 上游项目是否接受外部 pull request，由上游项目自己决定，不由本分支决定。

## Citation

引用 DeepSeek Harness 时请使用上游条目，而不是本分支：

```bibtex
@misc{deepseek-harness2026,
  title={DeepSeek Harness: Everything is a Plugin},
  author={DeepSeek-AI},
  year={2026},
  publisher={GitHub},
  howpublished={\url{https://github.com/deepseek-ai/deepseek-harness}},
}
```

D1–D7 的改动只存在于分支 `audit/d7-r2-integration` 上的 [本仓库](https://github.com/cslhq/deepseek-harness-unified-plan)，没有独立的出版、DOI 或引用条目。

## License

本仓库保留上游的 MIT [LICENSE](LICENSE)，其中原有的版权声明一并保留；第三方依赖及其许可在 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 中披露。本分支没有为 D1–D7 改动另行添加版权声明，本 README 也不对这些改动的作者身份或权利归属作出断言。

## 文档

- [docs/README.zh.md](docs/README.zh.md) —— 本分支的文档索引
- [docs/architecture/d1-d7-overview.zh.md](docs/architecture/d1-d7-overview.zh.md) —— D1–D7 如何协作
- [docs/architecture/windows-job-runner-lifecycle.zh.md](docs/architecture/windows-job-runner-lifecycle.zh.md) —— Job 所有权与 runner 协议
- [docs/architecture/shell-managed-range-contract.zh.md](docs/architecture/shell-managed-range-contract.zh.md) —— `waitForExit` / `terminateRange` / `verifyRange`
- [docs/development/windows.zh.md](docs/development/windows.zh.md) —— 在 Windows 上构建与测试
- [docs/development/linux-wsl.zh.md](docs/development/linux-wsl.zh.md) —— 在 Linux / WSL 上构建与测试
- [docs/known-limitations.zh.md](docs/known-limitations.zh.md) —— 未闭合风险与基线失败

每个页面旁边都有对应的英文原文（`*.md`）。
