/**
 * Range termination for a Windows Job Object: request the termination, then
 * re-observe the active count. The request result alone never proves the range
 * is empty, so the classification always comes from the second query.
 *
 * @module @deepseek-ai/dsh-win32-process/range
 */

import { isJobEmpty, terminateJob } from './process.ts'
import type { Win32ProcessBindings } from './ffi.ts'
import type { NativePtr } from './ffi.ts'

/** Proven outcome of one range termination attempt. */
export interface JobRangeResult {
  readonly state: 'terminated' | 'empty' | 'partial' | 'unknown'
  readonly activeBefore?: number
  readonly activeAfter?: number
  readonly evidence: readonly string[]
}

export interface TerminateJobRangeOptions {
  readonly attempts?: number
  readonly delayMs?: number
  readonly exitCode?: number
  readonly sleep?: (ms: number) => Promise<void>
}

/**
 * Terminate every process the job still holds and prove the result.
 * An empty range is reported as `empty` without calling TerminateJobObject;
 * a failed or unprovable observation is `unknown`, never `terminated`.
 */
export async function terminateJobRange(
  api: Win32ProcessBindings,
  job: NativePtr,
  options: TerminateJobRangeOptions = {},
): Promise<JobRangeResult> {
  const attempts = options.attempts ?? 20
  const delayMs = options.delayMs ?? 50
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms) }))
  const evidence: string[] = []
  try {
    if (isJobEmpty(api, job)) return { state: 'empty', activeBefore: 0, activeAfter: 0, evidence: ['range-already-empty'] }
  } catch (error) {
    return { state: 'unknown', evidence: [`query-before-failed:${String(error)}`] }
  }
  const terminated = terminateJob(api, job, options.exitCode ?? 1)
  evidence.push(`TerminateJobObject:${terminated}`)
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      if (isJobEmpty(api, job)) return { state: 'terminated', activeAfter: 0, evidence }
    } catch (error) {
      return { state: 'unknown', evidence: [...evidence, `query-after-failed:${String(error)}`] }
    }
    await sleep(delayMs)
  }
  return { state: 'partial', evidence: [...evidence, 'range-still-active'] }
}
