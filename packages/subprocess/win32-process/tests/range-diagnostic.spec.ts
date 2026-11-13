/**
 * Range-diagnostic contract: every Win32 call answers with its own result or
 * its own failure, the Job is always the exact caller handle, the child handle
 * is released before the Job-wide count, and no native pointer survives into
 * the returned evidence. Pure stub binding tables — no real Win32 calls.
 */

import koffi from 'koffi'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as abi from '../src/abi.ts'
import { fileTimeType } from '../src/ffi.ts'
import * as koffiLoader from '../src/koffi.ts'
import { activeProcesses, sampleChild } from '../src/range-diagnostic.ts'
import type {
  DiagnosticFailure,
  DiagnosticResult,
  RangeDiagnosticBindings,
} from '../src/range-diagnostic.ts'
import type { NativePtr } from '../src/ffi.ts'

// Koffi loads twice in this suite: the test imports the ESM entry, while the
// package binding table requires the CommonJS entry. Point the package loader
// at the imported instance so an allocation made by range-diagnostic.ts and a
// free observed by a test spy are the same native allocator.
vi.mock('../src/koffi.ts', { spy: true })

beforeEach(() => {
  vi.mocked(koffiLoader.requireKoffi).mockReturnValue(koffi)
})

/** The exact Job handle every case passes through unchanged. */
const JOB = 50n as NativePtr
/** The child process id reported by the spawn handshake. */
const CHILD_PID = 4242
/** The process handle OpenProcess returns for a readable child. */
const CHILD_HANDLE = 200n as NativePtr
/** A creation stamp the stubbed GetProcessTimes writes. */
const CREATION = { dwLowDateTime: 1_234_567, dwHighDateTime: 30_000_001 }
const CREATION_STAMP = '30000001:1234567'

interface Stub {
  api: RangeDiagnosticBindings
  events: string[]
  closed: NativePtr[]
}

function stub(overrides: Partial<RangeDiagnosticBindings> = {}): Stub {
  const events: string[] = []
  const closed: NativePtr[] = []
  const api: RangeDiagnosticBindings = {
    openProcess: vi.fn(() => {
      events.push('open')
      return CHILD_HANDLE
    }),
    waitForSingleObject: vi.fn(() => {
      events.push('wait')
      return abi.WAIT_TIMEOUT
    }),
    getProcessTimes: vi.fn((_process: NativePtr, creation: NativePtr) => {
      events.push('get-process-times')
      koffi.encode(creation, fileTimeType(), CREATION)
      return 1
    }),
    isProcessInJob: vi.fn((_process: NativePtr, _job: NativePtr, result: NativePtr) => {
      events.push('is-process-in-job')
      koffi.encode(result, 'uint32', 1)
      return 1
    }),
    queryInformationJobObject: vi.fn((_job: NativePtr, _class: number, information: Buffer) => {
      events.push('active-processes')
      information.writeUInt32LE(1, abi.JOBOBJECT_BASIC_ACCOUNTING_ACTIVE_PROCESSES_OFFSET)
      return 1
    }),
    closeHandle: vi.fn((handle: NativePtr) => {
      events.push('close-child')
      closed.push(handle)
      return 1
    }),
    getLastError: vi.fn(() => 5),
    formatMessageW: vi.fn(() => 0),
    ...overrides,
  }
  return { api, events, closed }
}

function expectValue<Value>(result: DiagnosticResult<Value>): Value {
  if (!result.ok) throw new Error(`expected a value, received ${result.api} Win32 ${String(result.win32Code)}`)
  return result.value
}

