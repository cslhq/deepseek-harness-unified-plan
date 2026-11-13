/**
 * Evidence-only Child and Job range diagnostics over the shared Win32 binding
 * table. Every observation answers with the exact Win32 failure instead of a
 * boolean, so "the call failed" can never be read as "the process is gone",
 * and "unverified" can never be read as "the Runner exited".
 *
 * The Job is always the caller's exact handle: no name lookup and no second
 * Job object are created here, so an observation can never describe a range
 * other than the one the runner owns.
 *
 * @module @deepseek-ai/dsh-win32-process/range-diagnostic
 */

import * as abi from './abi.ts'
import {
  allocFileTime,
  allocUint32,
  decodeFileTime,
  decodeUint32,
  errorText,
  isNullPtr,
} from './ffi.ts'
import { requireKoffi } from './koffi.ts'
import type {
  NativePtr,
  RangeDiagnosticBindingTable,
  Win32ProcessBindings,
} from './ffi.ts'

/**
 * Win32 calls these diagnostics make: the ordinary table's handle, error, wait,
 * and Job-accounting calls plus the diagnostic-only process-identity table that
 * {@link RangeDiagnosticBindingTable} loads on demand.
 */
export type RangeDiagnosticBindings = Pick<
  Win32ProcessBindings,
  | 'closeHandle'
  | 'formatMessageW'
  | 'getLastError'
  | 'queryInformationJobObject'
  | 'waitForSingleObject'
> & RangeDiagnosticBindingTable

/** One failed Win32 call, reported in place of a false observation. */
export interface DiagnosticFailure {
  /** Discriminator: the observation carries no value. */
  readonly ok: false
  /** Exact Win32 function whose checked result failed. */
  readonly api: string
  /** Exact GetLastError value captured at the failure. */
  readonly win32Code: number
  /** Operation context, plus the system message when one is available. */
  readonly detail: string
}

/** One successful observation. */
export interface DiagnosticValue<Value> {
  /** Discriminator: the observation carries a measured value. */
  readonly ok: true
  /** Measured value. */
  readonly value: Value
}

/** A Win32 observation: the measured value, or the exact call that failed. */
export type DiagnosticResult<Value> = DiagnosticValue<Value> | DiagnosticFailure

/** Zero-time wait state of one process handle. */
export type ChildLiveness = 'running' | 'exited'

/** Creation identity of the process behind one sampled pid. */
export interface ChildIdentity {
  /** GetProcessTimes creation stamp rendered as `high:low`, the fence against pid reuse. */
  readonly creationTime: string
  /** Whether the stamp equals {@link ChildSampleRequest.expectedCreationTime}; null when none was supplied. */
  readonly expectedMatch: boolean | null
}

/** Per-child observations, each carrying its own failure. */
export interface ChildObservation {
  /** WaitForSingleObject(0) result: `running` until the process handle is signalled. */
  readonly liveness: DiagnosticResult<ChildLiveness>
  /** GetProcessTimes identity of the process that currently owns the sampled pid. */
  readonly identity: DiagnosticResult<ChildIdentity>
  /** IsProcessInJob answer against the exact caller-supplied Job handle. */
  readonly jobMembership: DiagnosticResult<boolean>
}

/** What one child sample asks for. */
export interface ChildSampleRequest {
  /** Process id reported by the spawn handshake. */
  readonly pid: number
  /** Creation stamp observed earlier; a different stamp proves pid reuse. */
  readonly expectedCreationTime?: string
}

/** CloseHandle outcome for one sampled child handle. */
export type ChildRelease = 'released' | 'not-opened'

/**
 * Whether a child sample may be cited as evidence.
 * `invalid` is set only by a failed CloseHandle: the observations above are then
 * retained raw for diagnosis, and no Job-wide count is offered at all.
 */
export type ChildSampleValidity = 'valid' | 'invalid'

/** One child sample plus the Job-wide count taken after its handle was closed. */
export interface ChildSample {
  /** Sampled process id, echoed so the caller keeps its own pairing. */
  readonly pid: number
  /** `invalid` when the child handle could not be released; nothing else may be cited then. */
  readonly validity: ChildSampleValidity
  /** OpenProcess plus the three per-child observations, retained even when invalid. */
  readonly observation: DiagnosticResult<ChildObservation>
  /** CloseHandle outcome; a failure here invalidates the whole sample. */
  readonly release: DiagnosticResult<ChildRelease>
  /**
   * Job-wide ActiveProcesses, observed only after a released child handle.
   * A failed release withholds the count and reports the CloseHandle failure
   * here instead, so a stale handle can never become Job evidence.
   */
  readonly activeProcesses: DiagnosticResult<number>
  /** Ordered evidence lines; later failures never erase what earlier calls established. */
  readonly evidence: readonly string[]
}

