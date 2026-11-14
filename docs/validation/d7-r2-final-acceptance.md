# D7-R2 final acceptance (branch head at the D7-R2 acceptance run)

本页记录本分支 HEAD 的验收运行。所有数字来自洁净工作树（删除 `*.tsbuildinfo`、独立 `pnpm install`），不是增量结果。

## 提交

| 提交 | 内容 |
| --- | --- |
| C1（subprocess） | Windows Job range：host 请求器、runner 侧处理、句柄面 `terminateRange`/`verifyRange` |
| C2A（修复） | 类型修复（sandbox 声明、`waitForManagedRange` 兼容）+ 10 个测试桩适配 |
| C2B（shell） | `waitForExit` 成为必填契约、`settleManagedRange`、两个方言接线、`CHANGELOG.md` |
| C3（tools） | 作业结算：`residue → failed`；平台感知的 `kill()` 断言 |

## Windows（洁净工作树）

| 项目 | 结果 |
| --- | --- |
| `pnpm run typecheck` | **5 passed / 0 failed**（195.13s） |
| `pnpm run build:artifacts` | **8 passed / 0 failed**（48.01s） |
| `win32-process` | 8 文件 / **83 passed** |
| `subprocess-local` | 11 通过文件 + 3 跳过；**225 passed / 19 skipped**（244） |
| `shell/shell` | 4 文件 / **26 passed** |
| `pwsh-local` | 2 文件 / **47 passed / 1 skipped**（48） |
| `tool-pwsh` | 9 文件 / **161 passed** |
| `sandbox-windows-acl` | **2 failed / 197 passed**（两条失败为基线既有，见 known-limitations） |
| `bash-local` / `tool-bash` | Windows 不收集（需要 POSIX shell） |

## Linux / WSL（独立工作树，Node 24.19.0 / pnpm 11.28.5）

| 项目 | 结果 |
| --- | --- |
| `native/system` `pnpm build:ts` | exit 0 |
| `native/system` `pnpm build:native` | exit 0 |
| glibc `system.node` | 存在，`ELF 64-bit LSB shared object, x86-64`，`require()` 返回 object |
| musl 助手 `landlock-run` | 存在，`statically linked, stripped`，`--help` 以 125 退出并给出用法错误 |
| `bash-local` + `tool-bash` | **9/9 文件通过** |
| `sandbox-local` | 1 文件失败（Windows-ACL 用例），2 通过 |

## 产品级证据

| 场景 | 结果 |
| --- | --- |
| P-01 正常退出 | 作业 `completed`（`exit code: 0`） |
| P-02 根退出、后代存活 | 作业 `completed`，且后代 `cmd.exe`（pid 26172）**已终止**（`childAlive=false`） |
| DISCONNECT（杀 runner） | 作业 `failed`，detail 含 `managed process range not proven empty`、`verify:unknown`、`terminate:unknown` |
| 安装版 Runtime + Shell E2E | 正常场景 `drained`；断连场景 `residue` + `childGone` |

## P-07 的边界

P-07（`TerminateJobObject` 失败）**没有**产品级故障注入。证据是五层组合：

| 层 | 位置 |
| --- | --- |
| L1 | `range-handler.ts` 捕获异常 → `state:'unknown'` + `terminate-failed:…` |
| L2 | `spawn-runner.spec.ts`：`maps a failed TerminateJobObject to unknown instead of a terminal state`（注入返回 0） |
| L3 | 同文件：抛异常变体 |
| L4 | `windows-range.ts`：`identity-unbound` / `runner-disconnected` / `ack-timeout` → `unknown` |
| L5 | `tool-pwsh/tests/managed-range.spec.ts` + `shell/src/index.ts`：residue → `failed` |

不得把该组合描述为"产品级 TerminateJobObject 故障注入已完成"。

## 决策记录：不给 Job 增加 ResidueKind

Job 是匿名内核对象，句柄只存在于 runner；runner 退出即触发 `KILL_ON_JOB_CLOSE`，对象随之销毁。持久化记录无法"重新打开"一个 Job，因此 D4 的 `ResidueKind`（`acl-grant` / `acl-sandbox` / `temp-dir`）**不**扩展进程类型；Job 的清空由 `KILL_ON_JOB_CLOSE` 保证，验收时以"后代进程确实消失"作为证据。