function expectFailure<Value>(result: DiagnosticResult<Value>): DiagnosticFailure {
  if (result.ok) throw new Error('expected a structured failure, received a value')
  return result
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('sampleChild identity and membership', () => {
  it('opens the child with query and wait rights and reports every observation', () => {
    const openProcess = vi.fn(() => CHILD_HANDLE)
    const stubApi = stub({ openProcess })
    const sample = sampleChild(stubApi.api, JOB, { pid: CHILD_PID })

    expect(openProcess).toHaveBeenCalledWith(
      abi.PROCESS_QUERY_LIMITED_INFORMATION | abi.SYNCHRONIZE,
      0,
      CHILD_PID,
    )
    const observation = expectValue(sample.observation)
    expect(expectValue(observation.liveness)).toBe('running')
    expect(expectValue(observation.identity)).toEqual({
      creationTime: CREATION_STAMP,
      expectedMatch: null,
    })
    expect(expectValue(observation.jobMembership)).toBe(true)
    expect(expectValue(sample.activeProcesses)).toBe(1)
    expect(sample.validity).toBe('valid')
    expect(expectValue(sample.release)).toBe('released')
    expect(sample.pid).toBe(CHILD_PID)
  })

  it('checks IsProcessInJob against the exact caller job handle', () => {
    const isProcessInJob = vi.fn((_process: NativePtr, _job: NativePtr, result: NativePtr) => {
      koffi.encode(result, 'uint32', 1)
      return 1
    })
    const stubApi = stub({ isProcessInJob })
    sampleChild(stubApi.api, JOB, { pid: CHILD_PID })
    expect(isProcessInJob).toHaveBeenCalledWith(
      CHILD_HANDLE,
      JOB,
      expect.anything(),
    )
  })

  it('reports a child that does not belong to the exact job', () => {
    const stubApi = stub({
      isProcessInJob: vi.fn((_process: NativePtr, _job: NativePtr, result: NativePtr) => {
        koffi.encode(result, 'uint32', 0)
        return 1
      }),
    })
    const sample = sampleChild(stubApi.api, JOB, { pid: CHILD_PID })
    expect(expectValue(expectValue(sample.observation).jobMembership)).toBe(false)
  })

  it('proves pid reuse when the creation stamp differs from the expected one', () => {
    const stubApi = stub()
    const sample = sampleChild(stubApi.api, JOB, { pid: CHILD_PID, expectedCreationTime: '7:7' })
    expect(expectValue(expectValue(sample.observation).identity)).toEqual({
      creationTime: CREATION_STAMP,
      expectedMatch: false,
    })
  })

  it('matches the creation stamp observed when the child started', () => {
    const stubApi = stub()
    const sample = sampleChild(stubApi.api, JOB, {
      pid: CHILD_PID,
      expectedCreationTime: CREATION_STAMP,
    })
    expect(expectValue(expectValue(sample.observation).identity).expectedMatch).toBe(true)
  })

  it('reports an exited child from the zero-time wait without dropping membership', () => {
    const stubApi = stub({ waitForSingleObject: vi.fn(() => abi.WAIT_OBJECT_0) })
    const sample = sampleChild(stubApi.api, JOB, { pid: CHILD_PID })
    expect(expectValue(expectValue(sample.observation).liveness)).toBe('exited')
    expect(expectValue(expectValue(sample.observation).jobMembership)).toBe(true)
    expect(stubApi.events).toContain('is-process-in-job')
  })
})

describe('sampleChild failures stay structured', () => {
  it('reports an OpenProcess failure instead of an unobserved child', () => {
    const openProcess = vi.fn(() => 0n as NativePtr)
    const stubApi = stub({ openProcess })
    const sample = sampleChild(stubApi.api, JOB, { pid: CHILD_PID })

    const failure = expectFailure(sample.observation)
    expect(failure.api).toBe('OpenProcess')
    expect(failure.win32Code).toBe(5)
    expect(failure.detail).toContain(`pid ${String(CHILD_PID)}`)
    // The job-wide observation is independent evidence and must survive.
    expect(expectValue(sample.activeProcesses)).toBe(1)
    expect(stubApi.closed).toEqual([])
    expect(stubApi.events).toEqual(['active-processes'])
  })

  it('reports a GetProcessTimes failure without erasing liveness', () => {
    const stubApi = stub({ getProcessTimes: vi.fn(() => 0) })
    const sample = sampleChild(stubApi.api, JOB, { pid: CHILD_PID })

    const observation = expectValue(sample.observation)
    expect(expectValue(observation.liveness)).toBe('running')
    const failure = expectFailure(observation.identity)
    expect(failure.api).toBe('GetProcessTimes')
    expect(failure.win32Code).toBe(5)
    expect(stubApi.closed).toEqual([CHILD_HANDLE])
  })

  it('reports an IsProcessInJob failure instead of a false membership', () => {
    const stubApi = stub({ isProcessInJob: vi.fn(() => 0) })
    const sample = sampleChild(stubApi.api, JOB, { pid: CHILD_PID })

    const observer = expectValue(sample.observation)
    const failure = expectFailure(observer.jobMembership)
    expect(failure.api).toBe('IsProcessInJob')
    expect(failure.win32Code).toBe(5)
    // Identity evidence survives an unrelated membership failure.
    expect(expectValue(observer.identity).creationTime).toBe(CREATION_STAMP)
  })

  it('reports a WaitForSingleObject failure instead of exiting the child', () => {
    const stubApi = stub({ waitForSingleObject: vi.fn(() => abi.WAIT_FAILED) })
    const sample = sampleChild(stubApi.api, JOB, { pid: CHILD_PID })

    const failure = expectFailure(expectValue(sample.observation).liveness)
    expect(failure.api).toBe('WaitForSingleObject')
    expect(failure.detail).toBe('WAIT_FAILED')
  })

  it('reports an ActiveProcesses query failure rather than zero', () => {
    const stubApi = stub({ queryInformationJobObject: vi.fn(() => 0) })
    const sample = sampleChild(stubApi.api, JOB, { pid: CHILD_PID })

    const failure = expectFailure(sample.activeProcesses)
    expect(failure.api).toBe('QueryInformationJobObject')
    expect(failure.win32Code).toBe(5)
    expect(sample.evidence.at(-1)).toBe('ActiveProcesses:failed:QueryInformationJobObject:5')
  })
})

describe('CloseHandle failure invalidates the sample', () => {
  it('reports the release failure and withholds the job-wide count', () => {
    const closeHandle = vi.fn(() => 0)
    const stubApi = stub({ closeHandle, getLastError: vi.fn(() => 6) })
    const sample = sampleChild(stubApi.api, JOB, { pid: CHILD_PID })

    expect(sample.validity).toBe('invalid')
    const release = expectFailure(sample.release)
    expect(release.api).toBe('CloseHandle')
    expect(release.win32Code).toBe(6)

    const withheld = expectFailure(sample.activeProcesses)
    expect(withheld.api).toBe('CloseHandle')
    expect(withheld.win32Code).toBe(6)
    expect(withheld.detail).toContain('withheld')
    // A leaked child handle may not be turned into Job evidence.
    expect(stubApi.events).not.toContain('active-processes')
    expect(sample.evidence).toContain('ActiveProcesses:withheld:child-handle-not-released')
    // What was observed before the failure survives as raw diagnostics.
    expect(expectValue(expectValue(sample.observation).identity).creationTime).toBe(CREATION_STAMP)
  })

  it('captures the close error at the call instead of a later one', () => {
    const stubApi = stub({
      closeHandle: vi.fn(() => 0),
      getLastError: vi.fn().mockReturnValueOnce(6).mockReturnValue(999),
    })
    const sample = sampleChild(stubApi.api, JOB, { pid: CHILD_PID })
    expect(expectFailure(sample.release).win32Code).toBe(6)
  })

  it('still releases the child handle when an observation binding throws', () => {
    const closeHandle = vi.fn(() => 1)
    const stubApi = stub({
      closeHandle,
      getProcessTimes: vi.fn(() => { throw new Error('binding exploded') }),
    })
    expect(() => sampleChild(stubApi.api, JOB, { pid: CHILD_PID })).toThrow('binding exploded')
    expect(closeHandle).toHaveBeenCalledExactlyOnceWith(CHILD_HANDLE)
  })
})

describe('range-diagnostic resource discipline', () => {
  it('closes the child handle before reading the job-wide count', () => {
    const stubApi = stub()
    sampleChild(stubApi.api, JOB, { pid: CHILD_PID })

    expect(stubApi.closed).toEqual([CHILD_HANDLE])
    const closeAt = stubApi.events.indexOf('close-child')
    const countAt = stubApi.events.indexOf('active-processes')
    expect(closeAt).toBeGreaterThanOrEqual(0)
    expect(countAt).toBeGreaterThan(closeAt)
  })

  it('closes the child handle when a later observation fails', () => {
    const stubApi = stub({ getProcessTimes: vi.fn(() => 0) })
    sampleChild(stubApi.api, JOB, { pid: CHILD_PID })
    expect(stubApi.api.closeHandle).toHaveBeenCalledExactlyOnceWith(CHILD_HANDLE)
  })

  it('frees every FILETIME slot and the membership slot', () => {
    const free = vi.spyOn(koffi, 'free')
    const stubApi = stub()
    sampleChild(stubApi.api, JOB, { pid: CHILD_PID })
    // Four FILETIME out-parameters plus one uint32 membership slot.
    expect(free).toHaveBeenCalledTimes(5)
  })

  it('allocates nothing when the child handle never opened', () => {
    const free = vi.spyOn(koffi, 'free')
    const stubApi = stub({ openProcess: vi.fn(() => 0n as NativePtr) })
    sampleChild(stubApi.api, JOB, { pid: CHILD_PID })
    expect(free).not.toHaveBeenCalled()
  })

  it('returns evidence that serializes without a native pointer', () => {
    const stubApi = stub()
    const sample = sampleChild(stubApi.api, JOB, { pid: CHILD_PID })
    expect(() => JSON.stringify(sample)).not.toThrow()
    expect(sample.evidence).toContain(`OpenProcess:pid=${String(CHILD_PID)}:opened`)
    expect(sample.evidence).toContain(`GetProcessTimes:${CREATION_STAMP}:expectedMatch=null`)
    expect(sample.evidence).toContain('CloseHandle:child:released')
  })
})

describe('activeProcesses', () => {
  it('reads ActiveProcesses from the exact job accounting buffer', () => {
    const stubApi = stub({
      queryInformationJobObject: vi.fn((_job: NativePtr, _class: number, information: Buffer) => {
        information.writeUInt32LE(3, abi.JOBOBJECT_BASIC_ACCOUNTING_ACTIVE_PROCESSES_OFFSET)
        return 1
      }),
    })
    expect(expectValue(activeProcesses(stubApi.api, JOB))).toBe(3)
    expect(stubApi.api.queryInformationJobObject).toHaveBeenCalledWith(
      JOB,
      abi.JobObjectBasicAccountingInformation,
      expect.any(Buffer),
      abi.JOBOBJECT_BASIC_ACCOUNTING_SIZE,
      null,
    )
  })

  it('reports the exact failure when the count is unqueryable', () => {
    const stubApi = stub({ queryInformationJobObject: vi.fn(() => 0) })
    const failure = expectFailure(activeProcesses(stubApi.api, JOB))
    expect(failure).toMatchObject({ api: 'QueryInformationJobObject', win32Code: 5 })
  })
})
