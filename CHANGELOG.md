# Changelog

All notable changes to DeepSeek Harness are recorded here. The project is in
pre-1.0; entries marked **Breaking** still require consumer adaptation.

## [Unreleased] — managed process ranges (D6 / D7)

### Breaking Changes

- **`ShellProcess.waitForExit(signal?): Promise<boolean>` is now a required
  member of the `@deepseek-ai/dsh-shell` service contract.**

  A `ShellProcess` describes a *managed process range* (on Windows: the Job
  object), which can outlive the direct command it was started for. `done`
  settles with the **direct process only**; `waitForExit` is the only way to
  learn whether the range is empty. Every `ShellExecutor` implementation must
  provide it. The bundled `bash-local` and `pwsh-local` executors already do.

  Semantics:

  | Result | Meaning |
  | --- | --- |
  | `true` | The managed range is empty; every member has exited. |
  | `false` | *This wait* was aborted. The processes, the underlying observation, and any later call are unaffected. |
  | rejects | The provider cannot observe the range (no owner, runner disconnected, observation failure). |

  Additional rules:

  - `waitForExit` **only observes**. It never terminates anything; termination
    is `kill()` / `terminateRange()`.
  - An already-aborted signal reports `false` immediately, even when the range
    is already empty (abort precedence).
  - `done` and the managed range are independent: a settled `done` is **not**
    evidence that the range is empty.
  - A rejected observation must never be treated as "already empty".

  Migration for a custom executor:

  ```ts
  import type { ShellExecution, ShellProcess } from '@deepseek-ai/dsh-shell'

  const process: ShellProcess = {
    // ...existing members (status, exitCode, done, observed, readOutput, kill, result)
    // Observe the managed range; do not terminate here.
    waitForExit: async (signal?: AbortSignal): Promise<boolean> => {
      if (signal?.alreadyAborted ?? signal?.aborted) return false
      await this.rangeEmpty()          // true once no member of the range remains
      return signal?.aborted !== true
    },
  }
  ```

  Executors that own no descendants may report the range as empty:

  ```ts
  waitForExit: (signal?: AbortSignal) => Promise.resolve(signal?.aborted !== true)
  ```

### Added

- `ShellProcess.terminateRange?(): Promise<ShellRangeAnswer>` — request
  termination of whatever the managed range still holds and report what the
  provider could prove (`terminated` | `empty` | `partial` | `unknown`).
  Requests are provider-idempotent and never upgraded to a terminal state the
  provider did not observe.
- `ShellProcess.verifyRange?(): Promise<ShellRangeAnswer>` — observe the range
  without terminating anything; an unprovable answer is `unknown`, never
  `empty`.
- `settleManagedRange(process, options?)` — the shared product teardown policy:
  probe, observe, terminate only when needed, then prove. Anything short of a
  proven empty range is reported as `residue`, and background jobs that end in
  `residue` are reported as `failed` rather than `completed`.
