/**
 * Server-side write-grant materialization. The sandbox seam holds one
 * standing workspace grant per workspace and one revocable temp grant per
 * live session/workspace pair. Workspace identities survive by deterministic
 * derivation and their standing ACE; temp identities derive from random
 * private paths and are deliberately new after a restart.
 *
 * Fail-closed: `add` throws on any grant failure and the caller disposes the
 * instance (revoking every path granted so far); `dispose` revokes every
 * revocable grant, leaves the standing workspace edits in place, and reports
 * every cleanup failure.
 * @module @deepseek-ai/dsh-sandbox-windows-acl/grant
 */

import { grantWrite, revokeWrite } from './acl.ts'
import { allocPtrSlot, decodePtr, isNullPtr, throwLastError, win32Sync } from './ffi.ts'
import type { NativePtr, Win32Bindings } from './ffi.ts'
import { makeWellKnownSid } from './token.ts'
import * as abi from './win32-abi.ts'

/**
 * One write SID's provider-lifetime grant materialization: the parsed SID
 * pointer plus every directory whose DACL currently carries its ACE and whose
 * label ACL carries the Low mandatory label. Workspace paths are added
 * STANDING (their security descriptor edits are the cross-session reuse cache
 * and outlive the grant — dispose() skips revoking them, or the next
 * provision would re-propagate the whole tree); temp paths are revocable
 * (dispose() revokes them — an inheritable ACE must not outlive its
 * session's temp directory). Create with {@link AclWriteGrant.create};
 * dispose revokes the revocable paths and frees every SID.
 */
/** Dispose states of one grant. `failed` retains ownership so a retry can finish. */
export type GrantDisposeState = 'active' | 'disposing' | 'disposed' | 'failed'

/** What one grant reports to the residue ledger about its release. */
export interface GrantDisposeReport {
  readonly state: 'disposed' | 'failed'
  /** Revocable paths whose ACE may still carry the grant (failed attempts only). */
  readonly leftoverPaths: readonly string[]
  readonly failures: readonly unknown[]
  /** True only after every owned SID allocation was released exactly once. */
  readonly sidsFreed: boolean
}

export class AclWriteGrant {
  /** The write SID in SDDL string form. */
  readonly writeSid: string
  private readonly api: Win32Bindings
  /** Native SID allocations this grant owns; nulled once freed (single-release). */
  private sidPtr: NativePtr | null
  private lowLabelSidPtr: NativePtr | null
  private worldSidPtr: NativePtr | null
  private readonly revocablePaths: string[] = []
  private readonly standingPaths: string[] = []
  /** Dispose state machine: only a successful release reaches `disposed`. */
  private state: GrantDisposeState = 'active'
  /** The one settled outcome every caller shares; created by the first dispose(). */
  private settlement: Promise<void> | undefined
  /** Failures of the last dispose attempt (kept for the residue ledger). */
  private failures: readonly unknown[] = []

  private constructor(
    api: Win32Bindings,
    sidPtr: NativePtr,
    lowLabelSidPtr: NativePtr,
    worldSidPtr: NativePtr,
    writeSid: string,
  ) {
    this.api = api
    this.sidPtr = sidPtr
    this.lowLabelSidPtr = lowLabelSidPtr
    this.worldSidPtr = worldSidPtr
    this.writeSid = writeSid
  }

  /**
   * Parse the SID string, create the Low integrity SID the grants label with
   * and the world SID their ambient-delete deny names, and open the binding
   * table (lazily, once per server). Fail-closed: any failure throws — nothing
   * is granted yet.
   * @param writeSid - the workspace (`S-1-4-x-y`) or temp (`S-1-4-x-y-1`) capability SID string.
   * @param api - optional already-resolved bindings (tests).
   * @returns the ready grant (no ACEs yet).
   */
  static create(writeSid: string, api?: Win32Bindings): AclWriteGrant {
    const bindings = api ?? win32Sync()
    const sidSlot = allocPtrSlot()
    if (bindings.convertStringSidToSidW(writeSid, sidSlot) === 0) {
      throwLastError(bindings, 'ConvertStringSidToSidW', writeSid)
    }
    const sidPtr = decodePtr(sidSlot)
    if (sidPtr === null) throwLastError(bindings, 'ConvertStringSidToSidW', `null SID for ${writeSid}`)
    try {
      const lowLabelSidPtr = makeWellKnownSid(bindings, abi.WinLowLabelSid)
      try {
        const worldSidPtr = makeWellKnownSid(bindings, abi.WinWorldSid)
        return new AclWriteGrant(bindings, sidPtr, lowLabelSidPtr, worldSidPtr, writeSid)
      } catch (error) {
        // The Low label SID is LocalAlloc'd: release it before the world-SID
        // failure propagates to the sidPtr release below.
        bindings.localFree(lowLabelSidPtr)
        throw error
      }
    } catch (error) {
      bindings.localFree(sidPtr)
      throw error
    }
  }

