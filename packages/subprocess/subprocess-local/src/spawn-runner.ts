/** One-shot Linux exec bootstrap and Windows Job-owning subprocess runner. */

import { SUBPROCESS_CONTROL_FD } from '@deepseek-ai/dsh-subprocess/control'
import { randomUUID } from 'node:crypto'
import { handleRangeRequest, isWindowsRangeLikeRequest, parseRangeRequest } from './range-handler.ts'
import type { RangeRequest } from './range-handler.ts'
import { closeSync, existsSync, readFileSync } from 'node:fs'
import {
  closeHandleChecked,
  isJobEmpty,
  loadWin32ProcessBindings,
  pollProcessExit,
  spawnCurrentTokenJobProcess,
  terminateJob,
  Win32Error,
} from '@deepseek-ai/dsh-win32-process'
import type {
  CurrentTokenProcessBindings,
  NativePtr,
} from '@deepseek-ai/dsh-win32-process'
// Diagnostics stay off the package root: only this runner imports them, and it
// reaches them through the package's existing `./src/*` export subpath.
import { loadRangeDiagnosticBindings } from '@deepseek-ai/dsh-win32-process/src/ffi.ts'
import { activeProcesses, sampleChild } from '@deepseek-ai/dsh-win32-process/src/range-diagnostic.ts'
import type { RangeDiagnosticBindings } from '@deepseek-ai/dsh-win32-process/src/range-diagnostic.ts'
import {
  childSampleFields,
  createRunnerDiagnostic,
  recordDiagnosticOpenFailure,
  RUNNER_DIAG_ENV,
} from './runner-diagnostic.ts'
import type { RunnerDiagnostic } from './runner-diagnostic.ts'
import { loadLinuxExecve } from './linux-execve.ts'
import {
  consumeLinuxLaunchRequest,
  isWindowsTerminateRequest,
  linuxLaunchFilesFromLocator,
  parseWindowsStartRequest,
  serializeRunnerError,
  writeLinuxStartupError,
} from './runner-protocol.ts'
import type {
  LinuxLaunchFiles,
  SerializedRunnerError,
  WindowsRunnerResult,
  WindowsStartRequest,
} from './runner-protocol.ts'
import {
  parseRunnerTargetArgv,
  resolveWindowsExecutable,
  SUBPROCESS_RUNNER_ENV,
  WINDOWS_RUNNER_SELECTION,
} from './runner-launch.ts'

type RunnerHost = Pick<NodeJS.Process, 'env' | 'exitCode' | 'connected' | 'cwd' | 'chdir' | 'on' | 'off' | 'once' | 'disconnect'> & {
  send?: NodeJS.Process['send']
}

/** Injectable operations used by the protocol-owner tests. */
export interface SpawnRunnerInternals {
  execve(file: string, argv: string[], env: Record<string, string>, control?: 'pipe'): never
  loadWin32ProcessBindings(): CurrentTokenProcessBindings
  /** Diagnostic-only table; bound only when a trace sink was requested. */
  loadRangeDiagnosticBindings?(): RangeDiagnosticBindings
  spawnCurrentTokenJobProcess: typeof spawnCurrentTokenJobProcess
  closeFileDescriptor(fileDescriptor: number): void
  resolveWindowsExecutable: typeof resolveWindowsExecutable
  pollProcessExit: typeof pollProcessExit
  isJobEmpty: typeof isJobEmpty
  terminateJob: typeof terminateJob
  closeHandleChecked: typeof closeHandleChecked
}

const defaultInternals: SpawnRunnerInternals = {
  /* v8 ignore next -- source/built/packaged subprocess smoke executes this only in a replaceable child process. */
  execve: (file, argv, env, control) => loadLinuxExecve()(file, argv, env, control),
  loadWin32ProcessBindings,
  loadRangeDiagnosticBindings,
  spawnCurrentTokenJobProcess,
  closeFileDescriptor: closeSync,
  resolveWindowsExecutable,
  pollProcessExit,
  isJobEmpty,
  terminateJob,
  closeHandleChecked,
}

