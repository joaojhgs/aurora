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
import { cn } from '#lib/utils'
import { EvidenceBadge, PrivacyBadge, StatusBadge } from './status-badges'
import { safeErrorCopy } from './product-copy'

export type RouteSheetScope = 'request' | 'session' | 'feature' | 'global'
export type AdminActionRouteState = 'not-required' | 'required' | 'drafted' | 'confirmed' | 'error'
export type RouteSheetPolicySignalState = 'not-required' | 'preference' | 'satisfied' | 'blocked'

export interface RouteSheetPolicySignal {
  id: 'selector' | 'consent' | 'privacy-indicator' | 'native-permission' | 'admin-action'
  label: string
  state: RouteSheetPolicySignalState
  detail: string
}

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
  { scope: 'request', label: 'Request', description: 'Use this destination for this request.' },
  { scope: 'session', label: 'Session', description: 'Reuse while this session stays valid.' },
  { scope: 'feature', label: 'Feature', description: 'Remember this choice for this feature.' },
  { scope: 'global', label: 'Global', description: 'Apply everywhere, with administrator approval.' }
]

const ROUTE_SHEET_CLASS = '@container/route-sheet grid gap-5 m-0 border-t-0 px-5 pt-4 pb-5'
const ROUTE_COPY_WRAP_CLASS = 'min-w-0 [overflow-wrap:anywhere]'
const ROUTE_PREVIEW_LABEL_CLASS = 'text-[0.72rem] font-[750] uppercase text-[var(--aui-muted)]'
const ROUTE_PREVIEW_VALUE_CLASS = `m-0 min-w-0 text-[0.84rem] ${ROUTE_COPY_WRAP_CLASS}`
const ROUTE_POLICY_ROW_CLASS = 'grid gap-[0.12rem] rounded-[0.45rem] border border-[var(--aui-border)] bg-[var(--aui-surface)] p-[0.5rem]'
const ROUTE_SCOPE_BUTTON_CLASS = 'inline-flex min-h-[2.15rem] min-w-0 items-center justify-center gap-1 rounded-[0.45rem] border border-[var(--aui-border)] bg-[var(--aui-surface)] px-[0.55rem] py-[0.45rem] !text-[0.8rem] !font-[750] text-[var(--aui-muted)] disabled:cursor-not-allowed disabled:opacity-[0.56]'