  /**
   * Grant the write ACE, the ambient-delete deny, and the Low mandatory label
   * on one directory (idempotent: an already-standing exact ACE, deny, and
   * label skip the eager full-tree re-propagation — see {@link grantWrite})
   * and record the path for {@link dispose} unless it is standing. The path is
   * recorded BEFORE the grant: a post-apply throw (a LocalFree failure after
   * SetNamedSecurityInfoW succeeded) must still revoke it, and revoking an
   * ungranted path is a no-op merge. Callers treat a throw as a failed
   * materialization and dispose the instance to revoke the paths granted so
   * far.
   * @param path - the directory whose DACL and label gain the grant.
   * @param standing - the edits outlive this grant (the workspace reuse
   *   cache; dispose() skips revoking it). Default false (revoked on
   *   dispose — the temp-directory lifecycle).
   */
  add(path: string, standing = false): void {
    if (this.state !== 'active') throw new Error(`AclWriteGrant is ${this.state}: add() requires an active grant`)
    ;(standing ? this.standingPaths : this.revocablePaths).push(path)
    grantWrite(this.api, path, this.sidPtr!, this.lowLabelSidPtr!, this.worldSidPtr!)
  }

  /** Every directory currently carrying the grant, in grant order. */
  get paths(): readonly string[] {
    return [...this.standingPaths, ...this.revocablePaths]
  }

  /** Current dispose state (active until the first dispose() call). */
  get disposeState(): GrantDisposeState {
    return this.state
  }

  /** The report of the last attempt, for the residue ledger (D4). */
  get disposeReport(): GrantDisposeReport | undefined {
    if (this.state !== 'disposed' && this.state !== 'failed') return undefined
    return { state: this.state, leftoverPaths: [...this.revocablePaths], failures: this.failures, sidsFreed: this.sidsFreed() }
  }

  /**
   * Revoke every revocable grant (standing security descriptor edits stay) and
   * free the SIDs exactly once; shared by every caller.
   *
   * - concurrent/serial repeat calls observe the same settlement and never re-run
   *   the native release;
   * - a failed attempt keeps the SID allocations alive and the unrevoked paths
   *   recorded, so a retry can finish (freeing them early would orphan the ACEs);
   * - only a fully successful release reaches `disposed`.
   */
  dispose(): Promise<void> {
    if (this.settlement !== undefined) return this.settlement
    try {
      this.runDispose()
    } catch (error) {
      const rejected = Promise.reject(error)
      // Callers that never await must not trip an unhandled-rejection report;
      // the same promise still rejects for anyone who does.
      rejected.catch(() => undefined)
      this.settlement = rejected
      // A failed attempt releases ownership back to the caller for a retry once
      // the observed failure settles; until then repeat calls share this rejection.
      queueMicrotask(() => {
        if (this.state === 'failed') this.settlement = undefined
      })
      return rejected
    }
    this.settlement = Promise.resolve()
    return this.settlement
  }

  private sidsFreed(): boolean {
    return this.sidPtr === null && this.lowLabelSidPtr === null && this.worldSidPtr === null
  }

  /**
   * One synchronous release attempt. `dispose()` memoizes the settlement, so the
   * native release runs at most once per successful attempt: revoke every
   * revocable path (proof of removal), then free each owned SID exactly once.
   * A revoke failure keeps every SID alive and the path recorded.
   */
  private runDispose(): void {
    if (this.state === 'disposed') return
    this.state = 'disposing'
    const failures: unknown[] = []
    for (const path of [...this.revocablePaths]) {
      try {
        revokeWrite(this.api, path, this.sidPtr!)
        const index = this.revocablePaths.indexOf(path)
        if (index >= 0) this.revocablePaths.splice(index, 1)
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length > 0) {
      // The ACE may still be present: keep the SIDs (a retry needs them) and the
      // unrevoked paths (the residue ledger needs them). Never free here.
      this.failures = failures
      this.state = 'failed'
      throw new AggregateError(failures, `AclWriteGrant dispose completed with ${failures.length} cleanup failure(s)`)
    }
    const freeOne = (label: string, sidPtr: NativePtr | null, clear: () => void): void => {
      if (sidPtr === null) return
      try {
        const freed = this.api.localFree(sidPtr)
        if (!isNullPtr(freed)) throwLastError(this.api, 'LocalFree', label)
        clear()
      } catch (error) {
        failures.push(error)
      }
    }
    freeOne('write SID', this.sidPtr, () => { this.sidPtr = null })
    freeOne('Low label SID', this.lowLabelSidPtr, () => { this.lowLabelSidPtr = null })
    freeOne('world SID', this.worldSidPtr, () => { this.worldSidPtr = null })
    this.failures = failures
    if (failures.length > 0) {
      this.state = 'failed'
      throw new AggregateError(failures, `AclWriteGrant dispose completed with ${failures.length} cleanup failure(s)`)
    }
    this.state = 'disposed'
  }
}
