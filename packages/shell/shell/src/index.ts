/**
 * Service Definition for the `ctx.shell` capability seam, covering foreground commands and background process
 * handles. Job ids, ownership, polling, and notices belong to
 * `@deepseek-ai/dsh-jobs`, keeping executors independent of sessions.
 * @module @deepseek-ai/dsh-shell
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type { ShellExecRequest, ShellExecSpec, ShellExecution, ShellProcess } from './types.ts'

export { DSH_ENV_PREFIX } from './types.ts'
export type {
  ShellExecRequest,
  ShellExecSpec,
  ShellExecution,
  ShellExpiryPolicy,
  ShellProcess,
  ShellProcessRead,
  ShellProcessStatus,
  ShellRunResult,
  ShellSandboxInfo,
  CollectedOutput,
  DshEnvironment,
  DshEnvironmentKey,
} from './types.ts'
export { parseExitStatus } from './render.ts'
export type { ParsedExitStatus } from './render.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    shell: ShellExecutor
  }
}

/**
 * Abstract bash execution service. Subclass, implement the abstract methods,
 * and load the subclass as a plugin — it registers as `ctx.shell` (one
 * implementation per context; loading a second throws, which is cordis'
 * standard duplicate-service behavior).
 *
 * {@link execute} resolves with the process handle after preparation. "Foreground" is a property of what the caller awaits, not
 * of the spawn — a caller that awaits {@link ShellExecution.result} ran the
 * command in the foreground; one that keeps the handle ran it in the
 * background. A caller that waits only for a while runs the command under
 * `onExpiry: 'none'` and bounds its own wait; the handle stays valid after
 * the caller stops waiting.
 *
 * Implementations must honor these semantics:
 * - {@link ShellExecution.result} rejects only for infrastructure failures.
 *   Nonzero exits, timeout kills, and abort kills resolve with a descriptive
 *   result: first-cause `timedOut`/`aborted`, the spec's `timeoutMs` echoed.
 * - The handle is published after preparation. `done` settles at process close
 *   and never rejects; spawn failures settle as `killed` with the error on the read
 *   path, while `result()` carries the same failure as its rejection.
 * - `onExpiry: 'none'` arms no deadline; `'kill'` kills at expiry. Expiry
 *   during preparation returns a settled timed-out handle without output.
 * - {@link ShellProcess.readOutput} is incremental: consecutive reads never
 *   repeat output. Lossy reads report truncation and available spill files.
 * - A still-running process is stopped and awaited when its owning
 *   composition tears down. With the subprocess seam that boundary is
 *   `ctx.subprocess` disposal, so a process survives an executor-only reload.
 */
export abstract class ShellExecutor extends Service {
  constructor(ctx: Context) {
    super(ctx, 'shell')
  }

  /**
   * The sandbox mode this executor applies by default, or `undefined` when it
   * does not sandbox commands.
   * @returns the configured default sandbox mode, when supported.
   */
  get sandboxMode(): SandboxMode | undefined {
    return undefined
  }

  /**
   * Apply implementation-owned defaults and caps to a request before execution.
   * @param request - the caller's request; omitted fields get this
   *   implementation's defaults, capped fields are clamped.
   * @returns the fully-specified spec to hand to {@link execute}.
   */
  abstract resolve(request: ShellExecRequest): ShellExecSpec

  /**
   * Prepare and spawn the command under its resolved deadline.
   * @param spec - a resolved spec from {@link resolve}, never a raw request.
   * @returns the prepared handle, including its result projection;
   *   preparation timeout yields an already-settled handle with no output.
   * @throws on preparation failure or caller cancellation before process publication.
   */
  abstract execute(spec: ShellExecSpec): Promise<ShellExecution>
}

/**
 * Observe a provider-managed process range through a {@link ShellProcess}.
 *
 * Shared by the shell executors so both dialects expose one implementation:
 * true = range empty; false = this wait was aborted; rejection = the provider
 * cannot observe the range (never silently report empty).
 * @param running - the provider handle, or undefined when no process exists.
 * @param signal - cancels this wait only.
 * @returns the range-observation promise.
 */
