/**
 * Quarantine: the durable registry of resources whose release was not
 * confirmed. It sits ON TOP of the residue ledger (D4) and never rewrites it:
 * the ledger keeps recording facts, quarantine decides what may happen next.
 *
 * Rules:
 * - a quarantined resource refuses new acquires;
 * - `release-failed` and `temp-dir` residues may be retried automatically;
 * - `refcount-corrupt` must pass an ownership verification first, because the
 *   accounting, not the release, is what failed;
 * - nothing becomes `released` without evidence, and a ledger entry is never
 *   deleted to un-quarantine a resource.
 *
 * @module @deepseek-ai/dsh-sandbox-local/quarantine
 */

export type QuarantineReason = 'release-failed' | 'refcount-corrupt' | 'temp-dir' | 'unknown'
export type QuarantineState = 'quarantined' | 'retrying' | 'released'
export type QuarantineAcl = 'present' | 'absent' | 'unchecked'

export interface QuarantineHistoryEntry {
  readonly at: string
  readonly action: string
  readonly outcome: string
  readonly note?: string
}

export interface QuarantineRecord {
  readonly id: string
  readonly kind: string
  readonly owner: string
  readonly sessionId?: string
  readonly workspaceRoot?: string
  readonly paths: readonly string[]
  readonly sidString?: string
  readonly reason: QuarantineReason
  readonly state: QuarantineState
  /** False means a human must clear it (ownership/accounting doubt). */
  readonly autoRetry: boolean
  readonly attempts: number
  readonly history: readonly QuarantineHistoryEntry[]
  readonly lastObservedAcl: QuarantineAcl
  readonly resolution?: { readonly at: string; readonly by: string; readonly evidence: readonly string[] }
}

export interface QuarantineInput {
  id: string
  kind: string
  owner: string
  sessionId?: string
  workspaceRoot?: string
  paths?: readonly string[]
  sidString?: string
  reason: QuarantineReason
  lastObservedAcl?: QuarantineAcl
  note?: string
}

export interface RetryResult {
  readonly released: boolean
  readonly evidence: readonly string[]
  readonly note?: string
}

/** Minimal filesystem surface so the store is testable without a disk. */
export interface QuarantineStoreIo {
  read(file: string): string | undefined
  write(file: string, content: string): void
  rename(from: string, to: string): void
}

const VERSION = 1

/** Integrity of the loaded store; anything but `ok` forbids new acquires. */
export type QuarantineIntegrity = 'ok' | 'corrupted'

/** Durable quarantine registry. Every mutation writes through before it returns. */
export class QuarantineStore {
  private readonly records = new Map<string, QuarantineRecord>()
  private readonly file?: string
  private readonly io?: QuarantineStoreIo
  private readonly clock: () => string
  /** Load diagnostics: a corrupt file is preserved, never silently dropped. */
  readonly corruption?: string
  /**
   * `corrupted` means the previous registry could not be read: no record can be
   * trusted, so every managed resource stays closed until a human clears it.
   */
  readonly integrity: QuarantineIntegrity

  constructor(options: { file?: string; io?: QuarantineStoreIo; clock?: () => string; corruption?: string; integrity?: QuarantineIntegrity } = {}) {
    this.file = options.file
    this.io = options.io
    this.clock = options.clock ?? (() => new Date().toISOString())
    this.corruption = options.corruption
    this.integrity = options.integrity ?? 'ok'
  }

