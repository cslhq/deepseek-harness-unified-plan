/**
 * Resource leases: reference-counted ownership of a shared ACL resource.
 *
 * A workspace grant is one resource shared by every session that writes into
 * that workspace; a temp capability is one resource per session/workspace
 * pair. A lease is one holder's claim on such a resource. The resource is
 * released exactly once — when its last holder releases — and a lease is
 * independent of residues: `ResidueLedger` records unconfirmed releases and
 * never counts as a holder.
 *
 * @module @deepseek-ai/dsh-sandbox-local/lease
 */

import type { ResidueLedger } from '@deepseek-ai/dsh-sandbox-windows-acl'

export type LeaseKind = 'workspace' | 'temp'
/** Session lifecycle as seen by the lease registry. */
export type SessionDrainState = 'open' | 'draining' | 'drained' | 'residue'

/** What one drain attempt reports. */
export interface SessionDrainResult {
  readonly state: 'drained' | 'residue'
  /** Leases this session held and released during the drain. */
  readonly released: number
  /** Ledger ids still unconfirmed for this session when the drain finished. */
  readonly residues: readonly string[]
}
export type LeaseState = 'held' | 'releasing' | 'released'
export type LeaseOutcomeState = 'released' | 'quarantined'

/** What a lease reports once its owner releases it. */
export interface LeaseOutcome {
  readonly state: LeaseOutcomeState
  /** Ledger id of the residue, when the release could not be confirmed. */
  readonly residueId?: string
  /**
   * Why a release was not confirmed: an ordinary release failure, or a
   * reference-count corruption the registry refused to act on.
   */
  readonly reason?: 'release-failed' | 'refcount-corrupt'
}

/** The resource a lease holder keeps alive; released only by the last lease. */
export interface LeaseResource {
  /** Stable identity of the shared resource (workspace root or temp capability key). */
  readonly key: string
  readonly kind: LeaseKind
  /** Ledger id used when the release cannot be confirmed. */
  readonly residueId: string
  /** Release the underlying ACL resource once (D1 dispose / temp-dir removal). */
  releaseResource(): Promise<void>
}

/** One holder's claim on a shared resource. */
export interface Lease {
  readonly id: string
  readonly kind: LeaseKind
  readonly resourceKey: string
  readonly state: LeaseState
  /** Current owning session (changes on {@link transfer}). */
  readonly ownerSessionId: string
  /** Idempotent: every call shares the settlement of the first. */
  release(): Promise<LeaseOutcome>
  /** Move ownership to another session without changing the refcount. */
  transfer(sessionId: string): void
}

interface ResourceRecord {
  readonly key: string
  readonly kind: LeaseKind
  readonly resource: LeaseResource
  holders: number
  /** Set once the last holder released; later acquires are refused. */
  closed: boolean
  releasing?: Promise<LeaseOutcome>
}

interface LeaseRecord {
  readonly id: string
  readonly resourceKey: string
  readonly kind: LeaseKind
  sessionId: string
  state: LeaseState
  settled?: Promise<LeaseOutcome>
}

/**
 * Reference-counted lease registry. One registry per provider.
 *
 * Invariants:
 * - `acquire` is the only way to raise the count; `release` lowers it once per
 *   lease and clamps at zero (a second release never decrements again);
 * - the resource is released only on the transition to zero holders;
 * - a failed release leaves the ledger entry (D4) and returns `quarantined`;
 *   it never reports `released`;
 * - ledger entries are not leases and never appear in `holders`.
 */
export class ResourceLeaseRegistry {
  private readonly resources = new Map<string, ResourceRecord>()
  private readonly leases = new Map<string, LeaseRecord>()
  private readonly sessions = new Map<string, { id: string; state: SessionDrainState; draining?: Promise<SessionDrainResult> | undefined; pendingResidues: Set<string> }>()
  private sequence = 0

  constructor(private readonly ledger: ResidueLedger) {}

  /** Register (or join) a shared resource and return one holder's lease. */
  acquire(resource: LeaseResource, sessionId: string): Lease {
    const session = this.sessions.get(sessionId)
    if (session !== undefined && session.state !== 'open') {
      throw new Error(`session ${sessionId} is ${session.state}: no new lease may be acquired`)
    }
    let record = this.resources.get(resource.key)
    if (record === undefined) {
      record = { key: resource.key, kind: resource.kind, resource, holders: 0, closed: false }
      this.resources.set(resource.key, record)
    }
    if (record.closed) {
      throw new Error(`lease resource ${resource.key} is closed: the last holder already released it`)
    }
    record.holders += 1
    const id = `lease:${resource.kind}:${resource.key}:${++this.sequence}`
    const leaseRecord: LeaseRecord = { id, resourceKey: resource.key, kind: resource.kind, sessionId, state: 'held' }
    this.leases.set(id, leaseRecord)
    return this.view(leaseRecord)
  }

  /** Refuse further acquires for this session; its held leases stay valid. */
  beginDrain(sessionId: string): SessionDrainState {
    const record = this.sessions.get(sessionId)
    if (record === undefined) {
      this.sessions.set(sessionId, { id: sessionId, state: 'draining', pendingResidues: new Set() })
      return 'draining'
    }
    if (record.state === 'open') record.state = 'draining'
    return record.state
  }

  /** Current drain state of a session (open when never seen). */
  sessionState(sessionId: string): SessionDrainState {
    return this.sessions.get(sessionId)?.state ?? 'open'
  }

