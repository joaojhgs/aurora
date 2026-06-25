'use client'

import { useEffect, useId, useMemo, useState } from 'react'
import { Check, Clock, RotateCcw, ShieldCheck, X } from 'lucide-react'
import type {
  ApprovalScope,
  AuroraClient,
  AuroraError,
  PrivacyClass,
  RouteExplainRequest,
  RoutePolicyInput,
  RoutePolicyEvaluation
} from '@aurora/client'
import { EvidenceBadge, PrivacyBadge, StatusBadge } from './status-badges'

export type RouteSheetScope = 'request' | 'session' | 'feature' | 'global'
export type AdminActionRouteState = 'not-required' | 'required' | 'drafted' | 'confirmed' | 'error'

export interface RouteSheetProps {
  client: AuroraClient
  title?: string
  description?: string
  topic?: string | null
  method?: string | null
  routeRequest?: RouteExplainRequest
  payload?: unknown
  selector?: unknown
  actionId?: string | null
  toolId?: string | null
  resourceId?: string | null
  sessionId?: string | null
  argsHash?: string | null
  dataClasses?: PrivacyClass[]
  privacyClass?: PrivacyClass
  approvalScopes?: ApprovalScope[]
  consentGranted?: boolean
  privacyIndicatorShown?: boolean
  allowCloudFallback?: boolean
  auditReceiptTarget?: string | null
  defaultScope?: RouteSheetScope
  requiresAdminAction?: boolean
  adminActionState?: AdminActionRouteState
  initialEvaluation?: RoutePolicyEvaluation
  onConfirm?: (evaluation: RoutePolicyEvaluation, scope: RouteSheetScope) => void
  onScopeChange?: (scope: RouteSheetScope) => void
}

export interface RouteSheetViewModel {
  loadState: 'loading' | 'ready' | 'error'
  evaluation: RoutePolicyEvaluation | null
  error: string | null
  selectedScope: RouteSheetScope
  canConfirm: boolean
  primaryReason: string
  adminActionState: AdminActionRouteState
}

const scopeOptions: Array<{ scope: RouteSheetScope; label: string; description: string }> = [
  { scope: 'request', label: 'Request', description: 'Use this route once.' },
  { scope: 'session', label: 'Session', description: 'Reuse while this session stays valid.' },
  { scope: 'feature', label: 'Feature', description: 'Apply to this feature surface.' },
  { scope: 'global', label: 'Global', description: 'Requires backend policy and admin confirmation.' }
]

