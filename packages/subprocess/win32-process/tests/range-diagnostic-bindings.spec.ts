/**
 * Binding isolation: the process-identity calls belong to the diagnostic loader
 * alone, so an ordinary launch binds the shared table unchanged. Koffi is
 * replaced by a recording stub — the suite stays native-free, so it runs on
 * every platform while still proving which symbols each loader binds.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

/** Win32 functions the runner-side bindings must never request. */
const DIAGNOSTIC_NAMES = ['OpenProcess', 'IsProcessInJob', 'GetProcessTimes']

/**
 * Struct sizes the ABI guards require, keyed by field count: the layouts are
 * anonymous, so a name cannot identify them and the shape must.
 */
const SIZE_BY_FIELD_COUNT: Record<number, number> = {
  18: 104, // STARTUPINFOW
  4: 24, // PROCESS_INFORMATION
  2: 8, // FILETIME
}

interface Recorder {
  /** Win32 function names bound so far, in binding order. */
  names: string[]
}

/**
 * Import a fresh copy of the binding module over a recording Koffi stub.
 * @returns the reloaded module and the symbols it bound, in order.
 */
async function freshBindings(): Promise<{ ffi: typeof import('../src/ffi.ts'); recorder: Recorder }> {
  vi.resetModules()
  const recorder: Recorder = { names: [] }
  const library = {
    func: (...args: unknown[]): (() => number) => {
      recorder.names.push(args[0] === '__stdcall' ? String(args[1]) : String(args[0]))
      return () => 0
    },
  }
  const koffi = {
    load: () => library,
    pointer: () => ({ pointer: true }),
    struct: (first: unknown, second?: unknown) => {
      const definition = (typeof first === 'string' ? second : first) as Record<string, unknown>
      return { size: SIZE_BY_FIELD_COUNT[Object.keys(definition).length] }
    },
  }
  vi.doMock('../src/koffi.ts', () => ({ requireKoffi: () => koffi }))
  const module = await import('../src/ffi.ts')
  return { ffi: module, recorder }
}

afterEach(() => {
  vi.resetModules()
  vi.doUnmock('../src/koffi.ts')
})

describe('range-diagnostic binding isolation', () => {
  it('binds no diagnostic call in the ordinary process table', async () => {
    const { ffi, recorder } = await freshBindings()
    const table = ffi.loadWin32ProcessBindings()

    expect(table).not.toHaveProperty('openProcess')
    expect(table).not.toHaveProperty('isProcessInJob')
    expect(table).not.toHaveProperty('getProcessTimes')
    // The symbols are never requested from kernel32 either.
    for (const name of DIAGNOSTIC_NAMES) expect(recorder.names).not.toContain(name)
    // The ordinary surface is still complete.
    expect(recorder.names).toEqual(expect.arrayContaining([
      'CloseHandle',
      'QueryInformationJobObject',
      'CreateJobObjectW',
      'AssignProcessToJobObject',
      'WaitForSingleObject',
    ]))
  })

  it('binds the three diagnostic calls only through loadRangeDiagnosticBindings', async () => {
    const { ffi, recorder } = await freshBindings()
    const table = ffi.loadRangeDiagnosticBindings()

    expect(typeof table.openProcess).toBe('function')
    expect(typeof table.isProcessInJob).toBe('function')
    expect(typeof table.getProcessTimes).toBe('function')
    // Reuses the shared table instead of rebuilding it.
    expect(typeof table.closeHandle).toBe('function')
    expect(typeof table.queryInformationJobObject).toBe('function')
    // Exactly the three extras, bound after the ordinary table.
    expect(recorder.names.slice(-3)).toEqual(DIAGNOSTIC_NAMES)
    for (const name of DIAGNOSTIC_NAMES) {
      expect(recorder.names.filter(bound => bound === name)).toHaveLength(1)
    }
  })

  it('repeats the ordinary load without ever reaching the diagnostic symbols', async () => {
    const { ffi, recorder } = await freshBindings()
    ffi.loadWin32ProcessBindings()
    const afterFirstLoad = [...recorder.names]
    const second = ffi.loadWin32ProcessBindings()

    expect(recorder.names).toEqual(afterFirstLoad)
    expect(second).not.toHaveProperty('openProcess')
    for (const name of DIAGNOSTIC_NAMES) expect(recorder.names).not.toContain(name)
  })
})