export function RouteSheet({
  client,
  title = 'Destination and privacy',
  description = 'Choose where this request goes and review how your data is protected.',
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
    <section className={ROUTE_SHEET_CLASS} aria-labelledby={titleId} data-state={model.loadState}>
      <header className="grid gap-[0.65rem]">
        <div>
          <p className="mx-0 mt-1 mb-0 text-[0.86rem] font-[750] uppercase tracking-[0.13em] text-primary opacity-90">Before you continue</p>
          <h2 id={titleId} className="mt-1 mb-0 text-lg font-semibold">{title}</h2>
          <p className="mt-1 text-sm leading-relaxed text-[var(--aui-muted)]">{description}</p>
        </div>
        <RouteSheetDecision model={model} />
      </header>

      {model.loadState === 'loading' ? <RouteSheetNotice icon="loading" message="Loading policy from Aurora." /> : null}
      {model.loadState === 'error' ? (
        <RouteSheetNotice icon="error" message={routeSheetErrorMessage(model.error)} role="alert" />
      ) : null}

      {model.evaluation ? (
        <>
          <RoutePreviewGrid evaluation={model.evaluation} primaryReason={model.primaryReason} />
          <RouteCandidateList evaluation={model.evaluation} />
          <RoutePolicySignals evaluation={model.evaluation} adminActionState={model.adminActionState} />
          <RouteScopeChooser selectedScope={selectedScope} canChoose={model.canConfirm} onChoose={chooseScope} />
          <div className="grid gap-[0.4rem] in-[.aui-assistant]:gap-2 in-[.aui-assistant]:rounded-[0.65rem] in-[.aui-assistant]:border in-[.aui-assistant]:border-[var(--aui-border)] in-[.aui-assistant]:bg-[color-mix(in_srgb,var(--aui-surface-3)_26%,transparent)] in-[.aui-assistant]:p-3">
            <RoutePolicyRow label="Policy" value={model.primaryReason} />
            <RoutePolicyRow label="Admin approval" value={adminActionLabel(model.adminActionState)} />
            <RoutePolicyRow
              label="Retry"
              value={model.canConfirm ? 'You can change this choice before continuing.' : 'Resolve the items above before continuing.'}
            />
          </div>
        </>
      ) : null}

      <footer className="grid gap-[0.45rem]">
        <button
          type="button"
          className="inline-flex min-h-[2.45rem] w-fit items-center justify-center gap-[0.4rem] rounded-[0.42rem] border border-[var(--aui-border)] bg-muted/60 px-[0.8rem] py-[0.6rem] !text-[0.68rem] !font-[750] tracking-[0.005em] text-[var(--aui-ink)] disabled:cursor-not-allowed disabled:opacity-[0.58] enabled:hover:border-[rgb(94_234_212_/_0.45)] enabled:hover:text-[var(--aui-primary)]"
          disabled={!model.canConfirm}
          onClick={confirmRoute}
        >
          <ShieldCheck size={16} aria-hidden />
          <span>Use selected route</span>
        </button>
        {!model.canConfirm && model.loadState !== 'loading' ? <p className="text-[0.84rem] text-[var(--aui-danger)]" role="alert">{model.primaryReason}</p> : null}
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
  if (auroraError.code === 'timeout') return 'Aurora timed out while loading route policy.'
  if (auroraError.code === 'auth' || auroraError.code === 'permission') return 'Route policy is unavailable because authentication or permissions failed.'
  if (auroraError.code === 'privacy_blocked') return 'Route policy is unavailable until the required privacy choice is made.'
  return safeErrorCopy(error).title
}

function RouteSheetDecision({ model }: { model: RouteSheetViewModel }) {
  if (model.loadState === 'loading') return <EvidenceBadge label="policy loading" />
  if (model.loadState === 'error') return <StatusBadge state="unsupported" />
  if (!model.evaluation) return <StatusBadge state="unsupported" />
  return (
    <div className="flex flex-wrap gap-[0.35rem] in-[.aui-assistant]:items-center in-[.aui-assistant]:justify-end in-[.aui-assistant]:gap-[0.4rem]">
      <StatusBadge state={model.evaluation.availability} />
      <PrivacyBadge privacy={model.evaluation.privacyClass} />
      <EvidenceBadge label={routeSheetDecisionLabel(model.evaluation)} />
    </div>
  )
}

function RoutePreviewGrid({ evaluation, primaryReason }: { evaluation: RoutePolicyEvaluation; primaryReason: string }) {
  const preview = evaluation.preview
  return (
    <dl className="m-0 grid gap-2 @min-[30rem]/route-sheet:grid-cols-2">
      <RoutePreviewItem label="Destination" value={previewTarget(preview)} />
      <RoutePreviewItem label="Data type" value={privacyClassLabel(preview.privacyClass)} />
      <RoutePreviewItem label="Request details" value={payloadPreviewCopy(preview.payloadPreview)} />
      <RoutePreviewItem label="Status" value={primaryReason} />
      <RoutePreviewItem label="Account history" value={accountHistoryCopy(preview.auditReceiptTarget)} />
      <RoutePreviewItem label="Sensitive values" value={preview.secretsRedacted ? 'Hidden before review' : 'No hidden-value status reported'} />
    </dl>
  )
}

function RoutePreviewItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid min-w-0 gap-[0.15rem] rounded-[0.45rem] border border-[var(--aui-border)] bg-[color-mix(in_srgb,var(--aui-surface-2)_45%,var(--aui-bg))] p-2">
      <dt className={ROUTE_PREVIEW_LABEL_CLASS}>{label}</dt>
      <dd className={ROUTE_PREVIEW_VALUE_CLASS}>{value}</dd>
    </div>
  )
}

