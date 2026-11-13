/**
 * Product teardown on a real Windows Job: the same composition the runtime
 * uses (launchWindowsJob + bindManagedProcess), driven through the handle
 * surface a shell process actually receives.
 *
 * Usage: pnpm exec tsx packages/subprocess/subprocess-local/verify/d7-r2-product-teardown-e2e.ts
 */

import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchWindowsJob } from '../src/windows-job.ts'
import { bindManagedProcess } from '../src/spawn.ts'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'

const VERIFY_DIR = fileURLToPath(new URL('.', import.meta.url))
const TARGET_SCRIPT = join(VERIFY_DIR, 'd7-r2-diagnostic-target.mjs')
const CHILD_SCRIPT = join(VERIFY_DIR, 'd7-r2-diagnostic-child.mjs')

function env(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  )
}

async function main(): Promise<void> {
  if (process.platform !== 'win32') {
    console.error('requires Windows')
    process.exit(2)
  }
  const disconnect = process.argv.includes('--disconnect')
  const runnerIndex = process.argv.indexOf('--runner')
  const runnerPath = runnerIndex >= 0 ? process.argv[runnerIndex + 1] : undefined
  const dir = mkdtempSync(join(tmpdir(), 'dsh-d7-r2-product-'))
  const ready = join(dir, 'ready.json')
  const release = join(dir, 'release.signal')
  const nonce = randomUUID()
  const spec: SubprocessSpawnSpec = {
    argv: [process.execPath, TARGET_SCRIPT, ready, release, nonce, CHILD_SCRIPT],
    cwd: dir,
    stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
    graceMs: 5_000,
  }

  // Exactly the runtime composition: launcher facts bound to the public handle.
  const handle = bindManagedProcess(
    spec,
    runnerPath === undefined
      ? launchWindowsJob(spec, env())
      : launchWindowsJob(spec, env(), { runnerInvocation: [process.execPath, runnerPath] }),
  )
  handle.stdout?.resume()
  handle.stderr?.resume()

  for (let waited = 0; !existsSync(ready); waited += 20) {
    if (waited > 20_000) { console.log(JSON.stringify({ pass: false, failure: 'ready-timeout' })); process.exit(1) }
    await new Promise((resolve) => { setTimeout(resolve, 20) })
  }
  writeFileSync(release, '')

  const outcome = await handle.done
  // A settled direct process must not prove the Job empty: the surviving child
  // keeps the range observation pending.
  const stillPending = await Promise.race([
    handle.waitForExit().then(() => 'settled'),
    new Promise((resolve) => { setTimeout(() => resolve('pending'), 250) }),
  ])

  const terminateRange = handle.terminateRange
  const verifyRange = handle.verifyRange
  if (terminateRange === undefined || verifyRange === undefined) {
    console.log(JSON.stringify({ pass: false, failure: 'handle-missing-range-operations', outcome, stillPending }))
    process.exit(1)
  }
  if (disconnect) {
    // P-06: the runner dies mid-range. Nothing may be reported as empty, and
    // KILL_ON_JOB_CLOSE must still reap the surviving Job member.
    const childPid = JSON.parse(readFileSync(ready, 'utf8')).pid as number
    handle.terminateForHostExit()
    let observation: 'empty' | 'rejected' | 'aborted' = 'aborted'
    try {
      observation = (await handle.waitForExit()) ? 'empty' : 'aborted'
    } catch {
      observation = 'rejected'
    }
    let childGone = false
    for (let waited = 0; waited < 5_000; waited += 50) {
      try {
        process.kill(childPid, 0)
      } catch {
        childGone = true
        break
      }
      await new Promise((resolve) => { setTimeout(resolve, 50) })
    }
    const checks = {
      directExit: outcome.exitCode === 0,
      doneDoesNotProveRangeEmpty: stillPending === 'pending',
      rangeNotReportedEmpty: observation !== 'empty',
      survivingMemberReapedByJobClose: childGone,
    }
    const pass = Object.values(checks).every(Boolean)
    console.log(JSON.stringify({ pass, mode: 'disconnect', checks, outcome, observation, childPid, childGone, dir }, null, 2))
    process.exit(pass ? 0 : 1)
  }

  const observed = await verifyRange()
  const terminated = await terminateRange()
  const drained = await handle.waitForExit()

  const checks = {
    directExit: outcome.exitCode === 0,
    doneDoesNotProveRangeEmpty: stillPending === 'pending',
    verifyObservedLiveRange: observed.state === 'partial',
    terminateProvedTerminal: terminated.state === 'terminated' || terminated.state === 'empty',
    rangeDrainedAfterTermination: drained === true,
  }
  const pass = Object.values(checks).every(Boolean)
  console.log(JSON.stringify({ pass, checks, outcome, stillPending, observed, terminated, drained, dir }, null, 2))
  process.exit(pass ? 0 : 1)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
