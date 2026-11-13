/**
 * Handle-level teardown races: every entry point funnels through the one owner,
 * so concurrent kill, dispose, and range requests must reach it once each and
 * share one settlement.
 */

import { describe, expect, it, vi } from 'vitest'
import type { ManagedProcessLaunch, ManagedRangeAnswer } from '../src/managed-owner.ts'
import { bindManagedProcess } from '../src/spawn.ts'

const spec = {
  argv: ['tool.exe'],
  cwd: 'C:\\target',
  stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
  graceMs: 100,
} as const

function answer(state: ManagedRangeAnswer['state'], evidence: string[] = []): Promise<ManagedRangeAnswer> {
  return Promise.resolve({ state, evidence })
}

/** Launch facts whose owner records every teardown request it receives. */
function launchWith(overrides: Partial<{
  signal: ReturnType<typeof vi.fn>
  terminateRange: ReturnType<typeof vi.fn>
  verifyRange: ReturnType<typeof vi.fn>
  waitForExit: ReturnType<typeof vi.fn>
}> = {}): {
  launch: ManagedProcessLaunch
  owner: {
    signal: ReturnType<typeof vi.fn>
    waitForExit: ReturnType<typeof vi.fn>
    terminateForHostExit: ReturnType<typeof vi.fn>
    terminateRange: ReturnType<typeof vi.fn>
    verifyRange: ReturnType<typeof vi.fn>
  }
  settleRange: () => void
} {
  let settleRange: () => void = () => {}
  const rangeExited = new Promise<void>((resolve) => { settleRange = resolve })
  const owner = {
    signal: overrides.signal ?? vi.fn(),
    waitForExit: overrides.waitForExit ?? vi.fn(() => rangeExited),
    terminateForHostExit: vi.fn(),
    terminateRange: overrides.terminateRange ?? vi.fn(() => answer('terminated')),
    verifyRange: overrides.verifyRange ?? vi.fn(() => answer('partial')),
  }
  const launch = {
    stdin: null,
    stdout: null,
    stderr: null,
    direct: Promise.resolve({ exitCode: 0, signal: null }),
    owner,
  } as unknown as ManagedProcessLaunch
  return { launch, owner, settleRange }
}

describe('handle teardown races', () => {
  it('sends one termination request for repeated and concurrent terminate() calls', async () => {
    const { launch, owner, settleRange } = launchWith()
    const handle = bindManagedProcess(spec, launch)

    handle.terminate()
    handle.terminate()
    expect(owner.signal).toHaveBeenCalledOnce()
    expect(owner.signal).toHaveBeenCalledWith('SIGTERM', expect.anything())

    settleRange()
    await expect(handle.waitForExit()).resolves.toBe(true)
  })

  it('forwards terminateRange once while a kill is in flight, without closing twice', async () => {
    const { launch, owner, settleRange } = launchWith()
    const handle = bindManagedProcess(spec, launch)

    const shared = answer('terminated', ['request'])
    owner.terminateRange.mockReturnValue(shared)

    handle.terminate()
    const [first, second] = await Promise.all([
      handle.terminateRange?.(),
      handle.terminateRange?.(),
    ])

    expect(owner.terminateRange).toHaveBeenCalledTimes(2)
    // The provider owns de-duplication: both callers observe the same settlement.
    expect(first).toBe(second)
    expect(first).toMatchObject({ state: 'terminated' })
    expect(owner.signal).toHaveBeenCalledOnce()

    settleRange()
    await expect(handle.waitForExit()).resolves.toBe(true)
  })

  it('keeps a failed range observation a rejection, never a false success', async () => {
    const { launch } = launchWith({ waitForExit: vi.fn(() => Promise.reject(new Error('runner-disconnected'))) })
    const handle = bindManagedProcess(spec, launch)

    await expect(handle.waitForExit()).rejects.toThrow('runner-disconnected')
  })

  it('exposes no range operations for providers that lack them', () => {
    const { launch } = launchWith()
    delete (launch.owner as { terminateRange?: unknown }).terminateRange
    delete (launch.owner as { verifyRange?: unknown }).verifyRange
    const handle = bindManagedProcess(spec, launch)

    expect('terminateRange' in handle).toBe(false)
    expect('verifyRange' in handle).toBe(false)
  })
})