  /**
   * Load a store from disk. A missing file is an empty store; an unparsable or
   * unknown-version file is preserved as `<file>.corrupt-<ts>` and reported, so
   * the caller can surface it instead of losing the identity of the residue.
   */
  static load(options: { file: string; io: QuarantineStoreIo; clock?: () => string }): QuarantineStore {
    const clock = options.clock ?? (() => new Date().toISOString())
    const store = new QuarantineStore({ file: options.file, io: options.io, clock })
    const raw = options.io.read(options.file)
    if (raw === undefined) return store
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      const corrupt = `${options.file}.corrupt-${clock().replace(/[:.]/g, '-')}`
      options.io.rename(options.file, corrupt)
      return new QuarantineStore({ file: options.file, io: options.io, clock, corruption: corrupt, integrity: 'corrupted' })
    }
    const doc = parsed as { version?: number; entries?: unknown[] }
    if (doc.version !== VERSION || !Array.isArray(doc.entries)) {
      const corrupt = `${options.file}.corrupt-${clock().replace(/[:.]/g, '-')}`
      options.io.rename(options.file, corrupt)
      return new QuarantineStore({ file: options.file, io: options.io, clock, corruption: corrupt, integrity: 'corrupted' })
    }
    for (const entry of doc.entries as QuarantineRecord[]) {
      if (entry !== null && typeof entry === 'object' && typeof entry.id === 'string') {
        store.records.set(entry.id, entry)
      }
    }
    return store
  }

  /** Register (or refresh) a residue. Duplicate ids never create a second record. */
  register(input: QuarantineInput): QuarantineRecord {
    const previous = this.records.get(input.id)
    const autoRetry = input.reason !== 'refcount-corrupt'
    const record: QuarantineRecord = {
      id: input.id,
      kind: input.kind,
      owner: input.owner,
      sessionId: input.sessionId ?? previous?.sessionId,
      workspaceRoot: input.workspaceRoot ?? previous?.workspaceRoot,
      paths: input.paths ?? previous?.paths ?? [],
      sidString: input.sidString ?? previous?.sidString,
      reason: previous?.state === 'released' ? previous.reason : input.reason,
      state: previous?.state === 'released' ? 'released' : 'quarantined',
      autoRetry: previous?.state === 'released' ? previous.autoRetry : autoRetry,
      attempts: previous?.attempts ?? 0,
      history: [...(previous?.history ?? []), { at: this.clock(), action: 'register', outcome: input.reason, note: input.note }],
      lastObservedAcl: input.lastObservedAcl ?? previous?.lastObservedAcl ?? 'unchecked',
      resolution: previous?.resolution,
    }
    this.records.set(record.id, record)
    this.persist()
    return record
  }

  get(id: string): QuarantineRecord | undefined {
    return this.records.get(id)
  }

  /** True only when the store is intact and this id is not quarantined. */
  acquireAllowed(id: string): boolean {
    return this.integrity === 'ok' && !this.isQuarantined(id)
  }

  /** Fail-closed gate used by the provider before materializing a resource. */
  assertAcquireAllowed(id: string): void {
    if (this.integrity !== 'ok') {
      throw new Error(`quarantine: registry integrity is ${this.integrity}; refusing ${id} until a human clears it`)
    }
    if (this.isQuarantined(id)) {
      throw new Error(`quarantine: ${id} is quarantined`)
    }
  }

  /** A quarantined resource refuses new acquires until it is released. */
  isQuarantined(id: string): boolean {
    const record = this.records.get(id)
    return record !== undefined && record.state !== 'released'
  }

  list(): readonly QuarantineRecord[] {
    return [...this.records.values()]
  }

  /** Records that need a human: ownership doubt, or retries exhausted by policy. */
  needsHuman(): readonly QuarantineRecord[] {
    return this.list().filter((record) => record.state !== 'released' && record.autoRetry === false)
  }

  /**
   * Controlled retry. Refused for `refcount-corrupt` until ownership is verified,
   * and never runs the release twice for one id.
   */
  async retry(id: string, releaser: () => Promise<RetryResult>): Promise<QuarantineRecord> {
    const record = this.records.get(id)
    if (record === undefined) throw new Error(`quarantine: unknown id ${id}`)
    if (record.state === 'released') return record
    if (record.state === 'retrying') throw new Error(`quarantine: ${id} is retrying`)
    if (record.autoRetry === false) {
      throw new Error(`quarantine: ${id} requires ownership verification before any retry`)
    }
    this.records.set(id, { ...record, state: 'retrying', attempts: record.attempts + 1, history: [...record.history, { at: this.clock(), action: 'retry', outcome: 'started' }] })
    this.persist()
    let result: RetryResult
    try {
      result = await releaser()
    } catch (error) {
      result = { released: false, evidence: [], note: String(error) }
    }
    const latest = this.records.get(id) as QuarantineRecord
    const next: QuarantineRecord = result.released
      ? {
          ...latest,
          state: 'released',
          lastObservedAcl: 'absent',
          history: [...latest.history, { at: this.clock(), action: 'retry', outcome: 'released', note: result.evidence.join(', ') }],
          resolution: { at: this.clock(), by: 'quarantine-retry', evidence: result.evidence },
        }
      : {
          ...latest,
          state: 'quarantined',
          history: [...latest.history, { at: this.clock(), action: 'retry', outcome: 'still-quarantined', note: result.note ?? result.evidence.join(', ') }],
        }
    this.records.set(id, next)
    this.persist()
    return next
  }

  /**
   * Verify ownership for a `refcount-corrupt` residue: the caller proves the
   * resource is really this record's before any retry becomes possible.
   */
  verifyOwnership(id: string, verifier: () => boolean): QuarantineRecord {
    const record = this.records.get(id)
    if (record === undefined) throw new Error(`quarantine: unknown id ${id}`)
    const ok = verifier()
    const next: QuarantineRecord = {
      ...record,
      autoRetry: ok ? true : record.autoRetry,
      history: [...record.history, { at: this.clock(), action: 'verify-ownership', outcome: ok ? 'confirmed' : 'rejected' }],
    }
    this.records.set(id, next)
    this.persist()
    return next
  }

  /**
   * Human disposition: requires evidence and an observed-absent ACL. Deleting a
   * ledger row is not evidence and is not accepted here.
   */
  resolve(id: string, input: { by: string; evidence: readonly string[] }): QuarantineRecord {
    const record = this.records.get(id)
    if (record === undefined) throw new Error(`quarantine: unknown id ${id}`)
    if (input.evidence.length === 0) throw new Error(`quarantine: resolving ${id} requires evidence`)
    if (record.lastObservedAcl !== 'absent') throw new Error(`quarantine: ${id} is not observed absent; refusing to resolve`)
    const next: QuarantineRecord = {
      ...record,
      state: 'released',
      resolution: { at: this.clock(), by: input.by, evidence: input.evidence },
      history: [...record.history, { at: this.clock(), action: 'resolve', outcome: 'released', note: input.evidence.join(', ') }],
    }
    this.records.set(id, next)
    this.persist()
    return next
  }

  /** Observe the current ACL state; recorded separately from history. */
  observe(id: string, acl: QuarantineAcl): QuarantineRecord {
    const record = this.records.get(id)
    if (record === undefined) throw new Error(`quarantine: unknown id ${id}`)
    const next: QuarantineRecord = { ...record, lastObservedAcl: acl, history: [...record.history, { at: this.clock(), action: 'observe', outcome: acl }] }
    this.records.set(id, next)
    this.persist()
    return next
  }

  /** Persist atomically; a write failure surfaces to the caller. */
  persist(): void {
    if (this.file === undefined || this.io === undefined) return
    const payload = JSON.stringify({ version: VERSION, entries: this.list() }, null, 1)
    const temp = `${this.file}.tmp`
    this.io.write(temp, payload)
    this.io.rename(temp, this.file)
  }
}

export const QUARANTINE_VERSION = VERSION
