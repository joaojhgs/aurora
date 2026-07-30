'use client'

import { useEffect, useMemo, useState } from 'react'
import { Clock3, Laptop, ShieldCheck } from 'lucide-react'

import { Badge } from '#components/ui/badge'
import { Button } from '#components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '#components/ui/card'
import { Checkbox } from '#components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '#components/ui/dialog'
import { Alert, AlertDescription, AlertTitle } from '#components/ui/alert'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '#components/ui/empty'
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FieldTitle,
} from '#components/ui/field'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '#components/ui/select'
import { Skeleton } from '#components/ui/skeleton'
import { Switch } from '#components/ui/switch'
import { findForbiddenProductionCopyTerms } from './product-copy-forbidden-terms'

export interface LocalDeviceFeature {
  readonly id: string
  readonly label: string
  readonly description: string
  readonly enabled: boolean
  readonly available: boolean
  readonly requiresAuroraOpen: boolean
  readonly requiresLocalConfirmation: boolean
  readonly permissionNeeded?: boolean | undefined
}

export interface LocalFeaturePeerSharing {
  readonly peerId: string
  readonly peerLabel: string
  readonly featureIds: readonly string[]
  readonly expiresAtMs: number | null
}

export interface LocalFeatureSharingSnapshot {
  readonly features: readonly LocalDeviceFeature[]
  readonly approvedDevices: readonly LocalFeaturePeerSharing[]
}

export interface LocalFeatureSharingPort {
  load(): Promise<LocalFeatureSharingSnapshot>
  subscribe?(listener: (snapshot: LocalFeatureSharingSnapshot) => void): () => void
  setFeatureEnabled(featureId: string, enabled: boolean): Promise<void>
  replacePeerSharing(peerId: string, featureIds: readonly string[], expiresAtMs: number | null): Promise<void>
  revokePeerSharing(peerId: string): Promise<void>
}

export interface LocalFeatureSharingPanelProps {
  readonly port: LocalFeatureSharingPort
  readonly initialSnapshot?: LocalFeatureSharingSnapshot | null
}

type ExpiryChoice = 'keep-current' | 'never' | 'one-day' | 'seven-days' | 'thirty-days'

const EXPIRY_MS: Readonly<Record<Exclude<ExpiryChoice, 'keep-current' | 'never'>, number>> = Object.freeze({
  'one-day': 24 * 60 * 60 * 1000,
  'seven-days': 7 * 24 * 60 * 60 * 1000,
  'thirty-days': 30 * 24 * 60 * 60 * 1000,
})

