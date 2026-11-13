# Development on Linux / WSL

## 工具链（本分支实测）

| 组件 | 版本 |
| --- | --- |
| 发行版 | Ubuntu 26.04（WSL2，Linux 6.18） |
| Node | 24.19.0（独立安装，不复用 Windows 树） |
| pnpm | 11.28.5 |
| 编译工具 | `build-essential`、`musl-tools` |

```bash
pnpm install --frozen-lockfile   # 需要可写 TTY；无 TTY 时加 CI=true
```

> `CI=true` 是必需的：pnpm 在清理 `node_modules` 时会要求确认，非交互环境下会以
> `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` 退出。

## 原生产物（native/system）

```bash
cd native/system
pnpm build:ts        # tsc -b
pnpm build:native    # tsx ./scripts/build.ts
```

产物：

| 文件 | 类型 | 说明 |
| --- | --- | --- |
| `packages/linux-x64/bin/glibc/system.node` | ELF 共享对象，动态链接 `libc.so.6` | Node `require()` 成功 |
| `packages/linux-x64/bin/musl/system.node` | musl addon | 供 musl 发行版 |
| `packages/linux-x64/bin/landlock-run` | **静态** musl 可执行文件，已 strip | Landlock 助手；`ldd` 报 "not a dynamic executable" |

构建需要 `musl-gcc`；缺失时 `build:native` 会在静态助手这一步失败。**构建通过
不等于运行时策略被验证** —— 见 [known-limitations.md](../known-limitations.md) 的 R23。

## 测试

```bash
pnpm exec vitest run packages/shell/bash-local packages/shell/tool-bash
pnpm exec vitest run packages/sandbox/sandbox-local
```

- bash-local + tool-bash：**9/9 文件通过**（本分支 HEAD 实测）。
- sandbox-local：1 个文件失败 —— 其 `acl-grants.spec.ts` 是 Windows-ACL 用例，
  在 Linux 上本来就不适用，基线同样失败。

## 与 Windows 工作区隔离

建议把 Linux 侧装在独立目录（例如 `~/dsh-review`），用 `git worktree add` 检出目标
提交，再单独 `pnpm install`。**不要**与 Windows 的 `node_modules` 共用：
Windows 树里没有 Linux 原生绑定，vitest 会因 `rolldown` 绑定缺失而无法启动。
