/**
 * Opt-in NDJSON tracing for the Windows Job runner.
 *
 * Diagnostics exist to leave evidence behind the runner: every record is one
 * synchronously appended JSON line, and a failed write is swallowed, because
 * tracing may never change the runner's lifecycle, its result, or its exit code.
 * Nothing here runs unless `DSH_RUNNER_DIAG` names a sink.
 *
 * @module dsh-subprocess-local/runner-diagnostic
 */

import { appendFileSync } from 'node:fs'
import type { ChildSample, DiagnosticResult } from '@deepseek-ai/dsh-win32-process/src/range-diagnostic.ts'
import type { RangeDiagnosticBindings } from '@deepseek-ai/dsh-win32-process/src/range-diagnostic.ts'

/** NDJSON sink path. Its presence is the only switch that enables diagnostics. */
export const RUNNER_DIAG_ENV = 'DSH_RUNNER_DIAG'
/** File the T1 fixture writes its READY record to. */
export const RUNNER_DIAG_READY_ENV = 'DSH_RUNNER_DIAG_READY'
/** Nonce the READY record must repeat before T1 accepts it. */
export const RUNNER_DIAG_NONCE_ENV = 'DSH_RUNNER_DIAG_NONCE'

/** One Win32 failure as recorded in the trace. */
export interface DiagnosticApiError {
  readonly api: string
  readonly win32Code: number
  readonly detail: string
}

/** Fields one event may carry; every one is optional and defaults to null. */
export interface DiagnosticFields {
  /** Probe phase the event belongs to. */
  readonly phase?: 'T1' | 'T2' | 'T5' | undefined
  /** Target parent pid owned by the runner. */
  readonly targetPid?: number | undefined
  /** Observed descendant pid. */
  readonly childPid?: number | undefined
  /** Nonce echoed by the fixture READY record. */
  readonly nonce?: string | undefined
  /** FILETIME creation stamp of the observed child. */
  readonly creationTime?: string | undefined
  /** Whether the stamp equals the one an earlier observation recorded; null when none was supplied. */
  readonly identityMatch?: boolean | null | undefined
  /** Zero-time wait state of the observed child. */
  readonly childAlive?: string | undefined
  /** IsProcessInJob answer for the runner's exact Job handle. */
  readonly isProcessInJob?: boolean | undefined
  /** Job-wide ActiveProcesses count. */
  readonly activeProcesses?: number | undefined
  /** First Win32 call that failed for this event. */
  readonly apiError?: DiagnosticApiError | undefined
  /** Real call site that produced the event. */
  readonly callSource?: string | undefined
  /** Runner exit code when the event is a finish record. */
  readonly exitCode?: number | null | undefined
  /** Range settlement state when the event answers a range request. */
  readonly state?: string | undefined
  /** Range request type when the event answers a range request. */
  readonly request?: string | undefined
  /** Active count observed before a termination. */
  readonly activeBefore?: number | undefined
  /** Active count observed after a termination. */
  readonly activeAfter?: number | undefined
  /** Free-form context for a failure or skip. */
  readonly detail?: string | undefined
  /** Serialized runner error attached to a failure event. */
  readonly error?: unknown
}

/** One runner-side sink; every method is failure-tolerant. */
export interface RunnerDiagnostic {
  /** Diagnostic-only binding table; never the ordinary launch table. */
  readonly api: RangeDiagnosticBindings
  /** READY file the T1 fixture writes, when the host configured one. */
  readonly readyFile: string | undefined
  /** Nonce the READY record must repeat, when the host configured one. */
  readonly nonce: string | undefined
  /**
   * Append one event to the sink.
   * @param event - event name, for example `child-observed`.
   * @param fields - optional measurements for this event.
   */
  record(event: string, fields?: DiagnosticFields): void
}

/** Reserved keys the record builder fills itself. */
const RESERVED_FIELDS = new Set([
  'targetPid',
  'childPid',
  'nonce',
  'creationTime',
  'childAlive',
  'isProcessInJob',
  'activeProcesses',
  'apiError',
])

/**
 * Open the diagnostic sink when the host asked for one.
 * @param options - runner identity, environment, and the diagnostic-only bindings.
 * @returns the sink, or undefined when `DSH_RUNNER_DIAG` is absent.
 */