export function RouteSheet({
  client,
  title = 'Route and privacy',
  description = 'Review target, privacy class, redacted payload, policy reason, and audit destination before data leaves this surface.',
  topic = null,
  method = null,
  routeRequest,
  payload,
  selector,
  actionId = null,
  toolId = null,
  resourceId = null,
  sessionId = null,
  argsHash = null,
  dataClasses,
  privacyClass,
  approvalScopes,
  consentGranted,
  privacyIndicatorShown,
  allowCloudFallback,
  auditReceiptTarget = null,
  defaultScope = 'request',
  requiresAdminAction = false,
  adminActionState,
  initialEvaluation,
  onConfirm,
  onScopeChange
}: RouteSheetProps) {
  const titleId = useId()
  const [selectedScope, setSelectedScope] = useState<RouteSheetScope>(defaultScope)
  const [evaluation, setEvaluation] = useState<RoutePolicyEvaluation | null>(initialEvaluation ?? null)
  const [loadState, setLoadState] = useState<RouteSheetViewModel['loadState']>(initialEvaluation ? 'ready' : 'loading')
  const [error, setError] = useState<string | null>(null)
  const effectiveAdminState = adminActionState ?? (requiresAdminAction ? 'required' : 'not-required')
  const evaluationKey = useMemo(
    () => stableKey({
      topic,
      method,
      routeRequest,
      payload,
      selector,
      actionId,
      toolId,
      resourceId,
      sessionId,
      argsHash,
      dataClasses,
      privacyClass,
      approvalScopes,
      consentGranted,
      privacyIndicatorShown,
      allowCloudFallback,
      auditReceiptTarget
    }),
    [
      topic,
      method,
      routeRequest,
      payload,
      selector,
      actionId,
      toolId,
      resourceId,
      sessionId,
      argsHash,
      dataClasses,
      privacyClass,
      approvalScopes,
      consentGranted,
      privacyIndicatorShown,
      allowCloudFallback,
      auditReceiptTarget
    ]
  )

  useEffect(() => {
    if (initialEvaluation) {
      setEvaluation(initialEvaluation)
      setLoadState('ready')
      setError(null)
      return
    }

    let cancelled = false
    setLoadState('loading')
    setError(null)

    client.routes.evaluatePolicy(compactRoutePolicyRequest({
      topic,
      method,
      routeRequest,
      payload,
      selector,
      actionId,
      toolId,
      resourceId,
      sessionId,
      argsHash,
      dataClasses,
      privacyClass,
      approvalScopes,
      consentGranted,
      privacyIndicatorShown,
      allowCloudFallback,
      auditReceiptTarget
    })).then(
      (nextEvaluation) => {
        if (cancelled) return
        setEvaluation(nextEvaluation)
        setLoadState('ready')
      },
      (nextError: unknown) => {
        if (cancelled) return
        setEvaluation(null)
        setLoadState('error')
        setError(routeSheetErrorMessage(nextError))
      }
    )

    return () => {
      cancelled = true
    }
  }, [client, evaluationKey, initialEvaluation])

  const model = buildRouteSheetViewModel({
    loadState,
    evaluation,
    error,
    selectedScope,
    requiresAdminAction,
    adminActionState: effectiveAdminState
  })

  function chooseScope(scope: RouteSheetScope) {
    setSelectedScope(scope)
    onScopeChange?.(scope)
  }

  function confirmRoute() {
    if (!model.evaluation || !model.canConfirm) return
    onConfirm?.(model.evaluation, model.selectedScope)
  }

  return (
    <section className="aui-route-sheet" aria-labelledby={titleId} data-state={model.loadState}>
      <header className="aui-route-sheet-header">
        <div>
          <p className="aui-kicker">Route guard</p>
          <h2 id={titleId}>{title}</h2>
          <p>{description}</p>
        </div>
        <RouteSheetDecision model={model} />
      </header>

      {model.loadState === 'loading' ? <RouteSheetNotice icon="loading" message="Loading route policy from AuroraClient." /> : null}
      {model.loadState === 'error' ? (
        <RouteSheetNotice icon="error" message={model.error ?? 'AuroraClient route policy evaluation failed.'} role="alert" />
      ) : null}

      {model.evaluation ? (
        <>
          <RoutePreviewGrid evaluation={model.evaluation} primaryReason={model.primaryReason} />
          <RouteCandidateList evaluation={model.evaluation} />
          <RouteScopeChooser selectedScope={selectedScope} canChoose={model.canConfirm} onChoose={chooseScope} />
          <div className="aui-route-policy">
            <div>
              <strong>Policy</strong>
              <span>{model.primaryReason}</span>
            </div>
            <div>
              <strong>AdminAction</strong>
              <span>{adminActionLabel(model.adminActionState)}</span>
            </div>
            <div>
              <strong>Rollback/error</strong>
              <span>{model.canConfirm ? 'Selection can be retried or changed before dispatch.' : 'Dispatch remains blocked until policy is repaired.'}</span>
            </div>
          </div>
        </>
      ) : null}

      <footer className="aui-route-sheet-footer">
        <button type="button" className="aui-button" disabled={!model.canConfirm} onClick={confirmRoute}>
          <ShieldCheck size={16} aria-hidden />
          <span>Use selected route</span>
        </button>
        {!model.canConfirm ? <p role="alert">{model.primaryReason}</p> : null}
      </footer>
    </section>
  )
}

export function buildRouteSheetViewModel(input: {
  loadState: RouteSheetViewModel['loadState']
  evaluation: RoutePolicyEvaluation | null
  error: string | null
  selectedScope: RouteSheetScope
  requiresAdminAction?: boolean
  adminActionState?: AdminActionRouteState
}): RouteSheetViewModel {
  const adminActionState = input.adminActionState ?? (input.requiresAdminAction ? 'required' : 'not-required')
  const adminBlocked = adminActionState === 'required' || adminActionState === 'drafted' || adminActionState === 'error'
  const canConfirm = Boolean(input.evaluation?.allowed && !adminBlocked)
  return {
    loadState: input.loadState,
    evaluation: input.evaluation,
    error: input.error,
    selectedScope: input.selectedScope,
    canConfirm,
    primaryReason: routeSheetPrimaryReason(input.evaluation, input.error, adminActionState),
    adminActionState
  }
}

