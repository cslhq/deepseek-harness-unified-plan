/**
 * Host-side range requester contract: identity fail-closed, request/response
 * correlation, timeout, disconnect, and the terminal cache. Every case drives
 * the real `RangeRequester` over a fake transport, so the tested unit is exactly
 * the object the Windows owner uses.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { RangeRequester } from '../src/windows-range.ts'
import type { RangeAnswer, RangeTransport } from '../src/windows-range.ts'

/** IPC stand-in: records what the requester sends and delivers runner replies. */
class FakeTransport implements RangeTransport {
  readonly sent: unknown[] = []
  private readonly listeners = new Set<(value: unknown) => void>()
  throwOnSend: unknown

  send(message: unknown): void {
    if (this.throwOnSend !== undefined) throw this.throwOnSend
    this.sent.push(message)
  }

  onMessage(listener: (value: unknown) => void): void {
    this.listeners.add(listener)
  }

  offMessage(listener: (value: unknown) => void): void {
    this.listeners.delete(listener)
  }

  deliver(value: unknown): void {
    for (const listener of [...this.listeners]) listener(value)
  }
}

/** Reply shaped like the runner's range-result envelope. */
function reply(
  requestId: number,
  state: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return { type: 'range-result', requestId, jobId: 'job-1', instanceId: 'inst-1', state, evidence: [`state:${state}`], ...overrides }
}

/** Requester with the runner identity the protocol requires. */
function boundRequester(transport: FakeTransport): RangeRequester {
  const requester = new RangeRequester(transport)
  requester.bindIdentity('job-1', 'inst-1')
  return requester
}

