/**
 * Host-side range requester: request ids are per-process, job identity is the
 * runner's stable Job id, so a reused PID can never bind a stale answer.
 *
 * @module @deepseek-ai/dsh-subprocess-local/windows-range
 */

/** Contract result the host acts on. */
export interface RangeAnswer {
  readonly state: 'terminated' | 'empty' | 'partial' | 'unknown'
  readonly activeBefore?: number | undefined
  readonly activeAfter?: number | undefined
  readonly evidence: readonly string[]
  readonly observedAt?: string
}

/** Minimal IPC surface, so the requester is testable without a real runner. */
export interface RangeTransport {
  send(message: unknown): void
  onMessage(listener: (value: unknown) => void): void
  offMessage(listener: (value: unknown) => void): void
}

export class RangeRequester {
  private sequence = 0
  private readonly pending = new Map<number, { resolve: (answer: RangeAnswer) => void; timer: ReturnType<typeof setTimeout> }>()
  private jobId: string | undefined
  private disconnected = false
  private termination?: Promise<RangeAnswer>

  constructor(private readonly transport: RangeTransport) {
    this.transport.onMessage((value) => { this.onMessage(value) })
  }

  /** Bind the stable Job identity reported by the runner's start ack. */
  bindJob(jobId: string): void {
    this.jobId = jobId
  }

  /** The runner is gone: every in-flight request becomes provably unknown. */
  runnerGone(reason: string): void {
    this.disconnected = true
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.resolve({ state: 'unknown', evidence: [reason] })
      this.pending.delete(id)
    }
  }

  /** One shared termination per owner instance; repeats return the same answer. */
  terminateRange(timeoutMs = 5_000): Promise<RangeAnswer> {
    this.termination ??= this.request('terminate-range', timeoutMs)
    return this.termination
  }

  /** Re-observe the range later without terminating it again. */
  verifyRange(timeoutMs = 5_000): Promise<RangeAnswer> {
    return this.request('verify-range', timeoutMs)
  }

  private request(type: 'terminate-range' | 'verify-range', timeoutMs: number): Promise<RangeAnswer> {
    if (this.disconnected) {
      return Promise.resolve({ state: 'unknown', evidence: ['runner-disconnected'] })
    }
    const requestId = ++this.sequence
    return new Promise<RangeAnswer>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        resolve({ state: 'unknown', evidence: [`ack-timeout:${String(timeoutMs)}`] })
      }, timeoutMs)
      this.pending.set(requestId, { resolve, timer })
      try {
        this.transport.send({ type, requestId })
      } catch (error) {
        this.pending.delete(requestId)
        clearTimeout(timer)
        resolve({ state: 'unknown', evidence: [`send-failed:${String(error)}`] })
      }
    })
  }

  private onMessage(value: unknown): void {
    const reply = value as { type?: string; requestId?: number; jobId?: string; state?: string; evidence?: unknown[] }
    if (reply.type !== 'range-result' || typeof reply.requestId !== 'number') return
    const entry = this.pending.get(reply.requestId)
    if (entry === undefined) return
    this.pending.delete(reply.requestId)
    clearTimeout(entry.timer)
    // Identity check: an answer for another Job is not this owner's answer.
    if (this.jobId !== undefined && reply.jobId !== this.jobId) {
      entry.resolve({ state: 'unknown', evidence: ['job-id-mismatch'] })
      return
    }
    const state = reply.state === 'terminated' || reply.state === 'empty' || reply.state === 'partial' || reply.state === 'unknown' ? reply.state : 'unknown'
    entry.resolve({ state, activeBefore: undefined, activeAfter: undefined, evidence: Array.isArray(reply.evidence) ? reply.evidence.map(String) : [] })
  }
}