const NODE_SPAWN_DETAIL_CODES = new Set(['EACCES', 'ENOENT'])
const WINDOWS_SPAWN_ERROR_CODES = new Map<number, string>([
  [2, 'ENOENT'],
  [3, 'ENOENT'],
  [267, 'ENOENT'],
  [5, 'EPERM'],
  [193, 'EFTYPE'],
  [740, 'EACCES'],
])

function nodeSpawnError(
  syscall: string,
  code: string,
  path?: string,
): SerializedRunnerError {
  const message = `${syscall} ${code}`
  return {
    name: 'Error',
    message,
    code,
    syscall,
    ...path === undefined ? {} : { path },
  }
}

function asSpawnError(
  error: unknown,
  program: string,
): SerializedRunnerError {
  const serialized = serializeRunnerError(error)
  if (!(error instanceof Win32Error)) {
    return serialized.code === undefined
      ? serialized
      : nodeSpawnError(`spawn ${program}`, serialized.code, program)
  }
  const code = WINDOWS_SPAWN_ERROR_CODES.get(error.win32Code) ?? 'UNKNOWN'
  if (NODE_SPAWN_DETAIL_CODES.has(code)) {
    return nodeSpawnError(`spawn ${program}`, code, program)
  }
  return nodeSpawnError('spawn', code)
}

function windowsPathNotFoundError(program: string): SerializedRunnerError {
  return nodeSpawnError(`spawn ${program}`, 'ENOENT', program)
}

function windowsStartCancelledError(): SerializedRunnerError {
  return {
    name: 'Error',
    message: 'subprocess target start was cancelled',
  }
}

function linuxPathNotFoundError(program: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`spawn ${program} ENOENT`), {
    code: 'ENOENT',
    errno: -2,
    syscall: `spawn ${program}`,
    path: program,
    spawnargs: [] as string[],
  })
}

function execLinuxFile(
  file: string,
  argv: string[],
  env: Record<string, string>,
  internals: SpawnRunnerInternals,
  control?: 'pipe',
): never {
  try {
    return control === undefined ? internals.execve(file, argv, env) : internals.execve(file, argv, env, control)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOEXEC') throw error
    return control === undefined
      ? internals.execve('/bin/sh', ['/bin/sh', file, ...argv.slice(1)], env)
      : internals.execve('/bin/sh', ['/bin/sh', file, ...argv.slice(1)], env, control)
  }
}

function execLinuxTarget(
  request: { cwd: string; env: Record<string, string>; control?: 'pipe' },
  argv: string[],
  internals: SpawnRunnerInternals,
): never {
  const program = argv[0] as string
  if (program.includes('/')) return execLinuxFile(program, argv, request.env, internals, request.control)
  const path = request.env.PATH ?? '/usr/bin:/bin'
  let permissionFailure: Error | undefined
  for (const directory of path.split(':')) {
    const root = directory.startsWith('/')
      ? directory
      : `${request.cwd}${request.cwd.endsWith('/') ? '' : '/'}${directory}`
    const candidate = `${root}${root.endsWith('/') ? '' : '/'}${program}`
    try {
      return execLinuxFile(candidate, argv, request.env, internals, request.control)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EACCES') {
        permissionFailure ??= error as Error
        continue
      }
      if (code === 'ENOENT' || code === 'ENOTDIR') continue
      throw error
    }
  }
  throw permissionFailure ?? linuxPathNotFoundError(program)
}