function RouteCandidateList({ evaluation }: { evaluation: RoutePolicyEvaluation }) {
  const candidates = evaluation.route.candidates
  if (candidates.length === 0) {
    return (
      <div className="flex items-start gap-[0.45rem] rounded-[0.45rem] border border-[var(--aui-border)] p-[0.55rem] text-[0.84rem] text-[var(--aui-muted)]">
        <X size={16} aria-hidden />
        <span>No destinations are available right now.</span>
      </div>
    )
  }
  return (
    <ul className="m-0 grid list-none gap-[0.65rem] p-0 [&_span]:min-w-0 [&_span]:[overflow-wrap:anywhere] [&_span]:text-[0.78rem] [&_span]:text-[var(--aui-muted)]" aria-label="Route candidates">
      {candidates.map((candidate) => (
        <li
          key={`${candidate.provider_id}:${candidate.service_instance_id}`}
          className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-[0.45rem] gap-y-[0.2rem] rounded-[0.45rem] border border-[var(--aui-border)] bg-[var(--aui-surface)] p-[0.55rem]"
        >
          <div className="flex min-w-0 flex-col gap-1">
            <strong className={`text-sm font-semibold ${ROUTE_COPY_WRAP_CLASS}`}>{candidateTitle(candidate)}</strong>
            <span className={`text-[0.78rem] text-[var(--aui-muted)] ${ROUTE_COPY_WRAP_CLASS}`}>{candidateKindCopy(candidate)}</span>
          </div>
          <EvidenceBadge label={candidateStateCopy(candidate)} />
          <small className={`col-span-full text-[0.78rem] text-[var(--aui-muted)] ${ROUTE_COPY_WRAP_CLASS}`}>
            {routeSheetReasonCopy(candidate.reason || candidate.reason_code)}
          </small>
        </li>
      ))}
    </ul>
  )
}


function RoutePolicySignals({
  evaluation,
  adminActionState
}: {
  evaluation: RoutePolicyEvaluation
  adminActionState: AdminActionRouteState
}) {
  const signals = routeSheetPolicySignals(evaluation, adminActionState)
  return (
    <dl className="m-0 grid gap-3" aria-label="Permissions and privacy">
      {signals.map((signal) => (
        <div className="grid min-w-0 gap-1.5 border-b border-[var(--aui-border)] pb-3 last:border-0 last:pb-0" key={signal.id} data-signal={signal.id} data-state={signal.state}>
          <dt className="flex flex-wrap items-center justify-between gap-2 text-sm font-medium">
            <span>{signal.label}</span>
            <EvidenceBadge label={routeSignalLabel(signal.state)} />
          </dt>
          <dd className={`m-0 text-xs leading-relaxed text-[var(--aui-muted)] ${ROUTE_COPY_WRAP_CLASS}`}>{signal.detail}</dd>
        </div>
      ))}
    </dl>
  )
}

function routeSignalLabel(state: RouteSheetPolicySignalState): string {
  if (state === 'not-required') return 'Not needed'
  if (state === 'preference') return 'Your choice'
  if (state === 'satisfied') return 'Confirmed'
  return 'Action needed'
}

export function routeSheetPolicySignals(
  evaluation: RoutePolicyEvaluation,
  adminActionState: AdminActionRouteState
): RouteSheetPolicySignal[] {
  const blockerCodes = new Set(evaluation.blockers.map((blocker) => blocker.code))
  const nativeBlocker = evaluation.blockers.find((blocker) => isNativePermissionBlocker(blocker.code, blocker.message))
  const selectorBlocked = [...blockerCodes].some(isSelectorBlockerCode)
  const selectorState: RouteSheetPolicySignalState = evaluation.explicitSelectorRequired
    ? evaluation.allowed && !selectorBlocked
      ? 'preference'
      : 'blocked'
    : 'not-required'
  const consentBlocked = blockerCodes.has('consent_required')
  const privacyIndicatorBlocked = blockerCodes.has('privacy_indicator_required')

  return [
    {
      id: 'selector',
      label: 'Device choice',
      state: selectorState,
      detail: selectorState === 'preference'
        ? 'A local destination preference is set; this route remains available.'
        : selectorState === 'blocked'
          ? 'Choose the device or resource before continuing.'
          : 'Aurora does not require an explicit selection for this route.'
    },
    {
      id: 'consent',
      label: 'Consent',
      state: consentBlocked ? 'blocked' : 'not-required',
      detail: consentBlocked
        ? 'Consent is missing and must be collected before this request can leave this device.'
        : 'No additional consent is needed.'
    },
    {
      id: 'privacy-indicator',
      label: 'Privacy indicator',
      state: privacyIndicatorBlocked ? 'blocked' : 'not-required',
      detail: privacyIndicatorBlocked
        ? 'The required privacy indicator has not been shown yet.'
        : 'No additional privacy notice is needed.'
    },
    {
      id: 'native-permission',
      label: 'Device permission',
      state: nativeBlocker ? 'blocked' : 'not-required',
      detail: nativeBlocker ? 'A device permission is missing.' : 'No additional device permission is needed.'
    },
    {
      id: 'admin-action',
      label: 'Admin approval',
      state: adminActionSignalState(adminActionState),
      detail: adminActionSignalDetail(adminActionState)
    }
  ]
}

