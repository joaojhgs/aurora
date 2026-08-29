import type { JsonObject, ToolingPrepareExecutionResponse } from '../types.js'
import { canonicalJsonSha256Hex } from './canonical-json.js'
import type { LocalToolExecuteRequest } from './execution-policy.js'
import type { LocalToolExecutionContext } from './tool-registry.js'

export type ProviderLocalApprovalChoice = 'approve' | 'deny'

export interface ProviderLocalApprovalRequest {
  readonly id: string
  readonly toolDisplayName: string
  readonly toolDescription: string
  readonly callerPeerId: string
  readonly displayArgsPreview: JsonObject
  readonly createdAtMs: number
  readonly expiresAtMs: number
}

export interface ProviderLocalApprovalSnapshot {
  readonly pending: readonly ProviderLocalApprovalRequest[]
  readonly revision: number
}

export type ProviderLocalApprovalDecision =
  | { readonly status: 'approved'; readonly approvalId: string }
  | {
      readonly status: 'denied' | 'pending_timeout' | 'cancelled' | 'expired' | 'already_consumed' | 'closed'
      readonly approvalId: string
    }

export interface ProviderLocalApprovalWaitInput {
  readonly prepared: ToolingPrepareExecutionResponse
  readonly request: LocalToolExecuteRequest
  readonly context: LocalToolExecutionContext
  readonly toolDisplayName: string
  readonly toolDescription: string
  readonly signal: AbortSignal
}

export interface ProviderLocalApprovalControllerPort {
  snapshot(): ProviderLocalApprovalSnapshot
  subscribe(listener: (snapshot: ProviderLocalApprovalSnapshot) => void): () => void
  decide(approvalId: string, choice: ProviderLocalApprovalChoice): boolean
  awaitApproval(input: ProviderLocalApprovalWaitInput): Promise<ProviderLocalApprovalDecision>
  releaseClaim(approvalId: string): boolean
  consumeClaim(approvalId: string): boolean
  close(): void
}

export interface ProviderLocalApprovalControllerOptions {
  readonly approvalTtlMs?: number
  readonly requestWaitMs?: number
  readonly nowMs?: () => number
}

type StoredApprovalState = 'pending' | 'approved' | 'denied' | 'claimed' | 'consumed'

interface StoredApproval {
  readonly fingerprint: string
  readonly view: ProviderLocalApprovalRequest
  readonly waiters: Map<number, (decision: ProviderLocalApprovalDecision) => void>
  state: StoredApprovalState
}

const DEFAULT_APPROVAL_TTL_MS = 5 * 60_000
const DEFAULT_REQUEST_WAIT_MS = 60_000

/**
 * Keeps approval authority on the device that owns the sensitive capability.
 *
 * Remote callers can wait for a decision, but they cannot approve themselves
 * or receive the one-time execution token minted by the local policy.
 */
export class ProviderLocalApprovalController implements ProviderLocalApprovalControllerPort {
  private readonly approvalTtlMs: number
  private readonly requestWaitMs: number
  private readonly nowMs: () => number
  private readonly approvals = new Map<string, StoredApproval>()
  private readonly listeners = new Set<(snapshot: ProviderLocalApprovalSnapshot) => void>()
  private revision = 0
  private nextWaiterId = 1
  private closed = false

  constructor(options: ProviderLocalApprovalControllerOptions = {}) {
    this.approvalTtlMs = positiveDuration(options.approvalTtlMs, DEFAULT_APPROVAL_TTL_MS)
    this.requestWaitMs = positiveDuration(options.requestWaitMs, DEFAULT_REQUEST_WAIT_MS)
    this.nowMs = options.nowMs ?? (() => Date.now())
  }

  snapshot(): ProviderLocalApprovalSnapshot {
    this.cleanupExpired()
    return {
      pending: [...this.approvals.values()]
        .filter((approval) => approval.state === 'pending')
        .sort((left, right) => left.view.createdAtMs - right.view.createdAtMs)
        .map((approval) => cloneApprovalView(approval.view)),
      revision: this.revision
    }
  }

  subscribe(listener: (snapshot: ProviderLocalApprovalSnapshot) => void): () => void {
    this.listeners.add(listener)
    listener(this.snapshot())
    return () => {
      this.listeners.delete(listener)
    }
  }

  decide(approvalId: string, choice: ProviderLocalApprovalChoice): boolean {
    this.cleanupExpired()
    const approval = this.approvals.get(approvalId)
    if (!approval || approval.state !== 'pending') return false
    approval.state = choice === 'approve' ? 'approved' : 'denied'
    this.changed()
    this.resolveWaiters(approval)
    return true
  }

