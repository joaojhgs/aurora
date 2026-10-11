import type { RefObject } from 'react'
import { Button, Card } from './primitives'
import { EmptyState, RouteStateNotice } from './state-surface'
import { Badge } from '#components/ui/badge'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '#components/ui/alert-dialog'

export type ManagedVoiceActionKind = 'delete' | 'remove'

export interface ManagedVoiceRow {
  voiceId: string
  label: string
  detail: string
  ready: boolean
  installable: boolean
  canDelete: boolean
  canExport: boolean
  canRemove: boolean
  canSetDefault: boolean
  badge: string
}

export interface ManagedVoiceConfirmation<TProfile extends ManagedVoiceRow = ManagedVoiceRow> {
  kind: ManagedVoiceActionKind
  profile: TProfile
}

export interface ManagedVoicesSectionProps<TProfile extends ManagedVoiceRow> {
  adminReason: string
  adminReasonValueLength: number
  adminReviewConfirmed: boolean
  adminActionReady: boolean
  actionPending: boolean
  managementState: 'locked' | 'loading' | 'ready' | 'limited'
  managedProfiles: readonly TProfile[]
  canShowInstall: boolean
  canTransferCloneVoices: boolean
  installingVoiceId: string | null
  pendingActionKey: string | null
  confirmAction: ManagedVoiceConfirmation<TProfile> | null
  importFileInputRef: RefObject<HTMLInputElement | null>
  onAdminReasonChange: (value: string) => void
  onAdminReviewConfirmedChange: (confirmed: boolean) => void
  onLoadManagedProfiles: () => void
  onSetDefaultProfile: (profile: TProfile) => void
  onInstallProfile: (profile: TProfile) => void
  onRequestConfirmation: (action: ManagedVoiceConfirmation<TProfile> | null) => void
  onExportCloneVoice: (profile: TProfile) => void
  onImportCloneVoice: () => void
  onImportFileChange: (file: File | null) => void
  onRunConfirmedAction: (action: ManagedVoiceConfirmation<TProfile>) => void
}

