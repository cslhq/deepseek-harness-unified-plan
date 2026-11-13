/**
 * Product teardown policy: one settlement helper proves a shell process's
 * managed range before any caller may report the work released.
 */

import { describe, expect, it, vi } from 'vitest'
import { settleManagedRange } from '../src/index.ts'
import type { ShellProcess, ShellRangeAnswer } from '../src/index.ts'

/** Build a settled process whose range operations are scripted per test. */
function processStub(overrides: Partial<ShellProcess> = {}): ShellProcess {
  return {
    status: 'completed',
    exitCode: 0,
    signal: null,
    done: Promise.resolve(),
    readOutput: () => ({ delta: '', lossy: false }),
    observed: {
      stdout: { readFrom: (from: number) => ({ text: '', nextOffset: from, lossy: false }) },
      stderr: { readFrom: (from: number) => ({ text: '', nextOffset: from, lossy: false }) },
    },
    kill: () => false,
    waitForExit: () => Promise.resolve(true),
    ...overrides,
  }
}

function answer(state: ShellRangeAnswer['state']): Promise<ShellRangeAnswer> {
  return Promise.resolve({ state, evidence: [`state:${state}`] })
}

describe('settleManagedRange', () => {
  it('reports drained for an already-empty range without requesting termination', async () => {
    const terminateRange = vi.fn(() => answer('terminated'))
    const settlement = await settleManagedRange(processStub({
      verifyRange: () => answer('empty'),
      terminateRange,
    }))

    expect(settlement.state).toBe('drained')
    expect(terminateRange).not.toHaveBeenCalled()
    // The probe alone proves an already-empty range: no range request is sent.
    expect(settlement.evidence).toEqual(['probe-empty:true'])
  })

  it('terminates a live range and reports drained only after the proof', async () => {
    const terminateRange = vi.fn(() => answer('terminated'))
    const waitForExit = vi.fn().mockReturnValueOnce(Promise.resolve(false)).mockReturnValue(Promise.resolve(true))
    const settlement = await settleManagedRange(processStub({
      verifyRange: () => answer('partial'),
      terminateRange,
      waitForExit,
    }))

    expect(terminateRange).toHaveBeenCalledOnce()
    expect(settlement.state).toBe('drained')
    expect(settlement.evidence).toEqual(['probe-empty:false', 'verify:partial', 'terminate:terminated', 'range-empty:true'])
  })

  it('never turns an aborted range wait into a drained state', async () => {
    const settlement = await settleManagedRange(processStub({
      waitForExit: () => Promise.resolve(false),
    }))

    expect(settlement.state).toBe('residue')
    expect(settlement.evidence).toContain('range-empty:false')
  })

  it('reports residue when the range cannot be observed', async () => {
    const settlement = await settleManagedRange(processStub({
      waitForExit: () => Promise.reject(new Error('owner unreadable')),
    }))

    expect(settlement.state).toBe('residue')
    expect(String(settlement.evidence.at(-1))).toContain('range-observe-failed')
  })

  it('reports residue when termination fails but keeps the provider evidence', async () => {
    const settlement = await settleManagedRange(processStub({
      verifyRange: () => answer('partial'),
      terminateRange: () => Promise.reject(new Error('TerminateJobObject failed (Win32 5)')),
      waitForExit: () => Promise.resolve(false),
    }))

    expect(settlement.state).toBe('residue')
    expect(settlement.evidence).toEqual([
      'probe-empty:false',
      'verify:partial',
      'terminate-failed:Error: TerminateJobObject failed (Win32 5)',
      'range-empty:false',
    ])
  })

  it('treats an identity-unbound termination as unproven, never as success', async () => {
    const settlement = await settleManagedRange(processStub({
      terminateRange: () => answer('unknown'),
      waitForExit: () => Promise.resolve(false),
    }))

    expect(settlement.state).toBe('residue')
    expect(settlement.evidence).toEqual(['probe-empty:false', 'terminate:unknown', 'range-empty:false'])
  })

  it('does not terminate when observation already proves the range empty', async () => {
    const terminateRange = vi.fn(() => answer('terminated'))
    await settleManagedRange(processStub({
      verifyRange: () => answer('terminated'),
      terminateRange,
    }))
    expect(terminateRange).not.toHaveBeenCalled()
  })

  it('keeps concurrent settlements consistent without double release', async () => {
    const shared = answer('terminated')
    const terminateRange = vi.fn(() => shared)
    const process = processStub({
      verifyRange: () => answer('partial'),
      terminateRange,
      waitForExit: vi.fn()
        .mockReturnValueOnce(Promise.resolve(false))
        .mockReturnValueOnce(Promise.resolve(false))
        .mockReturnValue(Promise.resolve(true)),
    })

    const [first, second] = await Promise.all([
      settleManagedRange(process),
      settleManagedRange(process),
    ])

    expect(first.state).toBe('drained')
    expect(second.state).toBe('drained')
    // The provider owns request de-duplication; the policy calls it once per
    // settlement and never releases anything itself.
    expect(terminateRange).toHaveBeenCalledTimes(2)
  })
})
