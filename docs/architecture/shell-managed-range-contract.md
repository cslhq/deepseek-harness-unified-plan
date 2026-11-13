# The shell managed-range contract (D6 + D7)

`ShellProcess` 描述的不只是"一个进程"，而是"一个可以比直连进程活得更久的
受管范围"。Windows 上它是 Job 对象，POSIX 上是进程组。

## 三个操作

| 操作 | 语义 | 会终止吗 | 会等待吗 | 失败时 |
| --- | --- | --- | --- | --- |
| `waitForExit(signal?)` | 观察范围是否为空 | 否 | 是 | reject = 不可观察 |
| `verifyRange()` | 观察一次，返回带证据的答案 | 否 | 是（一次查询） | `state: 'unknown'` |
| `terminateRange()` | 请求终止范围并返回它证明了什么 | **是** | 是 | `state: 'unknown'` + `terminate-failed:…` |

**`kill()`** 是第四个入口，含义是"是否有一层接受了终止请求"：直连进程存活时
终止它；直连进程已结算时转发给 `terminateRange()`（该 provider 没有范围能力
则返回 `false`）。它**不**声称范围已空。

## `waitForExit` 的三种结果

```ts
waitForExit(signal?: AbortSignal): Promise<boolean>
```

- `true` — 范围为空，所有成员已退出。
- `false` — **本次等待**被取消。进程、底层观察、之后的调用都不受影响。已 abort
  的 signal 立即返回 `false`（abort 优先于"已经空了"）。
- `reject` — provider 无法观察（没有 owner、runner 断连、查询失败）。

规则：
1. 只观察，绝不终止。
2. 与 `done` 独立；`done` 结算不代表范围空。
3. rejection 永远不得当作"已清空"。

## 产品级策略：`settleManagedRange`

```ts
const settlement = await settleManagedRange(process)
// { state: 'drained' | 'residue', evidence: readonly string[] }
```

1. **probe**：`waitForExit(250ms)` 为 `true` → 直接 `drained`（零 IPC）。
2. **verify**：返回 `empty`/`terminated` → 跳过终止。
3. **terminate**：仅在范围仍存活或不可证时调用。
4. **proof**：`waitForExit(5s)` 为 `true` → `drained`，否则 `residue`。

`residue` 会让 `processOutcome` 返回 `failed`，detail 形如
`…; managed process range not proven empty (probe-empty:false, verify:partial, terminate:unknown, range-empty:false)`。

## 迁移外部 executor

`waitForExit` 是 `ShellProcess` 的**必填**成员（见 [CHANGELOG.md](../../CHANGELOG.md)）。
无后代的 executor 可以一行实现：

```ts
waitForExit: (signal?: AbortSignal) => Promise.resolve(signal?.aborted !== true)
```

需要观察真实范围的 executor 必须在范围真正清空后才 resolve，并且**不要**在这里
终止任何东西。