export function createRunnerDiagnostic(options: {
  env: NodeJS.ProcessEnv
  jobId: string
  instanceId: string
  api: RangeDiagnosticBindings
  append?: (file: string, line: string) => void
  now?: () => { timestamp: string; monotonicMs: number }
}): RunnerDiagnostic | undefined {
  const file = options.env[RUNNER_DIAG_ENV]
  if (typeof file !== 'string' || file.length === 0) return undefined
  const append = options.append ?? ((target: string, line: string): void => { appendFileSync(target, line) })
  const now = options.now ?? ((): { timestamp: string; monotonicMs: number } => ({
    timestamp: new Date().toISOString(),
    monotonicMs: Number(process.hrtime.bigint() / 1_000_000n),
  }))
  const readyFile = options.env[RUNNER_DIAG_READY_ENV]
  const nonce = options.env[RUNNER_DIAG_NONCE_ENV]
  const record = (event: string, fields: DiagnosticFields = {}): void => {
    const stamp = now()
    const payload: Record<string, unknown> = {
      timestamp: stamp.timestamp,
      monotonicMs: stamp.monotonicMs,
      event,
      origin: 'runner',
      jobId: options.jobId,
      instanceId: options.instanceId,
      runnerPid: process.pid,
      parentPid: process.ppid,
      targetPid: fields.targetPid ?? null,
      childPid: fields.childPid ?? null,
      nonce: fields.nonce ?? null,
      creationTime: fields.creationTime ?? null,
      childAlive: fields.childAlive ?? null,
      isProcessInJob: fields.isProcessInJob ?? null,
      activeProcesses: fields.activeProcesses ?? null,
      apiError: fields.apiError ?? null,
    }
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined && !RESERVED_FIELDS.has(key)) payload[key] = value
    }
    try {
      append(file, `${JSON.stringify(payload)}\n`)
    } catch {
      // A trace that cannot be written must never change the runner's outcome.
    }
  }
  return { api: options.api, readyFile, nonce, record }
}

/**
 * Record a diagnostic open failure on the sink the host named.
 *
 * The binding table is exactly what failed here, so this writes through the
 * plain filesystem and never touches Win32. It stays silent when even that fails.
 * @param env - runner environment naming the sink.
 * @param error - the failure that prevented the sink from opening.
 */
export function recordDiagnosticOpenFailure(env: NodeJS.ProcessEnv, error: unknown): void {
  const file = env[RUNNER_DIAG_ENV]
  if (typeof file !== 'string' || file.length === 0) return
  try {
    appendFileSync(file, `${JSON.stringify({
      timestamp: new Date().toISOString(),
      monotonicMs: Number(process.hrtime.bigint() / 1_000_000n),
      event: 'diag-open-failed',
      origin: 'runner',
      jobId: null,
      instanceId: null,
      runnerPid: process.pid,
      parentPid: process.ppid,
      targetPid: null,
      childPid: null,
      nonce: null,
      creationTime: null,
      childAlive: null,
      isProcessInJob: null,
      activeProcesses: null,
      apiError: null,
      detail: String(error),
    })}\n`)
  } catch {
    // Tracing is optional: failing to trace the failure changes nothing.
  }
}

/**
 * Flatten one child sample into trace fields.
 * @param sample - result of `sampleChild` against the runner's exact Job handle.
 * @returns fields for `child-observed`, with the first failure as `apiError`.
 */
export function childSampleFields(sample: ChildSample): DiagnosticFields {
  const observation = sample.observation
  const state = observation.ok ? observation.value : undefined
  return {
    childPid: sample.pid,
    creationTime: settled(state?.identity, identity => identity.creationTime),
    identityMatch: state?.identity === undefined
      ? undefined
      : state.identity.ok ? state.identity.value.expectedMatch : undefined,
    childAlive: settled(state?.liveness, liveness => liveness),
    isProcessInJob: settled(state?.jobMembership, membership => membership),
    activeProcesses: settled(sample.activeProcesses, count => count),
    apiError: firstFailure([
      observation,
      state?.liveness,
      state?.identity,
      state?.jobMembership,
      sample.release,
      sample.activeProcesses,
    ]),
    detail: sample.validity === 'invalid' ? 'sample-invalid:child-handle-not-released' : undefined,
  }
}

function settled<Value, Output>(
  result: DiagnosticResult<Value> | undefined,
  read: (value: Value) => Output,
): Output | undefined {
  return result !== undefined && result.ok ? read(result.value) : undefined
}

function firstFailure(
  results: ReadonlyArray<DiagnosticResult<unknown> | undefined>,
): DiagnosticApiError | undefined {
  for (const result of results) {
    if (result !== undefined && !result.ok) {
      return { api: result.api, win32Code: result.win32Code, detail: result.detail }
    }
  }
  return undefined
}