  async awaitApproval(input: ProviderLocalApprovalWaitInput): Promise<ProviderLocalApprovalDecision> {
    this.cleanupExpired()
    const fingerprint = approvalFingerprint(input)
    const approvalId = approvalIdFromFingerprint(fingerprint)
    if (this.closed) return { status: 'closed', approvalId }

    let approval = this.approvals.get(approvalId)
    if (!approval) {
      const now = this.nowMs()
      approval = {
        fingerprint,
        view: {
          id: approvalId,
          toolDisplayName: input.toolDisplayName,
          toolDescription: input.toolDescription,
          callerPeerId: input.context.callerPeerId,
          displayArgsPreview: cloneJsonObject(input.prepared.display_args_preview ?? {}),
          createdAtMs: now,
          expiresAtMs: now + this.approvalTtlMs
        },
        state: 'pending',
        waiters: new Map()
      }
      this.approvals.set(approvalId, approval)
      this.changed()
    } else if (approval.fingerprint !== fingerprint) {
      return { status: 'denied', approvalId }
    }

    const immediate = this.claimResolvedApproval(approval)
    if (immediate) return immediate
    if (input.signal.aborted) return { status: 'cancelled', approvalId }

    return await new Promise<ProviderLocalApprovalDecision>((resolve) => {
      const waiterId = this.nextWaiterId++
      let settled = false
      const settle = (decision: ProviderLocalApprovalDecision) => {
        if (settled) return
        settled = true
        approval!.waiters.delete(waiterId)
        clearTimeout(timer)
        input.signal.removeEventListener('abort', onAbort)
        resolve(decision)
      }
      const onAbort = () => settle({ status: 'cancelled', approvalId })
      const timer = setTimeout(
        () => settle({ status: 'pending_timeout', approvalId }),
        this.requestWaitMs
      )
      approval!.waiters.set(waiterId, settle)
      input.signal.addEventListener('abort', onAbort, { once: true })

      const decision = this.claimResolvedApproval(approval!)
      if (decision) settle(decision)
    })
  }

  releaseClaim(approvalId: string): boolean {
    const approval = this.approvals.get(approvalId)
    if (!approval || approval.state !== 'claimed') return false
    approval.state = 'approved'
    this.changed()
    this.resolveWaiters(approval)
    return true
  }

  consumeClaim(approvalId: string): boolean {
    const approval = this.approvals.get(approvalId)
    if (!approval || approval.state !== 'claimed') return false
    approval.state = 'consumed'
    this.changed()
    return true
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const approval of this.approvals.values()) {
      for (const settle of approval.waiters.values()) {
        settle({ status: 'closed', approvalId: approval.view.id })
      }
    }
    this.approvals.clear()
    this.changed()
    this.listeners.clear()
  }

  private claimResolvedApproval(approval: StoredApproval): ProviderLocalApprovalDecision | null {
    if (approval.state === 'pending') return null
    if (approval.state === 'denied') return { status: 'denied', approvalId: approval.view.id }
    if (approval.state === 'approved') {
      approval.state = 'claimed'
      this.changed()
      return { status: 'approved', approvalId: approval.view.id }
    }
    return { status: 'already_consumed', approvalId: approval.view.id }
  }

  private resolveWaiters(approval: StoredApproval): void {
    for (const settle of [...approval.waiters.values()]) {
      const decision = this.claimResolvedApproval(approval)
      if (decision) settle(decision)
    }
  }

  private cleanupExpired(): void {
    if (this.closed) return
    const now = this.nowMs()
    let changed = false
    for (const [approvalId, approval] of this.approvals) {
      if (approval.view.expiresAtMs > now) continue
      for (const settle of approval.waiters.values()) {
        settle({ status: 'expired', approvalId })
      }
      this.approvals.delete(approvalId)
      changed = true
    }
    if (changed) this.changed()
  }

  private changed(): void {
    this.revision += 1
    if (this.listeners.size === 0) return
    const snapshot = this.snapshot()
    for (const listener of this.listeners) listener(snapshot)
  }
}

function approvalFingerprint(input: ProviderLocalApprovalWaitInput): string {
  // correlation_id is the execution identity at this boundary: transport
  // retries preserve it, while a separate user invocation must allocate a new
  // value so identical arguments cannot reuse an earlier owner decision.
  return canonicalJsonSha256Hex({
    caller_peer_id: input.context.callerPeerId,
    caller_principal_id: input.context.callerPrincipalId ?? null,
    provider_peer_id: input.prepared.provider_peer_id,
    provider_service_instance_id: input.prepared.provider_service_instance_id,
    global_tool_id: input.prepared.global_tool_id,
    local_tool_name: input.prepared.local_tool_name,
    args_hash: input.prepared.args_hash,
    resource_selector_hash: input.prepared.resource_selector_hash,
    route_decision_id: input.prepared.route_decision_id,
    correlation_id: input.request.correlation_id ?? null,
    schedule_id: input.request.schedule_id ?? null,
    scheduled_action_hash: input.request.scheduled_action_hash ?? null,
    dry_run: input.request.dry_run === true
  })
}

function approvalIdFromFingerprint(fingerprint: string): string {
  return `local-approval-${fingerprint.slice(0, 32)}`
}

function positiveDuration(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number(value) > 0 ? Number(value) : fallback
}

function cloneApprovalView(view: ProviderLocalApprovalRequest): ProviderLocalApprovalRequest {
  return {
    ...view,
    displayArgsPreview: cloneJsonObject(view.displayArgsPreview)
  }
}

function cloneJsonObject(value: JsonObject): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject
}
