/**
 * Windows file IO for the quarantine registry: write-through with a temporary
 * file plus rename, a stale-temp recovery on load, and a single-writer lock.
 *
 * A second writer is refused rather than silently sharing the file: the store
 * assumes one process owns the registry for its lifetime.
 *
 * @module @deepseek-ai/dsh-sandbox-local/quarantine-io
 */

import { closeSync, existsSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs'
import type { QuarantineStoreIo } from './quarantine.ts'

/** File IO used by {@link QuarantineStore.load}. */
export interface WindowsQuarantineIoOptions {
  /** Refuse a second writer by holding `<file>.lock` (default true). */
  lock?: boolean
}

class WindowsIo implements QuarantineStoreIo {
  private lockFd: number | undefined

  constructor(private readonly file: string, private readonly options: WindowsQuarantineIoOptions) {}

  /** Take the writer lock; throws when another process already holds it. */
  acquireLock(): void {
    if (this.options.lock === false) return
    const lockFile = `${this.file}.lock`
    try {
      this.lockFd = openSync(lockFile, 'wx')
      writeSync(this.lockFd, String(process.pid))
    } catch {
      throw new Error(`quarantine: another writer already owns ${this.file}`)
    }
  }

  /** Recover a stale temp file left by a crash: promote it or discard it. */
  recoverTemp(): void {
    const temp = `${this.file}.tmp`
    if (!existsSync(temp)) return
    if (existsSync(this.file)) {
      rmSync(temp, { force: true })
      return
    }
    renameSync(temp, this.file)
  }

  read(file: string): string | undefined {
    if (!existsSync(file)) return undefined
    return readFileSync(file, 'utf8')
  }

  write(file: string, content: string): void {
    writeFileSync(file, content, 'utf8')
  }

  rename(from: string, to: string): void {
    renameSync(from, to)
  }

  /** Release the writer lock (best effort; the OS drops it on exit). */
  release(): void {
    if (this.lockFd !== undefined) {
      try { closeSync(this.lockFd) } catch { /* already closed */ }
      this.lockFd = undefined
      rmSync(`${this.file}.lock`, { force: true })
    }
  }
}

let active: WindowsIo | undefined

/**
 * Open the registry IO for one process. Takes the writer lock and recovers a
 * stale temp file before the store reads anything.
 */
export function windowsQuarantineIo(file?: string, options: WindowsQuarantineIoOptions = {}): QuarantineStoreIo & { release?: () => void } {
  const target = file ?? ''
  if (target === '') return { read: () => undefined, write: () => undefined, rename: () => undefined }
  active?.release()
  const io = new WindowsIo(target, options)
  io.acquireLock()
  io.recoverTemp()
  active = io
  return io
}

/** Release the process-wide writer lock (tests / shutdown). */
export function releaseQuarantineLock(): void {
  active?.release()
  active = undefined
}
