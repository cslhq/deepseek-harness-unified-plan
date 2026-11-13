/**
 * Runner-side `terminate-range` handling. The runner owns the only Job handle,
 * so it is the only process that can terminate and re-observe the range.
 *
 * @module @deepseek-ai/dsh-win32-runner/range-handler
 */

import { isJobEmpty, terminateJobRange } from '@deepseek-ai/dsh-win32-process'
import type { Win32ProcessBindings } from '@deepseek-ai/dsh-win32-process'
import type { NativePtr } from '@deepseek-ai/dsh-win32-process'

/** Request/response contract between the host and the runner. */
/** Narrow an unknown IPC message to a range request; invalid shapes are ignored. */
export function parseRangeRequest(value: unknown): RangeRequest | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const message = value as { type?: unknown; requestId?: unknown }
  if (message.type !== 'terminate-range' && message.type !== 'verify-range') return undefined
  if (typeof message.requestId !== 'number' || !Number.isSafeInteger(message.requestId)) return undefined
  return { type: message.type, requestId: message.requestId }
}

/** True for a message shaped like a range request, valid or not. */
export function isWindowsRangeLikeRequest(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false
  const message = value as { type?: unknown }
  return message.type === 'terminate-range' || message.type === 'verify-range'
}

export interface RangeRequest {
  readonly type: 'terminate-range' | 'verify-range'
  readonly requestId: number
}

export interface RangeReply {
  readonly type: 'range-result'
  readonly requestId: number
  /** Stable per-Job identity; never a PID (PIDs are reused). */
  readonly jobId: string
  readonly state: 'terminated' | 'empty' | 'partial' | 'unknown'
  readonly activeBefore?: number | undefined
  readonly activeAfter?: number | undefined
  readonly evidence: readonly string[]
  readonly observedAt: string
}

/**
 * Answer one range request against the runner's own Job handle.
 * `verify-range` never terminates: it only re-observes, so an ACK can be
 * re-checked later without a second termination.
 */
export async function handleRangeRequest(
  api: Win32ProcessBindings,
  job: NativePtr,
  jobId: string,
  request: RangeRequest,
): Promise<RangeReply> {
  const observedAt = new Date().toISOString()
  if (request.type === 'verify-range') {
    // Pure observation: never reuses the termination helper.
    try {
      const empty = isJobEmpty(api, job)
      return { type: 'range-result', requestId: request.requestId, jobId, state: empty ? 'empty' : 'partial', evidence: [`verify:${String(empty)}`], observedAt }
    } catch (error) {
      return { type: 'range-result', requestId: request.requestId, jobId, state: 'unknown', evidence: [`verify-failed:${String(error)}`], observedAt }
    }
  }
  // The runner answers every request, so a native termination failure is mapped to
  // an explicit unknown reply instead of rejecting out of the IPC handler.
  let result: Awaited<ReturnType<typeof terminateJobRange>>
  try {
    result = await terminateJobRange(api, job)
  } catch (error) {
    return {
      type: 'range-result',
      requestId: request.requestId,
      jobId,
      state: 'unknown',
      evidence: [`terminate-failed:${String(error)}`],
      observedAt,
    }
  }
  return { type: 'range-result', requestId: request.requestId, jobId, state: result.state, activeBefore: result.activeBefore, activeAfter: result.activeAfter, evidence: result.evidence, observedAt }
}
