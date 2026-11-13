/**
 * Product job teardown: a background job reports a terminal outcome only after
 * its managed range is proven empty, and a surviving range becomes a failed
 * job carrying the residue evidence.
 */

import { describe, expect, it, vi } from 'vitest'
import type { ShellProcess } from '@deepseek-ai/dsh-shell'
import { processJob, processOutcome } from '../src/background.ts'

/** Settled process whose range operations are scripted per test. */
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

describe('background job managed-range settlement', () => {
  it('reports a completed job only after the range proves empty', async () => {
    const hooks = processJob(
      () => Promise.resolve(processStub()),
      (proc, settlement) => processOutcome(proc, [], settlement),
    )

    await expect(hooks.done).resolves.toMatchObject({ status: 'completed', detail: 'exit code: 0' })
  })

  it('reports a failed job when a survivor keeps the range non-empty', async () => {
    const hooks = processJob(
      () => Promise.resolve(processStub({ waitForExit: () => Promise.resolve(false) })),
      (proc, settlement) => processOutcome(proc, [], settlement),
    )

    const outcome = await hooks.done
    expect(outcome.status).toBe('failed')
    expect(String(outcome.detail)).toContain('managed process range not proven empty')
    expect(String(outcome.detail)).toContain('range-empty:false')
  })

  it('does not request termination for a range that already proves empty', async () => {
    const terminateRange = vi.fn(() => Promise.resolve({ state: 'terminated' as const, evidence: [] }))
    const hooks = processJob(
      () => Promise.resolve(processStub({
        verifyRange: () => Promise.resolve({ state: 'empty' as const, evidence: ['verify:empty'] }),
        terminateRange,
      })),
      (proc, settlement) => processOutcome(proc, [], settlement),
    )

    await expect(hooks.done).resolves.toMatchObject({ status: 'completed' })
    expect(terminateRange).not.toHaveBeenCalled()
  })

  it('terminates a surviving range before the job settles', async () => {
    const terminateRange = vi.fn(() => Promise.resolve({ state: 'terminated' as const, evidence: [] }))
    let released = false
    const process = processStub({
      verifyRange: () => Promise.resolve({ state: 'partial' as const, evidence: ['verify:partial'] }),
      terminateRange,
      waitForExit: vi.fn().mockReturnValueOnce(Promise.resolve(false)).mockReturnValue(Promise.resolve(true)),
    })
    const hooks = processJob(
      () => Promise.resolve(process),
      (proc, settlement) => {
        released = true
        return processOutcome(proc, [], settlement)
      },
    )

    await expect(hooks.done).resolves.toMatchObject({ status: 'completed' })
    expect(terminateRange).toHaveBeenCalledOnce()
    expect(released).toBe(true)
  })

  it('keeps a failed termination as residue without an unhandled rejection', async () => {
    const unhandled: unknown[] = []
    const record = (reason: unknown): void => { unhandled.push(reason) }
    process.on('unhandledRejection', record)
    try {
      const hooks = processJob(
        () => Promise.resolve(processStub({
          terminateRange: () => Promise.reject(new Error('TerminateJobObject failed (Win32 5)')),
          waitForExit: () => Promise.resolve(false),
        })),
        (proc, settlement) => processOutcome(proc, [], settlement),
      )

      const outcome = await hooks.done
      expect(outcome.status).toBe('failed')
      expect(String(outcome.detail)).toContain('terminate-failed')
      await new Promise<void>((resolve) => { setImmediate(resolve) })
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', record)
    }
  })

  it('reports residue when the runner disappears before the range can be proven', async () => {
    const unhandled: unknown[] = []
    const record = (reason: unknown): void => { unhandled.push(reason) }
    process.on('unhandledRejection', record)
    try {
      const hooks = processJob(
        () => Promise.resolve(processStub({
          verifyRange: () => Promise.resolve({ state: 'unknown' as const, evidence: ['runner-disconnected'] }),
          terminateRange: () => Promise.resolve({ state: 'unknown' as const, evidence: ['runner-disconnected'] }),
          // The owner can no longer observe the range: the provider rejects.
          waitForExit: () => Promise.reject(new Error('subprocess-local: runner-disconnected')),
        })),
        (proc, settlement) => processOutcome(proc, [], settlement),
      )

      const outcome = await hooks.done
      expect(outcome.status).toBe('failed')
      expect(String(outcome.detail)).toContain('managed process range not proven empty')
      expect(String(outcome.detail)).toContain('range-observe-failed')
      await new Promise<void>((resolve) => { setImmediate(resolve) })
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', record)
    }
  })

  it('settles the range after a cancelled job as well', async () => {
    const killed = vi.fn(() => true)
    const terminateRange = vi.fn(() => Promise.resolve({ state: 'terminated' as const, evidence: [] }))
    const hooks = processJob(
      () => Promise.resolve(processStub({
        status: 'running',
        done: Promise.resolve(),
        kill: killed,
        verifyRange: () => Promise.resolve({ state: 'partial' as const, evidence: ['verify:partial'] }),
        terminateRange,
        waitForExit: vi.fn().mockReturnValueOnce(Promise.resolve(false)).mockReturnValue(Promise.resolve(true)),
      })),
      (proc, settlement) => processOutcome(proc, [], settlement),
    )

    hooks.cancel('cancelled by test')
    const outcome = await hooks.done
    expect(outcome.status).toBe('completed')
    expect(terminateRange).toHaveBeenCalledOnce()
  })
})
