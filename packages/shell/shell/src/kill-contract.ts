/**
 * One termination entry point for a shell process, so no caller has to chain
 * `kill()` and a range termination by hand.
 *
 * Contract:
 * - `kill()` keeps its frozen meaning — a termination request was accepted;
 * - while the direct process runs, the process-level kill is the request;
 * - once the direct process is done but the managed range may still hold
 *   members, the request goes to `terminateRange()` instead;
 * - neither path waits, and neither implies the range is empty.
 *
 * @module @deepseek-ai/dsh-shell/kill-contract
 */

export interface KillableProcess {
  /** True once the direct process settled; never a range observation. */
  readonly done: boolean
  kill(): boolean
  terminateRange?(): void
}

/**
 * Request termination of whatever is still alive.
 * @returns whether a termination request was accepted by some layer.
 */
export function requestTermination(process: KillableProcess): boolean {
  if (!process.done) return process.kill()
  if (process.terminateRange === undefined) return process.kill()
  try {
    process.terminateRange()
    return true
  } catch {
    return process.kill()
  }
}