export function waitForManagedRange(
  running: { waitForExit?: () => Promise<void | boolean> } | undefined,
  signal?: AbortSignal,
): Promise<boolean> {
  if (running === undefined) return Promise.resolve(true)
  const observe = running.waitForExit
  if (typeof observe !== 'function') {
    return Promise.reject(new Error('shell: the subprocess provider cannot observe the managed process range'))
  }
  let observation: Promise<void | boolean>
  try {
    observation = Promise.resolve(observe.call(running))
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)))
  }
  if (signal === undefined) return observation.then(() => true)
  if (signal.aborted) return Promise.resolve(false)
  return new Promise<boolean>((resolve, reject) => {
    const cleanup = (): void => { signal.removeEventListener('abort', onAbort) }
    const onAbort = (): void => { cleanup(); resolve(false) }
    signal.addEventListener('abort', onAbort, { once: true })
    observation.then(
      () => { cleanup(); resolve(true) },
      (error: unknown) => { cleanup(); reject(error instanceof Error ? error : new Error(String(error))) },
    )
  })
}

/** Provider answer for one managed-range request. */
export type { ShellRangeAnswer } from './types.ts'

/** Outcome of one product-level managed-range settlement. */
export interface ManagedRangeSettlement {
  /** `drained` only when the range was proven empty; everything else is residue. */
  readonly state: 'drained' | 'residue'
  /** Observation, termination, and the final proof, in call order. */
  readonly evidence: readonly string[]
}

/** Default bound for one settlement's final range proof. */
export const MANAGED_RANGE_SETTLE_TIMEOUT_MS = 5_000

/**
 * Bring one shell process's managed range to a proven state.
 *
 * This is the product teardown policy in one place, shared by every dialect:
 * observe first (a range that already proves empty is never asked to
 * terminate), request termination only when the range is still live or
 * unprovable, then wait for the range to empty. Anything short of a proven
 * empty range is `residue`: an aborted wait, a rejected observation, a
 * timeout, or an `unknown`/`partial` answer never becomes `drained`.
 * @param process - shell process whose managed range must be released.
 * @param options - bound for the final range proof.
 * @returns the proven state and the evidence trail, in call order.
 */
export async function settleManagedRange(
  process: ShellProcess,
  options: { timeoutMs?: number; probeMs?: number } = {},
): Promise<ManagedRangeSettlement> {
  const evidence: string[] = []
  // Fast path: the overwhelmingly common case is a range that already emptied
  // with its direct process. Probing first avoids sending range requests — and
  // therefore any termination — for a range that needs none.
  try {
    if (await process.waitForExit(AbortSignal.timeout(options.probeMs ?? 250))) {
      return { state: 'drained', evidence: ['probe-empty:true'] }
    }
    evidence.push('probe-empty:false')
  } catch (error) {
    evidence.push(`probe-empty-failed:${String(error)}`)
  }
  let observed: { state: string } | undefined
  if (process.verifyRange !== undefined) {
    try {
      const answer = await process.verifyRange()
      if (answer !== undefined) {
        observed = answer
        evidence.push(`verify:${answer.state}`)
      }
    } catch (error) {
      evidence.push(`verify-failed:${String(error)}`)
    }
  }
  if (observed?.state !== 'empty' && observed?.state !== 'terminated' && process.terminateRange !== undefined) {
    try {
      const termination = await process.terminateRange()
      evidence.push(`terminate:${termination?.state ?? 'unsupported'}`)
    } catch (error) {
      evidence.push(`terminate-failed:${String(error)}`)
    }
  }
  try {
    const empty = await process.waitForExit(
      AbortSignal.timeout(options.timeoutMs ?? MANAGED_RANGE_SETTLE_TIMEOUT_MS),
    )
    evidence.push(`range-empty:${String(empty)}`)
    return { state: empty ? 'drained' : 'residue', evidence }
  } catch (error) {
    evidence.push(`range-observe-failed:${String(error)}`)
    return { state: 'residue', evidence }
  }
}

export default ShellExecutor