  /**
   * Drain one session: refuse new leases, release every lease it still owns
   * (a transferred lease belongs to the new owner and is left alone), then
   * report what the ledger still cannot confirm.
   *
   * Idempotent and concurrent-safe: every caller shares one settlement.
   * `drained` only means "this session released everything it held"; it is
   * NOT proof that every resource was released — that is `residues` empty
   * AND the release outcomes being `released`.
   */
  drainSession(sessionId: string): Promise<SessionDrainResult> {
    const existing = this.sessions.get(sessionId)
    if (existing?.draining !== undefined) return existing.draining
    const record = existing ?? { id: sessionId, state: 'draining' as SessionDrainState, pendingResidues: new Set<string>() }
    this.sessions.set(sessionId, record)
    if (record.state === 'open') record.state = 'draining'
    const run = (async (): Promise<SessionDrainResult> => {
      const released = await this.releaseSession(sessionId)
      // A quarantined release is an unconfirmed resource even when the ledger
      // entry carries no session id, so both sources feed the result.
      const quarantined = released
        .filter(({ outcome }) => outcome.state !== 'released' && outcome.residueId !== undefined)
        .map(({ outcome }) => outcome.residueId as string)
      for (const id of quarantined) record.pendingResidues.add(id)
      // Keep attribution to this session even when the ledger entry has no
      // session id, so a later drain still sees its own unconfirmed resources.
      for (const id of [...record.pendingResidues]) {
        if (!this.ledger.has(id)) record.pendingResidues.delete(id)
      }
      const ledgerEntries = this.ledger
        .open()
        .filter((entry) => entry.sessionId === sessionId)
        .map((entry) => entry.id)
      const residues = [...new Set([...quarantined, ...record.pendingResidues, ...ledgerEntries])]
      record.state = residues.length === 0 ? 'drained' : 'residue'
      // A residue may be cleaned up later (directory retry), so a fresh drain
      // must be allowed to re-evaluate; a drained session keeps its settlement.
      if (residues.length > 0) record.draining = undefined
      return { state: residues.length === 0 ? 'drained' : 'residue', released: released.length, residues }
    })()
    record.draining = run
    run.catch(() => {
      record.state = 'residue'
    })
    return run
  }

  /** Current holder count of one resource (0 when unknown/closed). */
  holders(resourceKey: string): number {
    return this.resources.get(resourceKey)?.holders ?? 0
  }

  /** Leases still held, optionally filtered by session. */
  active(sessionId?: string): readonly Lease[] {
    return [...this.leases.values()]
      .filter((record) => record.state !== 'released' && (sessionId === undefined || record.sessionId === sessionId))
      .map((record) => this.view(record))
  }

  /**
   * Release every held lease owned by `sessionId` (session end). A lease
   * transferred to another session is no longer this session's and is left
   * untouched. Returns each lease with its outcome so the caller can update
   * its own key→record maps.
   */
  async releaseSession(sessionId: string): Promise<readonly { lease: Lease; outcome: LeaseOutcome }[]> {
    const released: { lease: Lease; outcome: LeaseOutcome }[] = []
    for (const lease of this.active(sessionId)) {
      const outcome = await lease.release().catch(() => ({ state: 'quarantined' as const, residueId: lease.resourceKey, reason: 'release-failed' as const }))
      released.push({ lease, outcome })
    }
    return released
  }

  private view(record: LeaseRecord): Lease {
    const registry = this
    return {
      get id() { return record.id },
      get kind() { return record.kind },
      get resourceKey() { return record.resourceKey },
      get state() { return record.state },
      get ownerSessionId() { return record.sessionId },
      release: () => registry.release(record),
      transfer: (sessionId: string) => registry.transfer(record, sessionId),
    }
  }

  /** Drop one holder; the last one triggers the resource release exactly once. */
  private release(record: LeaseRecord): Promise<LeaseOutcome> {
    if (record.settled !== undefined) return record.settled
    const resourceRecord = this.resources.get(record.resourceKey)
    /* v8 ignore next -- a lease always owns a registered resource */
    if (resourceRecord === undefined) return Promise.resolve({ state: 'released' })
    record.state = 'releasing'
    if (resourceRecord.holders <= 0) {
      // Defensive: never drive the count below zero and never touch the native
      // resource again. This is an accounting corruption, not a release failure,
      // so it is recorded as a residue a human must look at.
      record.state = 'released'
      this.ledger.register({
        id: resourceRecord.resource.residueId,
        kind: 'acl-grant',
        owner: 'ResourceLeaseRegistry',
        paths: [],
        aceRemoved: false,
        sidsFreed: false,
        observation: 'lease reference count underflow: release refused without touching the resource',
      })
      record.settled = Promise.resolve({ state: 'quarantined', residueId: resourceRecord.resource.residueId, reason: 'refcount-corrupt' as const })
      return record.settled
    }
    resourceRecord.holders -= 1
    if (resourceRecord.holders > 0) {
      record.state = 'released'
      const outcome: LeaseOutcome = { state: 'released' }
      record.settled = Promise.resolve(outcome)
      return record.settled
    }
    resourceRecord.closed = true
    const run = (async (): Promise<LeaseOutcome> => {
      try {
        await resourceRecord.resource.releaseResource()
        this.leases.delete(record.id)
        this.resources.delete(resourceRecord.key)
        return { state: 'released' as const }
      } catch {
        // The resource keeps its residue entry (D4); the lease itself is spent.
        return { state: 'quarantined' as const, residueId: resourceRecord.resource.residueId, reason: 'release-failed' as const }
      }
    })()
    resourceRecord.releasing = run
    record.settled = run.then((outcome) => { record.state = 'released'; return outcome })
    return record.settled
  }

  /** Re-owner a held lease; the refcount never changes. */
  private transfer(record: LeaseRecord, sessionId: string): void {
    if (record.state !== 'held') {
      throw new Error(`lease ${record.id} is ${record.state}: only a held lease can be transferred`)
    }
    record.sessionId = sessionId
  }
}
