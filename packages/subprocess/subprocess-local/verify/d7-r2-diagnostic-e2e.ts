/**
 * D7-R2-2F-2 real-machine diagnostic run (T1–T5).
 *
 * The host drives the production launch path only: `launchWindowsJob` spawns the
 * real runner, the runner creates the target through `CreateProcessW`, and the
 * release handshake travels by file, never by IPC. Every observation is appended
 * to one NDJSON trace by the runner (origin "runner") and by this host (origin
 * "host"), and the run ends with a machine-checkable summary.
 *
 * Usage: pnpm exec tsx verify/d7-r2-diagnostic-e2e.ts [--off]
 *
 * `--off` runs the identical launch and range sequence with diagnostics disabled,
 * which is the behavioural control for the traced run. `--built` drives the same
 * path through the bundler output (`lib/runner.js`) instead of the tsx source form,
 * and `--runner <path>` replaces that path with an installed runner (tarball layout).
 */

import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { launchWindowsJob } from '../src/windows-job.ts'
import type { RangeTerminationResult } from '../src/windows-job.ts'
import type { BoundProcessOwner } from '../src/managed-owner.ts'

/** The Windows owner exposes the range requests the host needs for T4/T5. */
interface RangeCapableOwner extends BoundProcessOwner {
  terminateRange(timeoutMs?: number): Promise<RangeTerminationResult>
  verifyRange(timeoutMs?: number): Promise<RangeTerminationResult>
}

interface TraceEvent extends Record<string, unknown> {
  event: string
}

const VERIFY_DIR = fileURLToPath(new URL('.', import.meta.url))
const TARGET_SCRIPT = join(VERIFY_DIR, 'd7-r2-diagnostic-target.mjs')
const CHILD_SCRIPT = join(VERIFY_DIR, 'd7-r2-diagnostic-child.mjs')
/** Bundler output for the same runner core. */
const BUILT_RUNNER = join(VERIFY_DIR, '..', 'lib', 'runner.js')
const OVERALL_TIMEOUT_MS = 90_000

function appendEvent(file: string, event: string, fields: Record<string, unknown> = {}): void {
  appendFileSync(file, `${JSON.stringify({
    timestamp: new Date().toISOString(),
    monotonicMs: Number(process.hrtime.bigint() / 1_000_000n),
    event,
    origin: 'host',
    hostPid: process.pid,
    ...fields,
  })}\n`)
}

function readEvents(file: string): TraceEvent[] {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(line => line.length > 0)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as TraceEvent]
      } catch {
        return []
      }
    })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

async function waitForFile(file: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(file)) return true
    await sleep(20)
  }
  return false
}

async function waitForEvent(file: string, event: string, timeoutMs: number): Promise<TraceEvent | undefined> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = readEvents(file).find(candidate => candidate.event === event)
    if (found !== undefined) return found
    await sleep(20)
  }
  return undefined
}

/**
 * Evaluate the trace-side acceptance criteria.
 * @param t1 - child-observed record.
 * @param t2 - root-exit-observed record.
 * @param t4 - verify-range record served by the runner (the fresh T4 observation).
 * @param t5 - terminate-range record served by the runner.
 * @returns one boolean per required observation.
 */
function diagnosticEvidence(
  t1: TraceEvent | undefined,
  t2: TraceEvent | undefined,
  t4: TraceEvent | undefined,
  t5: TraceEvent | undefined,
): Record<string, boolean> {
  return {
    t1Membership: t1?.isProcessInJob === true,
    t1ActiveProcesses2: t1?.activeProcesses === 2,
    t2Membership: t2?.isProcessInJob === true,
    t2ActiveProcessesPositive: typeof t2?.activeProcesses === 'number' && t2.activeProcesses > 0,
    t2IdentityMatch: t2?.identityMatch === true,
    t4FreshActiveProcesses1: t4?.activeProcesses === 1,
    t5ActiveProcesses0: t5?.activeProcesses === 0,
    t5StateTerminal: t5?.state === 'terminated' || t5?.state === 'empty',
  }
}

function stringEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  )
}

async function main(): Promise<void> {
  if (process.platform !== 'win32') {
    console.error('D7-R2 diagnostic E2E requires Windows')
    process.exit(2)
  }
  const diagnosticsEnabled = !process.argv.includes('--off')
  const builtRunner = process.argv.includes('--built')
  const runnerOverride = ((): string | undefined => {
    const index = process.argv.indexOf('--runner')
    return index >= 0 ? process.argv[index + 1] : undefined
  })()
  const runDirectory = mkdtempSync(join(tmpdir(), 'dsh-d7-r2-e2e-'))
  const traceFile = join(runDirectory, 'trace.ndjson')
  const readyFile = join(runDirectory, 'ready.json')
  const releaseFile = join(runDirectory, 'release.signal')
  const summaryFile = join(runDirectory, 'summary.json')
  const nonce = randomUUID()

  // The runner inherits these through the ordinary launcher environment; the
  // control run removes them so no diagnostic binding can even be requested.
  if (diagnosticsEnabled) {
    process.env.DSH_RUNNER_DIAG = traceFile
    process.env.DSH_RUNNER_DIAG_READY = readyFile
    process.env.DSH_RUNNER_DIAG_NONCE = nonce
  } else {
    delete process.env.DSH_RUNNER_DIAG
    delete process.env.DSH_RUNNER_DIAG_READY
    delete process.env.DSH_RUNNER_DIAG_NONCE
  }

  const spec: SubprocessSpawnSpec = {
    argv: [process.execPath, TARGET_SCRIPT, readyFile, releaseFile, nonce, CHILD_SCRIPT],
    cwd: runDirectory,
    stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
    graceMs: 5_000,
  }

  const trace = (event: string, fields: Record<string, unknown> = {}): void => {
    if (diagnosticsEnabled) appendEvent(traceFile, event, fields)
  }
  trace('host-run-started', { nonce, runDirectory, runnerEntry: 'launchWindowsJob' })

  const runnerPath = runnerOverride ?? (builtRunner ? BUILT_RUNNER : undefined)
  const launch = runnerPath === undefined
    ? launchWindowsJob(spec, stringEnvironment())
    : launchWindowsJob(spec, stringEnvironment(), { runnerInvocation: [process.execPath, runnerPath] })
  launch.stdout?.resume()
  launch.stderr?.resume()

  const owner = launch.owner as RangeCapableOwner
  let directOutcome: unknown
  let directError: unknown
  let verify: RangeTerminationResult | undefined
  let terminate: RangeTerminationResult | undefined
  /** Two separately labelled T4 observations: the cached T1 sample and the runner's own re-query. */
  let t4Observations: { cachedT1: Record<string, unknown>; freshT4: Record<string, unknown> } | undefined
  let waitError: unknown
  let failure: string | undefined

  const guard = setTimeout(() => {
    failure = 'overall-timeout'
  }, OVERALL_TIMEOUT_MS)

  try {
    const childObserved = diagnosticsEnabled
      ? await waitForEvent(traceFile, 'child-observed', 30_000)
      : await waitForFile(readyFile, 30_000) ? { event: 'ready-file' } as TraceEvent : undefined
    if (childObserved === undefined) {
      failure = diagnosticsEnabled ? 't1-child-observed-missing' : 'ready-file-missing'
    } else {
      // T1 is observable: release the target parent so the root exit happens.
      writeFileSync(releaseFile, '')
      trace('release-written', {
        nonce,
        childPid: childObserved.childPid ?? null,
        creationTime: childObserved.creationTime ?? null,
      })

      try {
        directOutcome = await launch.direct
      } catch (error) {
        directError = String(error)
      }
      trace('t3-direct-result', {
        nonce,
        outcome: directOutcome ?? null,
        error: directError ?? null,
      })

      verify = await owner.verifyRange(5_000)
      // The host cannot sample a child itself: it labels the T1 record as cached
      // and quotes the runner's own T4 re-query as the fresh observation.
      const freshT4 = readEvents(traceFile)
        .filter(event => event.event === 'range-served' && event.request === 'verify-range')
        .at(-1)
      t4Observations = {
        cachedT1: {
          source: 'cached-T1-observation',
          observedAt: typeof childObserved.timestamp === 'string' ? childObserved.timestamp : null,
          childPid: childObserved.childPid ?? null,
          creationTime: childObserved.creationTime ?? null,
          isProcessInJob: childObserved.isProcessInJob ?? null,
          activeProcesses: childObserved.activeProcesses ?? null,
        },
        freshT4: {
          source: 'fresh-T4-observation',
          observedAt: typeof freshT4?.timestamp === 'string' ? freshT4.timestamp : null,
          state: freshT4?.state ?? null,
          activeProcesses: freshT4?.activeProcesses ?? null,
        },
      }
      trace('t4-verify-range', {
        nonce,
        request: { type: 'verify-range' },
        response: verify,
        cachedT1Observation: t4Observations.cachedT1,
        freshT4Observation: t4Observations.freshT4,
      })

      terminate = await owner.terminateRange(5_000)
      trace('t5-terminate-range', { nonce, response: terminate })

      try {
        await owner.waitForExit()
      } catch (error) {
        waitError = String(error)
      }
      trace('t5-wait-for-exit', { nonce, error: waitError ?? null })
    }
  } finally {
    clearTimeout(guard)
  }

  const events = readEvents(traceFile)
  const t1 = events.find(event => event.event === 'child-observed')
  const t2 = events.find(event => event.event === 'root-exit-observed')
  const t4 = [...events].reverse().find(event => event.event === 'range-served' && event.request === 'verify-range')
  const t5 = [...events].reverse().find(event => event.event === 'range-served' && event.request === 'terminate-range')

  const flowChecks = {
    hostDirectResult: (directOutcome as { exitCode?: number } | undefined)?.exitCode === 0,
    hostVerifyPartial: verify?.state === 'partial',
    hostTerminateTerminal: terminate?.state === 'terminated' || terminate?.state === 'empty',
    hostWaitSettled: waitError === undefined,
    // The control run must leave no trace file behind: disabled means disabled.
    diagnosticsOffMeansNoTrace: diagnosticsEnabled || !existsSync(traceFile),
  }
  const checks = { ...flowChecks, ...(diagnosticsEnabled ? diagnosticEvidence(t1, t2, t4, t5) : {}) }
  const pass = failure === undefined && Object.values(checks).every(Boolean)
  const summary = {
    pass,
    diagnosticsEnabled,
    runnerMode: runnerOverride === undefined ? (builtRunner ? 'built' : 'source') : 'installed',
    runnerPath: runnerOverride ?? (builtRunner ? BUILT_RUNNER : null),
    failure: failure ?? null,
    nonce,
    runDirectory,
    traceFile,
    traceCreated: existsSync(traceFile),
    checks,
    t1: t1 ?? null,
    t2: t2 ?? null,
    t3: { outcome: directOutcome ?? null, error: directError ?? null },
    t4: verify ?? null,
    t4Observations: t4Observations ?? null,
    t5: t5 ?? null,
    hostTerminate: terminate ?? null,
    waitError: waitError ?? null,
    eventCounts: events.reduce<Record<string, number>>((counts, event) => {
      counts[event.event] = (counts[event.event] ?? 0) + 1
      return counts
    }, {}),
  }
  writeFileSync(summaryFile, `${JSON.stringify(summary, null, 2)}\n`)
  console.log(JSON.stringify(summary, null, 2))
  process.exit(pass ? 0 : 1)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