/**
 * Capture the exact Job's ActiveProcesses count.
 * @param api - binding table.
 * @param job - caller-owned exact Job handle; no name lookup is performed.
 * @returns the active count, or the exact QueryInformationJobObject failure.
 */
export function activeProcesses(api: RangeDiagnosticBindings, job: NativePtr): DiagnosticResult<number> {
  const information = Buffer.alloc(abi.JOBOBJECT_BASIC_ACCOUNTING_SIZE)
  if (api.queryInformationJobObject(
    job,
    abi.JobObjectBasicAccountingInformation,
    information,
    information.length,
    null,
  ) === 0) {
    const win32Code = api.getLastError()
    return failure(api, 'QueryInformationJobObject', win32Code, 'JobObjectBasicAccountingInformation')
  }
  return {
    ok: true,
    value: information.readUInt32LE(abi.JOBOBJECT_BASIC_ACCOUNTING_ACTIVE_PROCESSES_OFFSET),
  }
}

/**
 * Sample one child process and the exact Job meant to hold it.
 *
 * The child handle is closed before the Job-wide count is read, so a still-open
 * handle cannot keep the range visible; any failed Win32 call is reported as a
 * failure rather than collapsed into `false` or `gone`.
 *
 * A failed CloseHandle invalidates the sample: the observations gathered before
 * it are returned raw, but no Job-wide count is offered, because taken through a
 * leaked handle it could not be attributed to this child.
 *
 * @param api - binding table.
 * @param job - caller-owned exact Job handle.
 * @param request - process id plus the creation stamp observed when it started.
 * @returns per-observation results and the ordered evidence trail.
 */
export function sampleChild(
  api: RangeDiagnosticBindings,
  job: NativePtr,
  request: ChildSampleRequest,
): ChildSample {
  const evidence: string[] = []
  const probe = openAndObserve(api, job, request, evidence)
  if (!probe.release.ok) {
    evidence.push('ActiveProcesses:withheld:child-handle-not-released')
    return {
      pid: request.pid,
      validity: 'invalid',
      observation: probe.observation,
      release: probe.release,
      activeProcesses: {
        ...probe.release,
        detail: `${probe.release.detail}; job-wide ActiveProcesses withheld because the child handle was not released`,
      },
      evidence,
    }
  }
  const rangeObservation = activeProcesses(api, job)
  evidence.push(rangeObservation.ok
    ? `ActiveProcesses:${String(rangeObservation.value)}`
    : `ActiveProcesses:failed:${rangeObservation.api}:${String(rangeObservation.win32Code)}`)
  return {
    pid: request.pid,
    validity: 'valid',
    observation: probe.observation,
    release: probe.release,
    activeProcesses: rangeObservation,
    evidence,
  }
}

/** One sampled child: what was observed, and whether its handle was released. */
interface ChildProbe {
  observation: DiagnosticResult<ChildObservation>
  release: DiagnosticResult<ChildRelease>
}

function openAndObserve(
  api: RangeDiagnosticBindings,
  job: NativePtr,
  request: ChildSampleRequest,
  evidence: string[],
): ChildProbe {
  const handle = api.openProcess(
    abi.PROCESS_QUERY_LIMITED_INFORMATION | abi.SYNCHRONIZE,
    0,
    request.pid,
  )
  if (isNullPtr(handle)) {
    const win32Code = api.getLastError()
    evidence.push(`OpenProcess:pid=${String(request.pid)}:win32=${String(win32Code)}`)
    return {
      observation: failure(api, 'OpenProcess', win32Code, `pid ${String(request.pid)}`),
      release: { ok: true, value: 'not-opened' },
    }
  }
  evidence.push(`OpenProcess:pid=${String(request.pid)}:opened`)
  let observation: DiagnosticResult<ChildObservation>
  try {
    observation = {
      ok: true,
      value: {
        liveness: childLiveness(api, handle, evidence),
        identity: childIdentity(api, handle, request, evidence),
        jobMembership: childJobMembership(api, handle, job, request.pid, evidence),
      },
    }
  } catch (error) {
    // A throwing binding is an infrastructure failure, not an observation:
    // release the handle before the error escapes so nothing leaks.
    closeChild(api, handle, request.pid, evidence)
    throw error
  }
  return { observation, release: closeChild(api, handle, request.pid, evidence) }
}