function adminActionSignalState(state: AdminActionRouteState): RouteSheetPolicySignalState {
  if (state === 'not-required') return 'not-required'
  if (state === 'confirmed') return 'satisfied'
  return 'blocked'
}

function adminActionSignalDetail(state: AdminActionRouteState): string {
  if (state === 'not-required') return 'This route does not require administrator confirmation.'
  if (state === 'confirmed') return 'Administrator confirmation exists for this route.'
  if (state === 'drafted') return 'Administrator review is started but confirmation is still pending.'
  if (state === 'error') return 'Administrator review failed; retry or choose a different route.'
  return 'Administrator confirmation is required before continuing.'
}

function isSelectorBlockerCode(code: string): boolean {
  return code === 'explicit_selector_required' || code === 'selector_required' || code.includes('selector')
}

function isNativePermissionBlocker(code: string, message: string): boolean {
  const text = `${code} ${message}`.toLowerCase()
  return text.includes('native') && text.includes('permission')
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
    <fieldset className="m-0 min-w-0 border-0 p-0">
      <legend className="mb-[0.4rem] text-[0.72rem] font-[750] uppercase text-[var(--aui-muted)]">Apply preference to</legend>
      <div className="grid grid-cols-2 gap-[0.4rem]">
        {scopeOptions.map((option) => (
          <button
            key={option.scope}
            type="button"
            className={cn(
              ROUTE_SCOPE_BUTTON_CLASS,
              option.scope === selectedScope && 'border-[color-mix(in_srgb,var(--aui-primary)_38%,var(--aui-border))] bg-[color-mix(in_srgb,var(--aui-primary)_7%,var(--aui-bg))] text-[var(--aui-primary)]'
            )}
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
    <div
      className={cn(
        'flex items-center gap-[0.45rem] rounded-[0.62rem] border p-[0.68rem_0.75rem] text-[0.76rem] shadow-[inset_0_1px_0_rgba(255,255,255,0.035)]',
        icon === 'error'
          ? 'border-[color-mix(in_srgb,var(--aui-danger)_35%,var(--aui-border))] bg-[color-mix(in_srgb,var(--aui-danger)_7%,var(--aui-bg))] text-[var(--aui-danger)]'
          : 'border-border bg-card text-[var(--aui-muted)]'
      )}
      role={role}
    >
      {icon === 'loading' ? <Clock size={16} aria-hidden /> : <RotateCcw size={16} aria-hidden />}
      <span>{message}</span>
    </div>
  )
}

function RoutePolicyRow({ label, value }: { label: string; value: string }) {
  return (
    <div className={ROUTE_POLICY_ROW_CLASS}>
      <strong className="text-[0.72rem] uppercase text-[var(--aui-muted)] in-[.aui-assistant]:text-[0.76rem]">{label}</strong>
      <span className={`text-[0.83rem] in-[.aui-assistant]:text-[0.72rem] in-[.aui-assistant]:leading-[1.4] in-[.aui-assistant]:text-[var(--aui-muted)] ${ROUTE_COPY_WRAP_CLASS}`}>{value}</span>
    </div>
  )
}

function routeSheetPrimaryReason(
  evaluation: RoutePolicyEvaluation | null,
  error: string | null,
  adminActionState: AdminActionRouteState
): string {
  if (error) return safeErrorCopy({ code: 'connection_lost' }).title
  if (!evaluation) return 'Aurora has not returned policy status yet.'
  if (adminActionState === 'required') return 'Administrator confirmation is required before this sensitive route can run.'
  if (adminActionState === 'drafted') return 'Administrator review is started but confirmation is still pending.'
  if (adminActionState === 'error') return 'Administrator review failed; retry or choose a different route.'
  if (evaluation.allowed) return 'Policy allows this route.'
  return routeSheetReasonCopy(evaluation.repairPath || evaluation.blockers[0]?.message || evaluation.blockers[0]?.code || evaluation.reasonCode)
}

function adminActionLabel(state: AdminActionRouteState): string {
  if (state === 'not-required') return 'not required'
  if (state === 'confirmed') return 'confirmed by Aurora'
  if (state === 'drafted') return 'drafted; waiting for confirmation'
  if (state === 'error') return 'review failed; route remains blocked'
  return 'required before continuing'
}

function previewTarget(preview: RoutePolicyEvaluation['preview']): string {
  if (preview.peerId) return 'Connected Aurora device'
  if (preview.providerId || preview.serviceInstanceId) return 'Selected service'
  const normalized = normalizeRouteCopyToken(preview.egressDestination)
  if (normalized === 'local' || normalized === 'device' || normalized === 'this_device') return 'This device'
  if (normalized === 'cloud' || normalized === 'remote') return 'Approved external service'
  return 'Destination pending'
}

function payloadPreviewCopy(value: unknown): string {
  if (value === null || value === undefined) return 'No request details reported'
  return 'Request details hidden before review'
}

function accountHistoryCopy(value: string | null | undefined): string {
  return value ? 'Account history will be updated' : 'Account history pending'
}

function privacyClassLabel(value: PrivacyClass): string {
  if (value === 'raw-audio') return 'Audio'
  if (value === 'personal') return 'Personal'
  if (value === 'sensitive') return 'Sensitive'
  return 'Standard'
}

function routeSheetDecisionLabel(evaluation: RoutePolicyEvaluation): string {
  return evaluation.allowed ? 'allowed' : routeSheetReasonCodeCopy(evaluation.reasonCode)
}

function candidateTitle(candidate: RoutePolicyEvaluation['route']['candidates'][number]): string {
  return candidate.selected ? 'Selected destination' : candidate.included ? 'Available destination' : 'Unavailable destination'
}

function candidateKindCopy(candidate: RoutePolicyEvaluation['route']['candidates'][number]): string {
  const kind = normalizeRouteCopyToken(candidate.provider_kind)
  const module = normalizeRouteCopyToken(candidate.module)
  if (kind === 'local' || module === 'local') return 'This device'
  if (kind === 'peer' || kind === 'mesh' || module === 'mesh') return 'Connected Aurora device'
  if (kind === 'cloud' || kind === 'external') return 'Approved external service'
  return 'Aurora destination'
}

function candidateStateCopy(candidate: RoutePolicyEvaluation['route']['candidates'][number]): string {
  if (candidate.selected) return 'selected'
  if (candidate.included) return 'available'
  return routeSheetReasonCodeCopy(candidate.reason_code)
}

function routeSheetReasonCodeCopy(value: string | null | undefined): string {
  const normalized = normalizeRouteCopyToken(value)
  if (!normalized) return 'pending'
  if (normalized === 'allowed' || normalized === 'ok') return 'allowed'
  if (normalized.includes('selector')) return 'selection needed'
  if (normalized.includes('consent')) return 'consent needed'
  if (normalized.includes('privacy')) return 'privacy choice needed'
  if (normalized.includes('permission')) return 'permission needed'
  if (normalized.includes('admin')) return 'admin approval needed'
  if (normalized.includes('unavailable') || normalized.includes('offline') || normalized.includes('timeout')) return 'unavailable'
  if (normalized.includes('block') || normalized.includes('deny')) return 'blocked'
  return 'needs review'
}

function routeSheetReasonCopy(value: string | null | undefined): string {
  const state = routeSheetReasonCodeCopy(value)
  if (state === 'allowed') return 'Policy allows this route.'
  if (state === 'selection needed') return 'Choose the device or resource before continuing.'
  if (state === 'consent needed') return 'Consent is required before this request can continue.'
  if (state === 'privacy choice needed') return 'Make the required privacy choice before continuing.'
  if (state === 'permission needed') return 'A device permission is missing.'
  if (state === 'admin approval needed') return 'Administrator confirmation is required before continuing.'
  if (state === 'unavailable') return 'This destination is unavailable right now.'
  if (state === 'blocked') return 'Policy blocks this route until requirements are met.'
  if (state === 'pending') return 'Aurora has not returned policy status yet.'
  return 'Aurora reported this destination needs review.'
}

function normalizeRouteCopyToken(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
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