function runLinux(
  locator: string,
  argv: string[],
  host: RunnerHost,
  internals: SpawnRunnerInternals,
): void {
  const files = linuxLaunchFilesFromLocator(locator)
  let request: ReturnType<typeof consumeLinuxLaunchRequest>
  try {
    request = consumeLinuxLaunchRequest(files.requestPath)
  } catch (error) {
    writeLinuxStartupError(files, { type: 'error', error: serializeRunnerError(error) })
    host.exitCode = 127
    return
  }
  try {
    host.chdir(request.cwd)
    execLinuxTarget({ ...request, cwd: host.cwd() }, argv, internals)
  } catch (error) {
    writeLinuxStartupError(files, {
      type: 'error',
      error: asSpawnError(error, argv[0] as string),
    })
    host.exitCode = 127
  }
}

function sendMessage(host: RunnerHost, result: WindowsRunnerResult): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!host.connected || host.send === undefined) {
      reject(new Error('subprocess runner IPC is not connected'))
      return
    }
    try {
      host.send(result, (error) => {
        if (error === null) resolve()
        else reject(error)
      })
    } catch (error) {
      /* v8 ignore next -- process.send throws Error instances. */
      const failure = error instanceof Error ? error : new Error(String(error))
      reject(failure)
    }
  })
}

class WindowsJobRunner {
  private api: CurrentTokenProcessBindings | undefined
  private processHandle: NativePtr | undefined
  private jobHandle: NativePtr | undefined
  private pollTimer: ReturnType<typeof setInterval> | undefined
  private startSeen = false
  private terminateRequested = false
  private resultStarted = false
  private resultDelivered = false
  private finished = false
  /** Opt-in trace sink; absent unless the host set DSH_RUNNER_DIAG. */
  private diagnostic: RunnerDiagnostic | undefined
  /** Direct target parent pid, recorded for every diagnostic event. */
  private targetPid: number | undefined
  /** T1 reads the READY record at most once, whatever it concludes. */
  private readyChecked = false
  /** T1 observation reused by T2 as the creation-identity fence. */
  private t1Child: { readonly pid: number; readonly creationTime: string | undefined } | undefined
  private readonly completion = Promise.withResolvers<void>()
  /** Stable Job identity for range replies; never a PID (PIDs are reused). */
  private readonly jobId = randomUUID()
  /** Runner instance identity, distinct from the Job identity. */
  private readonly instanceId = randomUUID()
  /** Duplicate request ids replay the first answer; no second native terminate. */
  private readonly rangeReplies = new Map<number, unknown>()

  constructor(
    private readonly argv: string[],
    private readonly host: RunnerHost,
    private readonly internals: SpawnRunnerInternals,
  ) {}

  run(): Promise<void> {
    this.diagnostic = this.openDiagnostic()
    if (!this.host.connected || this.host.send === undefined) {
      this.finish(127, 'no-ipc-channel')
      return this.completion.promise
    }
    this.host.on('message', this.onMessage)
    this.host.once('disconnect', this.onDisconnect)
    return this.completion.promise
  }

  /**
   * Open the trace sink when the host requested one.
   * A failed open is not a runner failure: diagnostics are optional evidence, so
   * the runner keeps its normal lifecycle and simply runs untraced.
   * @returns the sink, or undefined when tracing is off or could not be opened.
   */
  private openDiagnostic(): RunnerDiagnostic | undefined {
    if (this.host.env[RUNNER_DIAG_ENV] === undefined) return undefined
    try {
      const internals = this.internals
      const api = internals.loadRangeDiagnosticBindings === undefined
        ? loadRangeDiagnosticBindings()
        : internals.loadRangeDiagnosticBindings()
      return createRunnerDiagnostic({
        env: this.host.env,
        jobId: this.jobId,
        instanceId: this.instanceId,
        api,
      })
    } catch (error) {
      recordDiagnosticOpenFailure(this.host.env, error)
      return undefined
    }
  }

