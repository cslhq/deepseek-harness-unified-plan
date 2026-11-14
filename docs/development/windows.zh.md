# 在 Windows 上开发

[English](windows.md) | 中文

## 工具链

| 组件 | 版本（本分支实测） |
| --- | --- |
| Node | 24.19.0 |
| pnpm | 11.28.5 |
| Shell | PowerShell 7；仓库脚本需要 **Git for Windows 的 bash** |
| 原生依赖 | `koffi`、`node-pty`（postinstall 安装） |

```powershell
corepack prepare pnpm@11.28.5 --activate
pnpm install --frozen-lockfile
```

> `scripts/check-vendor-manifest.sh` 必须由 Git for Windows 的 bash 运行 （`D:\Program Files\Git\bin\bash.exe`）。PATH 上的 `bash` 若指向 WSL 启动器， 在 WSL 未装发行版时会报 `/bin/bash: No such file or directory`。

## 常用命令

```powershell
pnpm run typecheck                  # 5 个门禁：Host Typert、host/client 编译器、聚合检查
pnpm run build:artifacts            # 8 个构建门禁
pnpm exec vitest run packages/subprocess/win32-process
pnpm exec vitest run packages/subprocess/subprocess-local
pnpm exec vitest run packages/shell/shell packages/shell/pwsh-local packages/shell/tool-pwsh
pnpm exec oxlint <files>
```

Windows 上**不收集** `packages/shell/bash-local` 与 `packages/shell/tool-bash`（需要POSIX shell）；它们的验证在 Linux/WSL 完成。

## 增量构建的陷阱

`tsc -b` 依赖 `.tsbuildinfo`。当某个项目曾经失败，依赖它的项目会被跳过，于是"本地 typecheck 通过"可能只是**增量结果**。要拿到可信结论：

```powershell
Get-ChildItem -Recurse -Filter '*.tsbuildinfo' | Remove-Item -Force
pnpm run typecheck
```

本分支的 C2A 正是这样发现的：洁净构建下暴露了 10 条基线类型错误 + 17 条测试桩错误。

## 钩子

`postinstall` 安装 lefthook；`pre-commit` 运行 lint（`--fix` + `stage_fixed`）、 whitespace、vendor manifest guard。**部分暂存**（索引里有内容、工作区另有未暂存改动）时，lefthook 的"隐藏/恢复未暂存改动"可能与 `--fix` 改写冲突并丢失工作区修改。安全的提交方式是：让工作区与索引一致（先把无关改动 park 到仓库外），提交完成后再恢复。

```powershell
$env:PATH = 'D:\Program Files\Git\bin;' + $env:PATH
bash scripts/check-vendor-manifest.sh
```