export function LocalFeatureSharingPanel({ port, initialSnapshot = null }: LocalFeatureSharingPanelProps) {
  const [snapshot, setSnapshot] = useState<LocalFeatureSharingSnapshot | null>(initialSnapshot)
  const [notice, setNotice] = useState<'load-failed' | 'save-failed' | null>(null)
  const [pendingAction, setPendingAction] = useState<string | null>(null)
  const [selectedPeerId, setSelectedPeerId] = useState<string | null>(null)
  const [draftFeatureIds, setDraftFeatureIds] = useState<readonly string[]>([])
  const [expiryChoice, setExpiryChoice] = useState<ExpiryChoice>('never')

  useEffect(() => {
    let active = true
    const apply = (next: LocalFeatureSharingSnapshot) => {
      if (!active) return
      setSnapshot(next)
      setNotice(null)
    }
    const unsubscribe = port.subscribe?.(apply)
    void port.load().then(apply, () => {
      if (active) setNotice('load-failed')
    })
    return () => {
      active = false
      unsubscribe?.()
    }
  }, [port])

  const availableFeatures = useMemo(
    () => snapshot?.features.filter((feature) => feature.available) ?? [],
    [snapshot],
  )
  const enabledFeatureIds = useMemo(
    () => new Set(availableFeatures.filter((feature) => feature.enabled).map((feature) => feature.id)),
    [availableFeatures],
  )
  const selectedPeer = snapshot?.approvedDevices.find((peer) => peer.peerId === selectedPeerId) ?? null
  const selectedDraftFeatureIds = draftFeatureIds.filter((featureId) => enabledFeatureIds.has(featureId))

  if (snapshot && availableFeatures.length === 0) return null

  const refresh = async () => {
    setSnapshot(await port.load())
    setNotice(null)
  }

  const run = async (actionId: string, operation: () => Promise<void>): Promise<boolean> => {
    setPendingAction(actionId)
    setNotice(null)
    try {
      await operation()
      await refresh()
      return true
    } catch {
      setNotice('save-failed')
      return false
    } finally {
      setPendingAction(null)
    }
  }

  const openPeer = (peer: LocalFeaturePeerSharing) => {
    setSelectedPeerId(peer.peerId)
    setDraftFeatureIds(peer.featureIds.filter((featureId) => enabledFeatureIds.has(featureId)))
    setExpiryChoice(peer.expiresAtMs === null ? 'never' : 'keep-current')
  }

  const closePeer = () => {
    if (pendingAction) return
    setSelectedPeerId(null)
    setDraftFeatureIds([])
    setExpiryChoice('never')
  }

  const expiryAt = (): number | null => {
    if (expiryChoice === 'keep-current') return selectedPeer?.expiresAtMs ?? null
    if (expiryChoice === 'never') return null
    return Date.now() + EXPIRY_MS[expiryChoice]
  }

  return (
    <>
      <Card aria-label="Features on this device">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Laptop /> Features on this device
          </CardTitle>
          <CardDescription>
            Turn on only the features you want Aurora to make available. Sharing with each approved device is separate.
          </CardDescription>
          <CardAction>
            <Badge variant="outline">
              {availableFeatures.filter((feature) => feature.enabled).length} on
            </Badge>
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {notice === 'load-failed' ? (
            <Alert variant="destructive">
              <AlertTitle>Sharing choices are unavailable</AlertTitle>
              <AlertDescription>Aurora could not load sharing choices. Try again.</AlertDescription>
            </Alert>
          ) : null}
          {notice === 'save-failed' ? (
            <Alert variant="destructive">
              <AlertTitle>Change not saved</AlertTitle>
              <AlertDescription>Aurora could not save this change. Try again.</AlertDescription>
            </Alert>
          ) : null}
          {!snapshot ? <Skeleton aria-label="Loading features" className="h-24 w-full" /> : null}
          {snapshot ? (
            <FieldGroup className="grid gap-3 md:grid-cols-2">
              {availableFeatures.map((feature) => {
                const label = safeProductText(feature.label, 'Device feature')
                const description = safeProductText(feature.description, 'Available from this device when you choose to turn it on.')
                const actionId = `feature:${feature.id}`
                return (
                  <Field
                    key={feature.id}
                    orientation="horizontal"
                    data-disabled={pendingAction !== null}
                    className="min-w-0 items-start rounded-xl border p-3"
                  >
                    <FieldContent>
                      <FieldTitle>{label}</FieldTitle>
                      <FieldDescription>{description}</FieldDescription>
                      <div className="flex flex-wrap gap-2 pt-2">
                        <Badge variant={feature.enabled ? 'secondary' : 'outline'}>
                          {feature.enabled ? 'On' : 'Off'}
                        </Badge>
                        {feature.requiresAuroraOpen ? <Badge variant="outline">Aurora must stay open</Badge> : null}
                        {feature.permissionNeeded ? <Badge variant="outline">Permission needed</Badge> : null}
                        {feature.requiresLocalConfirmation ? <Badge variant="outline">Asks before sensitive actions</Badge> : null}
                      </div>
                    </FieldContent>
                    <Switch
                      aria-label={`Turn ${label} ${feature.enabled ? 'off' : 'on'}`}
                      checked={feature.enabled}
                      disabled={pendingAction !== null}
                      onCheckedChange={(enabled) => {
                        void run(actionId, () => port.setFeatureEnabled(feature.id, Boolean(enabled)))
                      }}
                    />
                  </Field>
                )
              })}
            </FieldGroup>
          ) : null}

          {snapshot ? (
            <section className="flex flex-col gap-3" aria-labelledby="approved-device-sharing-title">
              <div>
                <h3 id="approved-device-sharing-title" className="font-medium">Approved devices</h3>
                <p className="text-sm text-muted-foreground">Choose what each device may use and when sharing ends.</p>
              </div>
              {snapshot.approvedDevices.length === 0 ? (
                <Empty className="border">
                  <EmptyHeader>
                    <EmptyTitle>No approved devices yet</EmptyTitle>
                    <EmptyDescription>Approve a device before choosing features for it.</EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : (
                <div className="grid gap-2">
                  {snapshot.approvedDevices.map((peer) => {
                    const activeFeatureCount = peer.featureIds.filter((featureId) => enabledFeatureIds.has(featureId)).length
                    const label = safeProductText(peer.peerLabel, 'Approved device')
                    return (
                      <div key={peer.peerId} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
                        <div className="min-w-0">
                          <p className="truncate font-medium">{label}</p>
                          <p className="text-sm text-muted-foreground">
                            {activeFeatureCount === 0
                              ? 'No features shared'
                              : `${activeFeatureCount} ${activeFeatureCount === 1 ? 'feature' : 'features'} shared`}
                            {peer.expiresAtMs === null || activeFeatureCount === 0
                              ? ''
                              : ` · Ends ${formatExpiry(peer.expiresAtMs)}`}
                          </p>
                        </div>
                        <Button type="button" size="sm" variant="outline" disabled={pendingAction !== null} onClick={() => openPeer(peer)}>
                          Choose features
                        </Button>
                      </div>
                    )
                  })}
                </div>
              )}
            </section>
          ) : null}
        </CardContent>
      </Card>

      <Dialog open={selectedPeer !== null} onOpenChange={(open) => !open && closePeer()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Choose features for {safeProductText(selectedPeer?.peerLabel, 'this device')}</DialogTitle>
            <DialogDescription>
              Features start off for every device. You can stop sharing at any time.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            {availableFeatures.filter((feature) => feature.enabled).length === 0 ? (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>No features are on</EmptyTitle>
                  <EmptyDescription>Turn on a feature before sharing it.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <FieldSet>
                <FieldLegend variant="label">Shared features</FieldLegend>
                <FieldGroup data-slot="checkbox-group" className="gap-2">
                  {availableFeatures.filter((feature) => feature.enabled).map((feature) => {
                    const label = safeProductText(feature.label, 'Device feature')
                    const checkboxId = `local-feature-sharing-${feature.id}`
                    return (
                      <FieldLabel key={feature.id} htmlFor={checkboxId}>
                        <Field orientation="horizontal" data-disabled={pendingAction !== null}>
                          <Checkbox
                            id={checkboxId}
                            checked={selectedDraftFeatureIds.includes(feature.id)}
                            disabled={pendingAction !== null}
                            onCheckedChange={() => setDraftFeatureIds(toggleValue(selectedDraftFeatureIds, feature.id))}
                          />
                          <FieldContent>
                            <FieldTitle>{label}</FieldTitle>
                            <FieldDescription>
                              {safeProductText(feature.description, 'Available from this device when you choose to turn it on.')}
                            </FieldDescription>
                          </FieldContent>
                        </Field>
                      </FieldLabel>
                    )
                  })}
                </FieldGroup>
              </FieldSet>
            )}
            <Field data-disabled={pendingAction !== null}>
              <FieldLabel htmlFor="local-feature-sharing-expiry">
                <Clock3 aria-hidden /> Sharing duration
              </FieldLabel>
              <Select value={expiryChoice} onValueChange={(value) => setExpiryChoice(value as ExpiryChoice)} disabled={pendingAction !== null}>
                <SelectTrigger id="local-feature-sharing-expiry" aria-label="Sharing duration">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {selectedPeer?.expiresAtMs !== null ? <SelectItem value="keep-current">Keep current end date</SelectItem> : null}
                    <SelectItem value="never">Until you turn it off</SelectItem>
                    <SelectItem value="one-day">For 1 day</SelectItem>
                    <SelectItem value="seven-days">For 7 days</SelectItem>
                    <SelectItem value="thirty-days">For 30 days</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            <Alert>
              <ShieldCheck aria-hidden />
              <AlertTitle>Confirmation stays on this device</AlertTitle>
              <AlertDescription>Sensitive actions still ask on this device before they continue.</AlertDescription>
            </Alert>
          </div>
          <DialogFooter className="sm:justify-between">
            <Button
              type="button"
              variant="destructive"
              disabled={pendingAction !== null || (selectedPeer?.featureIds.length ?? 0) === 0}
              onClick={() => {
                if (!selectedPeer) return
                void run(`revoke:${selectedPeer.peerId}`, () => port.revokePeerSharing(selectedPeer.peerId))
                  .then((saved) => {
                    if (saved) closePeer()
                  })
              }}
            >
              Stop sharing
            </Button>
            <div className="flex flex-col-reverse gap-2 sm:flex-row">
              <Button type="button" variant="outline" disabled={pendingAction !== null} onClick={closePeer}>Cancel</Button>
              <Button
                type="button"
                disabled={pendingAction !== null || !selectedPeer || selectedDraftFeatureIds.length === 0}
                onClick={() => {
                  if (!selectedPeer) return
                  void run(
                    `save:${selectedPeer.peerId}`,
                    () => port.replacePeerSharing(selectedPeer.peerId, selectedDraftFeatureIds, expiryAt()),
                  ).then((saved) => {
                    if (saved) closePeer()
                  })
                }}
              >
                Save sharing
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

function toggleValue(values: readonly string[], value: string): readonly string[] {
  return values.includes(value)
    ? values.filter((candidate) => candidate !== value)
    : [...values, value].sort()
}

function safeProductText(value: string | null | undefined, fallback: string): string {
  const normalized = value?.trim().replace(/\s+/gu, ' ') ?? ''
  if (normalized.length === 0 || normalized.length > 160) return fallback
  if (findForbiddenProductionCopyTerms(normalized).length > 0) return fallback
  if (/[\[\]{}<>]|[a-z]+:\/\/|[A-Za-z]+\.[A-Za-z]+/u.test(normalized)) return fallback
  return normalized
}

function formatExpiry(expiresAtMs: number): string {
  if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= 0) return 'soon'
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(expiresAtMs))
  } catch {
    return 'soon'
  }
}