  private readonly onMessage = (value: unknown): void => {
    if (this.finished) return
    const range = parseRangeRequest(value)
    if (range !== undefined) {
      void this.handleRange(range)
      return
    }
    if (isWindowsRangeLikeRequest(value)) {
      this.host.send?.({ type: 'protocol-error', reason: 'invalid-range-request', observedAt: new Date().toISOString() })
      return
    }
    if (isWindowsTerminateRequest(value)) {
      this.requestTermination()
      return
    }
    if (this.startSeen) {
      void this.runnerFailure(new Error('subprocess runner received more than one Windows start request'))
      return
    }
    let request: WindowsStartRequest
    try {
      request = parseWindowsStartRequest(value)
    } catch (error) {
      void this.runnerFailure(error)
      return
    }
    this.startSeen = true
    void this.start(request)
  }

  /** Send the start handshake and resolve only after the IPC write completed. */
  private sendStarted(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      if (!this.host.connected || this.host.send === undefined) { resolve(false); return }
      try {
        this.host.send({ type: 'started', jobId: this.jobId, instanceId: this.instanceId, pid: process.pid }, (error) => {
          resolve(error === null)
        })
      } catch {
        resolve(false)
      }
    })
  }

  /** Answer one range request against the runner-owned Job handle. */
  private async handleRange(request: RangeRequest): Promise<void> {
    const cached = this.rangeReplies.get(request.requestId)
    if (cached !== undefined) {
      this.host.send?.(cached)
      return
    }
    const api = this.api
    const job = this.jobHandle
    if (api === undefined || job === undefined) {
      this.diagnostic?.record('range-served', {
        phase: 'T5',
        request: request.type,
        state: 'unknown',
        detail: 'job-not-created',
      })
      this.host.send?.({
        type: 'range-result',
        requestId: request.requestId,
        jobId: this.jobId,
        state: 'unknown',
        evidence: ['job-not-created'],
        observedAt: new Date().toISOString(),
      })
      return
    }
    const reply = await handleRangeRequest(api, job, this.jobId, request)
    const envelope = { ...reply, instanceId: this.instanceId }
    this.rangeReplies.set(request.requestId, envelope)
    this.recordRangeServed(request, reply, job)
    this.host.send?.(envelope)
  }

  /**
   * T5: record the served range plus an independent ActiveProcesses re-query of
   * the same Job handle. The diagnostic count never replaces the range reply.
   * @param request - the range request being answered.
   * @param reply - the reply that will be sent on the official channel.
   * @param job - the runner's exact Job handle.
   */
  private recordRangeServed(
    request: RangeRequest,
    reply: { state: string; activeBefore?: number | undefined; activeAfter?: number | undefined },
    job: NativePtr,
  ): void {
    const diagnostic = this.diagnostic
    if (diagnostic === undefined) return
    try {
      const observed = activeProcesses(diagnostic.api, job)
      diagnostic.record('range-served', {
        phase: 'T5',
        request: request.type,
        state: reply.state,
        activeBefore: reply.activeBefore,
        activeAfter: reply.activeAfter,
        activeProcesses: observed.ok ? observed.value : undefined,
        nonce: diagnostic.nonce,
        ...observed.ok ? {} : {
          apiError: { api: observed.api, win32Code: observed.win32Code, detail: observed.detail },
        },
      })
    } catch (error) {
      diagnostic.record('range-served', {
        phase: 'T5',
        request: request.type,
        state: reply.state,
        detail: `observation-threw:${String(error)}`,
      })
    }
  }

  private readonly onDisconnect = (): void => {
    if (this.finished) return
    this.releaseOwnedJob()
    this.finish(127, 'runner-disconnected', false)
  }

  private async start(request: WindowsStartRequest): Promise<void> {
    if (this.terminateRequested) {
      await this.publishTerminalResult({ type: 'error', error: windowsStartCancelledError() }, 0)
      return
    }
    await new Promise<void>((resolveImmediate) => { setImmediate(resolveImmediate) })
    if (this.finished) return
    // IPC may set this field while start() is suspended above.
    // oxlint-disable-next-line typescript/no-unnecessary-condition
    if (this.terminateRequested) {
      await this.publishTerminalResult({ type: 'error', error: windowsStartCancelledError() }, 0)
      return
    }
    try {
      const [command, ...args] = this.argv
      const applicationName = this.internals.resolveWindowsExecutable(
        command as string,
        request.cwd,
        request.env,
        undefined,
        { ...this.host.env },
      )
      if (applicationName === undefined) {
        await this.publishTerminalResult({
          type: 'error',
          error: windowsPathNotFoundError(command as string),
        }, 0)
        return
      }
      this.api = this.internals.loadWin32ProcessBindings()
      const spawned = this.internals.spawnCurrentTokenJobProcess(this.api, {
        command: command as string,
        applicationName,
        args,
        cwd: request.cwd,
        env: request.env,
        stdio: { stdin: 4, stdout: 5, stderr: 6, ...request.control === 'pipe' ? { control: SUBPROCESS_CONTROL_FD } : {} },
      })
      this.processHandle = spawned.process
      this.jobHandle = spawned.job
      this.targetPid = spawned.pid
      this.diagnostic?.record('target-spawned', { targetPid: spawned.pid })
      // The handshake must complete before polling starts, so target-exit can
      // never be published ahead of started — even for a target that exits
      // immediately after spawn.
      const handshake = await this.sendStarted()
      if (!handshake) {
        this.releaseOwnedJob()
        this.finish(127, 'started-handshake-failed')
        return
      }
      for (const fileDescriptor of request.control === 'pipe' ? [4, 5, 6, SUBPROCESS_CONTROL_FD] : [4, 5, 6]) {
        this.internals.closeFileDescriptor(fileDescriptor)
      }
      this.pollTimer = setInterval(() => { this.poll() }, 10)
    } catch (error) {
      if (this.jobHandle === undefined && error instanceof Win32Error && error.api === 'CreateProcessW') {
        await this.publishTerminalResult({
          type: 'error',
          error: asSpawnError(error, this.argv[0] as string),
        }, 0)
        return
      }
      await this.runnerFailure(error)
    }
  }

  private requestTermination(): void {
    if (this.terminateRequested) return
    this.terminateRequested = true
    try {
      this.terminateOwnedJob()
    } catch (error) {
      void this.runnerFailure(error)
    }
  }

  private terminateOwnedJob(): void {
    const job = this.jobHandle
    if (job === undefined) return
    /* v8 ignore next -- a Job handle is assigned only after the bindings are loaded;
     * the guard above is the only reachable empty-owner state. */
    if (this.api === undefined) return
    this.internals.terminateJob(this.api, job, 1)
  }

  private poll(): void {
    if (this.finished) return
    /* v8 ignore next -- poll is installed only after start() stores the bindings; retained as a defensive invariant guard. */
    if (this.api === undefined) return
    try {
      this.observeReadyChild()
      if (this.processHandle !== undefined) {
        const exitCode = this.internals.pollProcessExit(this.api, this.processHandle)
        if (exitCode !== undefined) {
          // T2 runs before the existing exit handling so the observation still
          // sees the Job holding whatever survived the direct target.
          this.observeRootExit()
          this.internals.closeHandleChecked(this.api, this.processHandle, 'ordinary direct process')
          this.processHandle = undefined
          void this.publishTerminalResult({ type: 'target-exit', exitCode })
        }
      }
      if (this.jobHandle !== undefined && this.internals.isJobEmpty(this.api, this.jobHandle)) {
        this.internals.closeHandleChecked(this.api, this.jobHandle, 'ordinary process Job')
        this.jobHandle = undefined
        if (this.resultDelivered) this.finish(0, 'job-empty-after-result')
      }
    } catch (error) {
      void this.runnerFailure(error)
    }
  }

  /**
   * T1: accept the fixture's READY record once, then sample that exact pid
   * against the runner's Job handle.
   *
   * Every outcome is terminal for T1: the record is consumed at most once, so a
   * malformed or mismatched handshake is reported instead of retried forever.
   */
  private observeReadyChild(): void {
    const diagnostic = this.diagnostic
    if (diagnostic === undefined || this.readyChecked) return
    const readyFile = diagnostic.readyFile
    if (readyFile === undefined) return
    if (!existsSync(readyFile)) return
    this.readyChecked = true
    try {
      const ready = JSON.parse(readFileSync(readyFile, 'utf8')) as { pid?: unknown; nonce?: unknown }
      const pid = ready.pid
      if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) {
        diagnostic.record('ready-invalid', { phase: 'T1', detail: 'pid-not-a-process-id' })
        return
      }
      if (diagnostic.nonce === undefined || ready.nonce !== diagnostic.nonce) {
        diagnostic.record('ready-invalid', {
          phase: 'T1',
          childPid: pid,
          nonce: typeof ready.nonce === 'string' ? ready.nonce : undefined,
          detail: 'nonce-mismatch',
        })
        return
      }
      if (this.jobHandle === undefined) {
        diagnostic.record('ready-invalid', { phase: 'T1', childPid: pid, detail: 'job-handle-missing' })
        return
      }
      const sample = sampleChild(diagnostic.api, this.jobHandle, { pid })
      const fields = childSampleFields(sample)
      this.t1Child = { pid, creationTime: typeof fields.creationTime === 'string' ? fields.creationTime : undefined }
      diagnostic.record('child-observed', {
        ...fields,
        phase: 'T1',
        targetPid: this.targetPid,
        nonce: typeof ready.nonce === 'string' ? ready.nonce : undefined,
      })
    } catch (error) {
      diagnostic.record('ready-invalid', { phase: 'T1', detail: `observation-threw:${String(error)}` })
    }
  }

  /**
   * T2: re-sample the T1 child through the same Job handle once the direct
   * target has exited, before the existing result and Job-empty handling runs.
   */
  private observeRootExit(): void {
    const diagnostic = this.diagnostic
    if (diagnostic === undefined || this.jobHandle === undefined) return
    const t1 = this.t1Child
    if (t1 === undefined) {
      diagnostic.record('root-exit-observed', {
        phase: 'T2',
        targetPid: this.targetPid,
        detail: 't1-child-not-observed',
      })
      return
    }
    try {
      const sample = sampleChild(diagnostic.api, this.jobHandle, {
        pid: t1.pid,
        ...t1.creationTime === undefined ? {} : { expectedCreationTime: t1.creationTime },
      })
      diagnostic.record('root-exit-observed', {
        ...childSampleFields(sample),
        phase: 'T2',
        targetPid: this.targetPid,
        nonce: diagnostic.nonce,
      })
    } catch (error) {
      diagnostic.record('root-exit-observed', {
        phase: 'T2',
        targetPid: this.targetPid,
        detail: `observation-threw:${String(error)}`,
      })
    }
  }

  private async publishTerminalResult(result: WindowsRunnerResult, exitCode?: number): Promise<void> {
    /* v8 ignore next -- each state transition has a single result call site; the guard contains only re-entrant internal defects. */
    if (this.finished || this.resultStarted) return
    this.resultStarted = true
    try {
      await sendMessage(this.host, result)
      this.resultDelivered = true
      this.diagnostic?.record('direct-result', {
        state: result.type,
        exitCode: result.type === 'target-exit' ? result.exitCode : null,
        targetPid: this.targetPid,
      })
    } catch {
      this.releaseOwnedJob()
      this.finish(127, 'terminal-send-failed', false)
      return
    }
    if (exitCode !== undefined) {
      this.finish(exitCode, 'terminal-result-delivered')
      return
    }
    if (this.jobHandle === undefined) this.finish(0, 'job-already-empty')
  }

  private async runnerFailure(error: unknown): Promise<void> {
    /* v8 ignore next -- callers stop/detach on finish; this guard contains only an already-queued internal callback. */
    if (this.finished) return
    this.diagnostic?.record('runner-failure', {
      targetPid: this.targetPid,
      error: serializeRunnerError(error),
    })
    if (!this.resultStarted) {
      this.resultStarted = true
      try {
        await sendMessage(this.host, { type: 'error', error: serializeRunnerError(error) })
        this.resultDelivered = true
      } catch {
        // The disconnected parent observes runner infrastructure failure.
      }
    }
    this.releaseOwnedJob()
    this.finish(127, 'runner-failure')
  }

  private releaseOwnedJob(): void {
    if (this.pollTimer !== undefined) clearInterval(this.pollTimer)
    this.pollTimer = undefined
    const api = this.api
    if (api === undefined) return
    if (this.jobHandle !== undefined) {
      try { this.internals.terminateJob(api, this.jobHandle, 1) } catch { /* Continue to kill-on-close. */ }
      try { this.internals.closeHandleChecked(api, this.jobHandle, 'ordinary process Job cleanup') } catch { /* Best effort after failure. */ }
      this.jobHandle = undefined
    }
    if (this.processHandle !== undefined) {
      try { this.internals.closeHandleChecked(api, this.processHandle, 'ordinary direct process cleanup') } catch { /* Best effort after failure. */ }
      this.processHandle = undefined
    }
  }

  /**
   * Settle the runner exactly once.
   * @param exitCode - process exit code reported to the host.
   * @param callSource - real call site that settled the runner; recorded verbatim.
   * @param disconnect - whether to close the IPC channel on settlement.
   */
  private finish(exitCode: number, callSource: string, disconnect = true): void {
    if (this.finished) return
    this.finished = true
    this.diagnostic?.record('finish', { exitCode, callSource, targetPid: this.targetPid })
    if (this.pollTimer !== undefined) clearInterval(this.pollTimer)
    this.pollTimer = undefined
    this.host.off('message', this.onMessage)
    this.host.off('disconnect', this.onDisconnect)
    this.host.exitCode = exitCode
    if (disconnect && this.host.connected) this.host.disconnect()
    this.completion.resolve()
  }
}