function closeChild(
  api: RangeDiagnosticBindings,
  handle: NativePtr,
  pid: number,
  evidence: string[],
): DiagnosticResult<ChildRelease> {
  if (api.closeHandle(handle) !== 0) {
    evidence.push('CloseHandle:child:released')
    return { ok: true, value: 'released' }
  }
  const win32Code = api.getLastError()
  evidence.push(`CloseHandle:child:failed:win32=${String(win32Code)}`)
  return failure(api, 'CloseHandle', win32Code, `pid ${String(pid)}`)
}

function childLiveness(
  api: RangeDiagnosticBindings,
  handle: NativePtr,
  evidence: string[],
): DiagnosticResult<ChildLiveness> {
  const wait = api.waitForSingleObject(handle, 0)
  if (wait === abi.WAIT_OBJECT_0) {
    evidence.push('WaitForSingleObject:exited')
    return { ok: true, value: 'exited' }
  }
  if (wait === abi.WAIT_TIMEOUT) {
    evidence.push('WaitForSingleObject:running')
    return { ok: true, value: 'running' }
  }
  const win32Code = api.getLastError()
  evidence.push(`WaitForSingleObject:failed:${String(wait)}`)
  return failure(
    api,
    'WaitForSingleObject',
    win32Code,
    wait === abi.WAIT_FAILED ? 'WAIT_FAILED' : `wait result ${String(wait)}`,
  )
}

function childIdentity(
  api: RangeDiagnosticBindings,
  handle: NativePtr,
  request: ChildSampleRequest,
  evidence: string[],
): DiagnosticResult<ChildIdentity> {
  let creation: NativePtr | undefined
  let exitTime: NativePtr | undefined
  let kernel: NativePtr | undefined
  let user: NativePtr | undefined
  try {
    creation = allocFileTime()
    exitTime = allocFileTime()
    kernel = allocFileTime()
    user = allocFileTime()
    if (api.getProcessTimes(handle, creation, exitTime, kernel, user) === 0) {
      const win32Code = api.getLastError()
      evidence.push(`GetProcessTimes:failed:${String(win32Code)}`)
      return failure(api, 'GetProcessTimes', win32Code, `pid ${String(request.pid)}`)
    }
    const stamp = decodeFileTime(creation)
    const creationTime = `${String(stamp.dwHighDateTime)}:${String(stamp.dwLowDateTime)}`
    const expectedMatch = request.expectedCreationTime === undefined
      ? null
      : request.expectedCreationTime === creationTime
    evidence.push(`GetProcessTimes:${creationTime}:expectedMatch=${String(expectedMatch)}`)
    return { ok: true, value: { creationTime, expectedMatch } }
  } finally {
    freeNative(user)
    freeNative(kernel)
    freeNative(exitTime)
    freeNative(creation)
  }
}

function childJobMembership(
  api: RangeDiagnosticBindings,
  handle: NativePtr,
  job: NativePtr,
  pid: number,
  evidence: string[],
): DiagnosticResult<boolean> {
  let result: NativePtr | undefined
  try {
    result = allocUint32()
    if (api.isProcessInJob(handle, job, result) === 0) {
      const win32Code = api.getLastError()
      evidence.push(`IsProcessInJob:failed:${String(win32Code)}`)
      return failure(api, 'IsProcessInJob', win32Code, `pid ${String(pid)}`)
    }
    const member = decodeUint32(result) !== 0
    evidence.push(`IsProcessInJob:${String(member)}`)
    return { ok: true, value: member }
  } finally {
    freeNative(result)
  }
}

function freeNative(pointer: NativePtr | undefined): void {
  if (pointer !== undefined) requireKoffi().free(pointer)
}

function failure(
  api: RangeDiagnosticBindings,
  name: string,
  win32Code: number,
  context: string,
): DiagnosticFailure {
  const message = errorText(api, win32Code)
  return {
    ok: false,
    api: name,
    win32Code,
    detail: message.length === 0 ? context : `${context}: ${message}`,
  }
}