export function ManagedVoicesSection<TProfile extends ManagedVoiceRow>({
  adminReason,
  adminReasonValueLength,
  adminReviewConfirmed,
  adminActionReady,
  actionPending,
  managementState,
  managedProfiles,
  canShowInstall,
  canTransferCloneVoices,
  installingVoiceId,
  pendingActionKey,
  confirmAction,
  importFileInputRef,
  onAdminReasonChange,
  onAdminReviewConfirmedChange,
  onLoadManagedProfiles,
  onSetDefaultProfile,
  onInstallProfile,
  onRequestConfirmation,
  onExportCloneVoice,
  onImportCloneVoice,
  onImportFileChange,
  onRunConfirmedAction,
}: ManagedVoicesSectionProps<TProfile>) {
  return (
    <>
      <Card title="Voices available to Aurora" description="Voices Aurora can use or add for spoken replies.">
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-2 rounded-lg border border-border/70 bg-muted/20 p-3">
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium">Reason</span>
              <input
                className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                value={adminReason}
                onChange={(event) => onAdminReasonChange(event.currentTarget.value)}
                aria-label="Voice change reason"
                disabled={actionPending}
              />
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={adminReviewConfirmed}
                onChange={(event) => onAdminReviewConfirmedChange(event.currentTarget.checked)}
                disabled={actionPending || adminReasonValueLength === 0}
              />
              <span>I confirm these voice changes are allowed.</span>
            </label>
          </div>
          {managementState === 'locked' ? (
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm text-muted-foreground">Show available voices before adding or changing spoken reply voices.</p>
              <Button
                variant="outline"
                className="h-8 px-3 text-xs"
                onClick={onLoadManagedProfiles}
                disabled={actionPending || !adminActionReady}
              >
                Show available voices
              </Button>
            </div>
          ) : null}
          {managementState === 'loading' ? <RouteStateNotice state="loading" title="Loading available voices" message="Loading voices that can be added to Aurora." /> : null}
          {managementState === 'limited' ? (
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <RouteStateNotice state="error" title="Available voices unavailable" message="Available voices could not be loaded. Review access and try again." />
              <Button
                variant="outline"
                className="h-8 px-3 text-xs"
                onClick={onLoadManagedProfiles}
                disabled={actionPending || !adminActionReady}
              >
                Try again
              </Button>
            </div>
          ) : null}
          {managedProfiles.map((profile) => (
            <div key={profile.voiceId} className="flex flex-col gap-2 border-b border-border/60 pb-3 last:border-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="text-sm font-medium">{profile.label}</p>
                <p className="text-xs text-muted-foreground">{profile.detail}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={profile.ready ? 'default' : 'secondary'}>{profile.badge}</Badge>
                {canShowInstall && profile.canSetDefault ? (
                  <Button
                    variant="outline"
                    className="h-8 px-3 text-xs"
                    onClick={() => onSetDefaultProfile(profile)}
                    disabled={actionPending || !adminActionReady}
                  >
                    {pendingActionKey === managedVoiceActionKey('default', profile.voiceId) ? 'Updating' : 'Use by default'}
                  </Button>
                ) : null}
                {canShowInstall && profile.installable ? (
                  <Button
                    variant="outline"
                    className="h-8 px-3 text-xs"
                    onClick={() => onInstallProfile(profile)}
                    disabled={actionPending || !adminActionReady}
                  >
                    {installingVoiceId === profile.voiceId ? 'Adding' : 'Add voice'}
                  </Button>
                ) : null}
                {canShowInstall && profile.canRemove ? (
                  <Button
                    variant="outline"
                    className="h-8 px-3 text-xs"
                    onClick={() => onRequestConfirmation({ kind: 'remove', profile })}
                    disabled={actionPending || !adminActionReady}
                  >
                    Remove
                  </Button>
                ) : null}
                {canShowInstall && profile.canDelete ? (
                  <Button
                    variant="danger"
                    className="h-8 px-3 text-xs"
                    onClick={() => onRequestConfirmation({ kind: 'delete', profile })}
                    disabled={actionPending || !adminActionReady}
                  >
                    Delete
                  </Button>
                ) : null}
                {canShowInstall && canTransferCloneVoices && profile.canExport ? (
                  <Button
                    variant="outline"
                    className="h-8 px-3 text-xs"
                    onClick={() => onExportCloneVoice(profile)}
                    disabled={actionPending || !adminActionReady}
                  >
                    {pendingActionKey === managedVoiceActionKey('export', profile.voiceId) ? 'Preparing' : 'Download'}
                  </Button>
                ) : null}
              </div>
            </div>
          ))}
          {managedProfiles.length === 0 && managementState === 'ready' ? (
            <EmptyState title="No additional voices" message="No additional voices are available yet." />
          ) : null}
          {managementState === 'ready' && canTransferCloneVoices ? (
            <form
              className="flex flex-col gap-2 rounded-md border border-current p-3"
              onSubmit={(event) => {
                event.preventDefault()
                onImportCloneVoice()
              }}
            >
              <div>
                <p className="text-sm font-medium">Add from file</p>
                <p className="text-xs text-muted-foreground">Choose an Aurora voice file from a device you trust.</p>
              </div>
              <input
                ref={importFileInputRef}
                type="file"
                accept="application/json,.json"
                aria-label="Voice file"
                onChange={(event) => onImportFileChange(event.currentTarget.files?.[0] ?? null)}
                disabled={actionPending || !adminActionReady}
              />
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  className="h-8 px-3 text-xs"
                  onClick={onImportCloneVoice}
                  disabled={actionPending || !adminActionReady}
                >
                  {pendingActionKey?.startsWith('import:') ? 'Adding' : 'Add voice file'}
                </Button>
              </div>
            </form>
          ) : null}
        </div>
      </Card>

      <AlertDialog open={confirmAction !== null} onOpenChange={(open) => {
        if (!open && !actionPending) onRequestConfirmation(null)
      }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmAction?.kind === 'delete' ? 'Delete voice?' : 'Remove voice?'}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmAction?.kind === 'delete'
                ? 'This voice will no longer be available in Aurora.'
                : 'Aurora will stop using this added voice until it is added again.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="focus-visible:ring-0" disabled={actionPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="focus-visible:ring-0"
              variant={confirmAction?.kind === 'delete' ? 'destructive' : 'default'}
              disabled={actionPending || confirmAction === null || !adminActionReady}
              onClick={() => {
                if (confirmAction) onRunConfirmedAction(confirmAction)
              }}
            >
              {pendingActionKey && confirmAction
                ? (confirmAction.kind === 'delete' ? 'Deleting' : 'Removing')
                : (confirmAction?.kind === 'delete' ? 'Delete voice' : 'Remove voice')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

function managedVoiceActionKey(kind: 'default' | 'export', voiceId: string): string {
  return `${kind}:${voiceId}`
}