/**
 * Execute the selected Linux bootstrap or Windows Job runner.
 * @param selection - Windows sentinel or Linux launch-request locator.
 * @param argv - private runner arguments beginning with the target delimiter.
 * @param host - process transport and lifecycle host.
 * @param internals - native and filesystem operations used by the runner.
 */
export async function runSpawnRunner(
  selection: string,
  argv: readonly string[],
  host: RunnerHost = process,
  internals: SpawnRunnerInternals = defaultInternals,
): Promise<void> {
  Reflect.deleteProperty(host.env, SUBPROCESS_RUNNER_ENV)
  const targetArgv = parseRunnerTargetArgv(argv)
  if (selection === WINDOWS_RUNNER_SELECTION) {
    await new WindowsJobRunner(targetArgv, host, internals).run()
    return
  }
  runLinux(selection, targetArgv, host, internals)
}

/**
 * Best-effort reporting for failures before the selected runner established its owner.
 * @param selection - Windows sentinel, Linux launch-request locator, or no selection.
 * @param error - failure raised before normal runner settlement.
 * @param host - process transport and lifecycle host.
 */
export async function reportSpawnRunnerFailure(
  selection: string | undefined,
  error: unknown,
  host: RunnerHost = process,
): Promise<void> {
  if (selection === WINDOWS_RUNNER_SELECTION) {
    try { await sendMessage(host, { type: 'error', error: serializeRunnerError(error) }) } catch { /* No transport remains. */ }
    host.exitCode = 127
    if (host.connected) host.disconnect()
    return
  }
  if (selection !== undefined) {
    try {
      const files: LinuxLaunchFiles = linuxLaunchFilesFromLocator(selection)
      writeLinuxStartupError(files, { type: 'error', error: serializeRunnerError(error) })
    } catch {
      // The parent will report an unconsumed request or missing runner result.
    }
  }
  host.exitCode = 127
}