/** Track settlement without awaiting, so "still pending" is observable. */
function tracked<Value>(promise: Promise<Value>): { readonly settled: () => boolean; readonly value: () => Value | undefined } {
  let settled = false
  let value: Value | undefined
  void promise.then((result) => { settled = true; value = result }, () => { settled = true })
  return { settled: () => settled, value: () => value }
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('RangeRequester identity fail-closed', () => {
  it('answers identity-unbound without sending, pending, or a timer', async () => {
    vi.useFakeTimers()
    const transport = new FakeTransport()
    const requester = new RangeRequester(transport)

    const answer: RangeAnswer = await requester.verifyRange(1_000)
    expect(answer).toEqual({ state: 'unknown', evidence: ['identity-unbound'] })
    expect(transport.sent).toEqual([])
    // No ACK timer was armed for a request that never left the process.
    expect(vi.getTimerCount()).toBe(0)
    // The request id sequence never advanced: the first real request takes id 1.
    requester.bindIdentity('job-1', 'inst-1')
    void requester.verifyRange(1_000)
    expect(transport.sent).toEqual([{ type: 'verify-range', requestId: 1 }])
  })

  it('fails closed when only the jobId is bound', async () => {
    const transport = new FakeTransport()
    const requester = new RangeRequester(transport)
    requester.bindIdentity('job-1', undefined as never)

    await expect(requester.verifyRange(1_000)).resolves.toEqual({ state: 'unknown', evidence: ['identity-unbound'] })
    expect(transport.sent).toEqual([])
  })

  it('fails closed when only the instanceId is bound', async () => {
    const transport = new FakeTransport()
    const requester = new RangeRequester(transport)
    requester.bindIdentity(undefined as never, 'inst-1')

    await expect(requester.terminateRange(1_000)).resolves.toEqual({ state: 'unknown', evidence: ['identity-unbound'] })
    expect(transport.sent).toEqual([])
  })

  it('does not memoize an unbound termination, so binding later still terminates', async () => {
    const transport = new FakeTransport()
    const requester = new RangeRequester(transport)

    await expect(requester.terminateRange(1_000)).resolves.toEqual({ state: 'unknown', evidence: ['identity-unbound'] })
    expect(transport.sent).toEqual([])

    requester.bindIdentity('job-1', 'inst-1')
    const terminate = requester.terminateRange(1_000)
    expect(transport.sent).toEqual([{ type: 'terminate-range', requestId: 1 }])
    transport.deliver(reply(1, 'terminated'))
    await expect(terminate).resolves.toMatchObject({ state: 'terminated' })
    // The shared termination promise is now the real one.
    expect(requester.terminateRange(1_000)).toBe(terminate)
  })

  it('never caches identity-unbound as terminal evidence', async () => {
    const transport = new FakeTransport()
    const requester = new RangeRequester(transport)

    await requester.verifyRange(1_000)
    requester.bindIdentity('job-1', 'inst-1')
    const verify = requester.verifyRange(1_000)
    expect(transport.sent).toHaveLength(1)
    transport.deliver(reply(1, 'partial'))
    await expect(verify).resolves.toMatchObject({ state: 'partial' })
  })

  it('sends once both identities are bound and still fences mismatched replies', async () => {
    const transport = new FakeTransport()
    const requester = boundRequester(transport)

    const pending = requester.verifyRange(1_000)
    expect(transport.sent).toEqual([{ type: 'verify-range', requestId: 1 }])

    transport.deliver(reply(1, 'terminated', { instanceId: 'inst-2' }))
    await expect(pending).resolves.toEqual({ state: 'unknown', evidence: ['instance-id-mismatch'] })
  })
})

describe('RangeRequester request identity', () => {
  it('shares one promise for repeated terminate requests and sends once', async () => {
    const transport = new FakeTransport()
    const requester = boundRequester(transport)

    const first = requester.terminateRange(1_000)
    const second = requester.terminateRange(1_000)
    expect(second).toBe(first)
    expect(transport.sent).toEqual([{ type: 'terminate-range', requestId: 1 }])

    transport.deliver(reply(1, 'terminated'))
    await expect(first).resolves.toMatchObject({ state: 'terminated' })
    await expect(second).resolves.toMatchObject({ state: 'terminated' })
  })

  it('keeps a concurrent verify independent from the in-flight terminate', async () => {
    const transport = new FakeTransport()
    const requester = boundRequester(transport)

    const terminate = requester.terminateRange(1_000)
    const verify = requester.verifyRange(1_000)
    expect(transport.sent).toEqual([
      { type: 'terminate-range', requestId: 1 },
      { type: 'verify-range', requestId: 2 },
    ])

    const terminateTracked = tracked(terminate)
    transport.deliver(reply(2, 'partial'))
    await expect(verify).resolves.toMatchObject({ state: 'partial' })
    await flush()
    // The verify answer must not settle the termination.
    expect(terminateTracked.settled()).toBe(false)

    transport.deliver(reply(1, 'terminated'))
    await expect(terminate).resolves.toMatchObject({ state: 'terminated' })
  })

  it('correlates answers by requestId, never by arrival order', async () => {
    const transport = new FakeTransport()
    const requester = boundRequester(transport)

    const first = requester.verifyRange(1_000)
    const second = requester.verifyRange(1_000)
    const firstTracked = tracked(first)

    transport.deliver(reply(2, 'partial'))
    await expect(second).resolves.toMatchObject({ state: 'partial' })
    await flush()
    expect(firstTracked.settled()).toBe(false)

    transport.deliver(reply(1, 'empty'))
    await expect(first).resolves.toMatchObject({ state: 'empty' })
  })

  it('ignores a reply for an unknown requestId', async () => {
    const transport = new FakeTransport()
    const requester = boundRequester(transport)
    const pending = tracked(requester.verifyRange(1_000))

    transport.deliver(reply(99, 'terminated'))
    await flush()
    expect(pending.settled()).toBe(false)

    transport.deliver(reply(1, 'partial'))
    await flush()
    expect(pending.settled()).toBe(true)
    expect(pending.value()).toMatchObject({ state: 'partial' })
  })

  it('ignores replies that are not a range-result with a numeric id', async () => {
    const transport = new FakeTransport()
    const requester = boundRequester(transport)
    const pending = tracked(requester.verifyRange(1_000))

    for (const value of [null, 'x', 42, { type: 'range-result' }, { type: 'range-result', requestId: '1', state: 'empty' }, { type: 'verify-result', requestId: 1.5, state: 'empty' }]) {
      transport.deliver(value)
    }
    await flush()
    expect(pending.settled()).toBe(false)

    transport.deliver(reply(1, 'partial'))
    await flush()
    expect(pending.settled()).toBe(true)
  })
})

describe('RangeRequester identity fencing', () => {
  it('rejects an answer for another Job and keeps the terminal cache clean', async () => {
    const transport = new FakeTransport()
    const requester = boundRequester(transport)

    const pending = requester.verifyRange(1_000)
    transport.deliver(reply(1, 'empty', { jobId: 'job-2' }))
    await expect(pending).resolves.toEqual({ state: 'unknown', evidence: ['job-id-mismatch'] })
    // The mismatched reply must not become trusted terminal evidence.
    void requester.verifyRange(1_000)
    expect(transport.sent).toHaveLength(2)
  })

  it('rejects an answer from another runner instance', async () => {
    const transport = new FakeTransport()
    const requester = boundRequester(transport)

    const pending = requester.terminateRange(1_000)
    transport.deliver(reply(1, 'terminated', { instanceId: 'inst-2' }))
    await expect(pending).resolves.toEqual({ state: 'unknown', evidence: ['instance-id-mismatch'] })
    // A later verify still goes to the wire: nothing was cached.
    void requester.verifyRange(1_000)
    expect(transport.sent).toHaveLength(2)
  })
})

describe('RangeRequester failure and timeout paths', () => {
  it('times out an unanswered request and ignores its late reply', async () => {
    vi.useFakeTimers()
    const transport = new FakeTransport()
    const requester = boundRequester(transport)

    const pending = requester.verifyRange(500)
    await vi.advanceTimersByTimeAsync(500)
    await expect(pending).resolves.toEqual({ state: 'unknown', evidence: ['ack-timeout:500'] })

    // The late answer neither settles the timed-out call nor caches a terminal state.
    transport.deliver(reply(1, 'terminated'))
    const next = requester.verifyRange(500)
    expect(transport.sent).toHaveLength(2)
    transport.deliver(reply(2, 'partial'))
    await expect(next).resolves.toMatchObject({ state: 'partial' })
  })

  it('reports a synchronous send failure without leaving a pending entry', async () => {
    const transport = new FakeTransport()
    const requester = boundRequester(transport)
    transport.throwOnSend = new Error('ipc closed')

    const pending = requester.terminateRange(1_000)
    const answer = await pending
    expect(answer.state).toBe('unknown')
    expect(answer.evidence[0]).toContain('send-failed')
    expect(answer.evidence[0]).toContain('ipc closed')

    // The failed id was removed: its late answer settles nothing, and the next
    // request must correlate with its own reply.
    transport.throwOnSend = undefined
    const next = requester.verifyRange(1_000)
    transport.deliver(reply(1, 'terminated'))
    transport.deliver(reply(2, 'partial'))
    await expect(next).resolves.toMatchObject({ state: 'partial' })
  })

  it('fails every in-flight request when the runner disappears', async () => {
    const transport = new FakeTransport()
    const requester = boundRequester(transport)

    const terminate = requester.terminateRange(5_000)
    const verify = requester.verifyRange(5_000)
    requester.runnerGone('runner-exit')

    await expect(terminate).resolves.toEqual({ state: 'unknown', evidence: ['runner-exit'] })
    await expect(verify).resolves.toEqual({ state: 'unknown', evidence: ['runner-exit'] })

    // Subsequent requests short-circuit instead of writing to a dead channel.
    const sentBefore = transport.sent.length
    await expect(requester.verifyRange(5_000)).resolves.toEqual({ state: 'unknown', evidence: ['runner-disconnected'] })
    expect(transport.sent).toHaveLength(sentBefore)
  })
})

describe('RangeRequester terminal cache', () => {
  it('answers a later verify from trusted terminated evidence without a new request', async () => {
    const transport = new FakeTransport()
    const requester = boundRequester(transport)

    const terminate = requester.terminateRange(1_000)
    transport.deliver(reply(1, 'terminated'))
    await expect(terminate).resolves.toMatchObject({ state: 'terminated' })

    const sentBefore = transport.sent.length
    await expect(requester.verifyRange(1_000)).resolves.toMatchObject({
      state: 'terminated',
      evidence: ['state:terminated', 'cached-terminal'],
    })
    expect(transport.sent).toHaveLength(sentBefore)
  })

  it('caches empty but never caches partial or unknown', async () => {
    const transport = new FakeTransport()
    const requester = boundRequester(transport)

    const first = requester.verifyRange(1_000)
    transport.deliver(reply(1, 'empty'))
    await expect(first).resolves.toMatchObject({ state: 'empty' })
    await expect(requester.verifyRange(1_000)).resolves.toMatchObject({ state: 'empty', evidence: ['state:empty', 'cached-terminal'] })

    // A second requester observes non-terminal states: they must not be cached.
    const transport2 = new FakeTransport()
    const requester2 = boundRequester(transport2)
    const partial = requester2.verifyRange(1_000)
    transport2.deliver(reply(1, 'partial'))
    await expect(partial).resolves.toMatchObject({ state: 'partial' })
    void requester2.verifyRange(1_000)
    expect(transport2.sent).toHaveLength(2)

    const unknown = requester2.verifyRange(1_000)
    transport2.deliver(reply(3, 'unknown'))
    await expect(unknown).resolves.toMatchObject({ state: 'unknown' })
    void requester2.verifyRange(1_000)
    expect(transport2.sent).toHaveLength(4)
  })

  it('never turns unknown into empty and never trusts an unrecognized state', async () => {
    const transport = new FakeTransport()
    const requester = boundRequester(transport)

    const unknown = requester.verifyRange(1_000)
    transport.deliver(reply(1, 'unknown'))
    const answer: RangeAnswer = await unknown
    expect(answer.state).toBe('unknown')
    expect(answer.state).not.toBe('empty')

    const unrecognized = requester.verifyRange(1_000)
    transport.deliver(reply(2, 'quiescent'))
    await expect(unrecognized).resolves.toMatchObject({ state: 'unknown' })

    // Neither answer was terminal evidence: the next verify takes the wire again.
    void requester.verifyRange(1_000)
    expect(transport.sent).toHaveLength(3)
  })
})