export function routeSheetErrorMessage(error: unknown): string {
  const auroraError = error as Partial<AuroraError>
  if (auroraError.code === 'timeout') return 'AuroraClient timed out while loading route policy.'
  if (auroraError.code === 'auth' || auroraError.code === 'permission') return 'Route policy is unavailable because authentication or permissions failed.'
  if (auroraError.code === 'privacy_blocked') return 'Route policy is unavailable because backend privacy policy blocked the request.'
  if (error instanceof Error && error.message) return error.message
  return 'AuroraClient route policy evaluation failed.'
}

function RouteSheetDecision({ model }: { model: RouteSheetViewModel }) {
  if (model.loadState === 'loading') return <EvidenceBadge label="policy loading" />
  if (model.loadState === 'error') return <StatusBadge state="unsupported" />
  if (!model.evaluation) return <StatusBadge state="unsupported" />
  return (
    <div className="aui-route-sheet-decision">
      <StatusBadge state={model.evaluation.availability} />
      <PrivacyBadge privacy={model.evaluation.privacyClass} />
      <EvidenceBadge label={model.evaluation.allowed ? 'allowed' : model.evaluation.reasonCode} />
    </div>
  )
}

function RoutePreviewGrid({ evaluation, primaryReason }: { evaluation: RoutePolicyEvaluation; primaryReason: string }) {
  const preview = evaluation.preview
  return (
    <dl className="aui-route-preview">
      <div><dt>Target</dt><dd>{previewTarget(preview)}</dd></div>
      <div><dt>Privacy class</dt><dd>{preview.privacyClass}</dd></div>
      <div><dt>Payload</dt><dd><code>{stringifyPreview(preview.payloadPreview)}</code></dd></div>
      <div><dt>Policy reason</dt><dd>{primaryReason}</dd></div>
      <div><dt>Audit</dt><dd>{preview.auditReceiptTarget ?? 'audit placeholder pending backend receipt'}</dd></div>
      <div><dt>Secrets</dt><dd>{preview.secretsRedacted ? 'redacted by backend/SDK evidence' : 'redaction not reported'}</dd></div>
    </dl>
  )
}

function RouteCandidateList({ evaluation }: { evaluation: RoutePolicyEvaluation }) {
  const candidates = evaluation.route.candidates
  if (candidates.length === 0) {
    return (
      <div className="aui-route-empty">
        <X size={16} aria-hidden />
        <span>No route candidates were returned by the backend route policy surface.</span>
      </div>
    )
  }
  return (
    <ul className="aui-route-candidates" aria-label="Route candidates">
      {candidates.map((candidate) => (
        <li key={`${candidate.provider_id}:${candidate.service_instance_id}`}>
          <div>
            <strong>{candidate.provider_id}</strong>
            <span>{candidate.provider_kind} / {candidate.module}</span>
          </div>
          <EvidenceBadge label={candidate.selected ? 'selected' : candidate.included ? 'eligible' : candidate.reason_code} />
          <small>{candidate.reason || 'backend did not provide a reason'}</small>
        </li>
      ))}
    </ul>
  )
}

function RouteScopeChooser({
  selectedScope,
  canChoose,
  onChoose
}: {
  selectedScope: RouteSheetScope
  canChoose: boolean
  onChoose: (scope: RouteSheetScope) => void
}) {
  return (
    <fieldset className="aui-route-scope">
      <legend>Apply preference to</legend>
      <div>
        {scopeOptions.map((option) => (
          <button
            key={option.scope}
            type="button"
            className={option.scope === selectedScope ? 'active' : ''}
            disabled={!canChoose}
            aria-pressed={option.scope === selectedScope}
            title={option.description}
            onClick={() => onChoose(option.scope)}
          >
            {option.scope === selectedScope ? <Check size={14} aria-hidden /> : null}
            <span>{option.label}</span>
          </button>
        ))}
      </div>
    </fieldset>
  )
}

