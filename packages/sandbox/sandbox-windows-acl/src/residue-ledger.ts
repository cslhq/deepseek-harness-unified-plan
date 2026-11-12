/**
 * Failure residue ledger for Windows ACL resources.
 *
 * It records what is NOT confirmed released — never what a caller believes is
 * released. A resource closes only when its ACE removal AND its native SID
 * release are both confirmed; a freed SID with a surviving ACE is orphaned and
 * needs a human, a retained SID with a surviving ACE stays retryable.
 *
 * @module @deepseek-ai/dsh-sandbox-windows-acl/residue-ledger
 */

/** Resource families this ledger can hold. */
export type ResidueKind = 'acl-grant' | 'acl-sandbox' | 'temp-dir'

/** Retry decision for one residue: retryable, or needs a human. */
export type ResidueState = 'retryable' | 'needs-human' | 'closed'

/** One ledger record. `id` is stable across retries of the same resource. */
export interface ResidueEntry {
  readonly id: string
  readonly kind: ResidueKind
  /** Owning component, e.g. `AclWriteGrant`, `AclSandbox`, `LocalSandboxProvider`. */
  readonly owner: string
  /** Calling session identity, when the owner knows it. */
  readonly sessionId?: string | undefined
  /** Workspace root the resource belongs to, when known. */
  readonly workspaceRoot?: string | undefined
  /** Directories whose ACE may still carry the capability SID. */
  readonly paths: readonly string[]
  /** Directories whose ACE removal is confirmed (historical evidence). */
  readonly removedPaths: readonly string[]
  /**
   * Capability SID string, when the owner knows it. It is what makes an
   * orphaned ACE recoverable: the ACE itself stores the SID, and a re-parsed
   * SID can revoke it again.
   */
  readonly sidString?: string | undefined
  /** Latest on-disk ACL observation, distinct from the historical evidence. */
  readonly observedAcl: 'present' | 'absent' | 'unchecked'
  /** ACE removal confirmed for every recorded path. */
  readonly aceRemoved: boolean
  /** Native SID allocations confirmed released exactly once. */
  readonly sidsFreed: boolean
  readonly state: ResidueState
  readonly failures: readonly unknown[]
  /** How many times this resource was registered/observed. */
  readonly attempts: number
  /** Last observation timestamp (ISO). */
  readonly lastObservedAt: string
  /** Human-readable outcome of the last observation. */
  readonly lastObservation: string
}

/** Registration payload; the ledger owns the bookkeeping fields. */
export interface ResidueInput {
  id: string
  kind: ResidueKind
  owner: string
  sessionId?: string | undefined
  workspaceRoot?: string | undefined
  paths?: readonly string[]
  removedPaths?: readonly string[]
  sidString?: string | undefined
  observedAcl?: 'present' | 'absent' | 'unchecked'
  aceRemoved?: boolean
  sidsFreed?: boolean
  failures?: readonly unknown[]
  observation?: string
}

/**
 * Derive the retry decision from three independent facts: whether every ACE
 * is gone, whether the native SIDs were released, and whether a capability
 * SID string survives to rebuild them.
 *
 * A freed SID with a surviving ACE is recoverable while its SID string is
 * known (the ACE stores the SID; a re-parsed SID revokes it again), and only
 * becomes `needs-human` when the identity is lost.
 */
function classify(aceRemoved: boolean, sidsFreed: boolean, sidString: string | undefined, observedAcl: 'present' | 'absent' | 'unchecked'): ResidueState {
  // A current observation that the ACE is present outranks historical evidence:
  // the historical flag only records that an earlier revoke succeeded.
  if (observedAcl === 'present') {
    if (!sidsFreed) return 'retryable'
    return sidString !== undefined ? 'retryable' : 'needs-human'
  }
  if (aceRemoved && sidsFreed) return 'closed'
  if (!sidsFreed) return 'retryable'
  return sidString !== undefined ? 'retryable' : 'needs-human'
}

/** In-memory residue ledger shared by the ACL owners. */
export class ResidueLedger {
  private readonly entries = new Map<string, ResidueEntry>()

  /**
   * Register or update one residue. Recording is monotonic: a later
   * observation can only mark more confirmations, never fewer, so a stale
   * caller cannot declare a resource released.
   */
  register(input: ResidueInput): ResidueEntry {
    const previous = this.entries.get(input.id)
    const aceRemoved = (previous?.aceRemoved ?? false) || (input.aceRemoved ?? false)
    const sidsFreed = (previous?.sidsFreed ?? false) || (input.sidsFreed ?? false)
    const removedPaths = [...new Set([...(previous?.removedPaths ?? []), ...(input.removedPaths ?? [])])]
    const sidString = input.sidString ?? previous?.sidString
    const failures = input.failures !== undefined ? input.failures : previous?.failures ?? []
    const paths = input.paths !== undefined ? input.paths : previous?.paths ?? []
    const entry: ResidueEntry = {
      id: input.id,
      kind: input.kind,
      owner: input.owner,
      sessionId: input.sessionId ?? previous?.sessionId,
      workspaceRoot: input.workspaceRoot ?? previous?.workspaceRoot,
      paths,
      removedPaths,
      sidString,
      observedAcl: input.observedAcl ?? previous?.observedAcl ?? 'unchecked',
      aceRemoved,
      sidsFreed,
      state: classify(aceRemoved, sidsFreed, sidString, input.observedAcl ?? previous?.observedAcl ?? 'unchecked'),
      failures,
      attempts: (previous?.attempts ?? 0) + 1,
      lastObservedAt: new Date().toISOString(),
      lastObservation: input.observation ?? previous?.lastObservation ?? '',
    }
    this.entries.set(entry.id, entry)
    return entry
  }

  /** Annotate ownership facts the owner learned later (session/workspace). */
  annotate(id: string, facts: { sessionId?: string; workspaceRoot?: string }): ResidueEntry | undefined {
    const previous = this.entries.get(id)
    if (previous === undefined) return undefined
    return this.register({ id, kind: previous.kind, owner: previous.owner, paths: previous.paths, removedPaths: previous.removedPaths, sidString: previous.sidString, observedAcl: previous.observedAcl, aceRemoved: previous.aceRemoved, sidsFreed: previous.sidsFreed, failures: previous.failures, observation: previous.lastObservation, ...facts })
  }

  /** Confirmed release of every dimension; drops the record. */
  close(id: string): boolean {
    const entry = this.entries.get(id)
    if (entry === undefined) return false
    if (!entry.aceRemoved || !entry.sidsFreed) return false
    this.entries.delete(id)
    return true
  }

  get(id: string): ResidueEntry | undefined {
    return this.entries.get(id)
  }

  has(id: string): boolean {
    return this.entries.has(id)
  }

  list(): readonly ResidueEntry[] {
    return [...this.entries.values()]
  }

  /** Entries that still need a retry or a human. */
  open(): readonly ResidueEntry[] {
    return this.list().filter((entry) => entry.state !== 'closed')
  }
}