function RouteSheetNotice({ icon, message, role }: { icon: 'loading' | 'error'; message: string; role?: 'alert' }) {
  return (
    <div className={`aui-route-notice ${icon}`} role={role}>
      {icon === 'loading' ? <Clock size={16} aria-hidden /> : <RotateCcw size={16} aria-hidden />}
      <span>{message}</span>
    </div>
  )
}

function routeSheetPrimaryReason(
  evaluation: RoutePolicyEvaluation | null,
  error: string | null,
  adminActionState: AdminActionRouteState
): string {
  if (error) return error
  if (!evaluation) return 'Route policy has not returned backend evidence yet.'
  if (adminActionState === 'required') return 'AdminAction confirmation is required before this manage/admin-critical route can run.'
  if (adminActionState === 'drafted') return 'AdminAction draft exists but confirmation is still pending.'
  if (adminActionState === 'error') return 'AdminAction failed; retry or choose a different route.'
  if (evaluation.allowed) return evaluation.repairPath ?? 'Backend policy allows this route.'
  return evaluation.repairPath ?? evaluation.blockers[0]?.message ?? evaluation.reasonCode
}

function adminActionLabel(state: AdminActionRouteState): string {
  if (state === 'not-required') return 'not required'
  if (state === 'confirmed') return 'confirmed by backend-issued AdminAction'
  if (state === 'drafted') return 'drafted; waiting for confirmation'
  if (state === 'error') return 'error; route remains blocked'
  return 'required before dispatch'
}

function previewTarget(preview: RoutePolicyEvaluation['preview']): string {
  return [
    preview.egressDestination,
    preview.peerId ? `peer ${preview.peerId}` : null,
    preview.providerId ? `provider ${preview.providerId}` : null,
    preview.serviceInstanceId ? `service ${preview.serviceInstanceId}` : null
  ].filter(Boolean).join(' / ') || 'none'
}

function stringifyPreview(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return '[unserializable preview]'
  }
}

function stableKey(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(Date.now())
  }
}

function compactRoutePolicyRequest(input: {
  topic: string | null
  method: string | null
  routeRequest: RouteExplainRequest | undefined
  payload: unknown
  selector: unknown
  actionId: string | null
  toolId: string | null
  resourceId: string | null
  sessionId: string | null
  argsHash: string | null
  dataClasses: PrivacyClass[] | undefined
  privacyClass: PrivacyClass | undefined
  approvalScopes: ApprovalScope[] | undefined
  consentGranted: boolean | undefined
  privacyIndicatorShown: boolean | undefined
  allowCloudFallback: boolean | undefined
  auditReceiptTarget: string | null
}): Omit<RoutePolicyInput, 'route' | 'catalog' | 'transportKind'> & { routeRequest?: RouteExplainRequest } {
  const request: Omit<RoutePolicyInput, 'route' | 'catalog' | 'transportKind'> & { routeRequest?: RouteExplainRequest } = {}
  if (input.topic !== null) request.topic = input.topic
  if (input.method !== null) request.method = input.method
  if (input.routeRequest !== undefined) request.routeRequest = input.routeRequest
  if (input.payload !== undefined) request.payload = input.payload
  if (input.selector !== undefined) request.selector = input.selector
  if (input.actionId !== null) request.actionId = input.actionId
  if (input.toolId !== null) request.toolId = input.toolId
  if (input.resourceId !== null) request.resourceId = input.resourceId
  if (input.sessionId !== null) request.sessionId = input.sessionId
  if (input.argsHash !== null) request.argsHash = input.argsHash
  if (input.dataClasses !== undefined) request.dataClasses = input.dataClasses
  if (input.privacyClass !== undefined) request.privacyClass = input.privacyClass
  if (input.approvalScopes !== undefined) request.approvalScopes = input.approvalScopes
  if (input.consentGranted !== undefined) request.consentGranted = input.consentGranted
  if (input.privacyIndicatorShown !== undefined) request.privacyIndicatorShown = input.privacyIndicatorShown
  if (input.allowCloudFallback !== undefined) request.allowCloudFallback = input.allowCloudFallback
  if (input.auditReceiptTarget !== null) request.auditReceiptTarget = input.auditReceiptTarget
  return request
}
