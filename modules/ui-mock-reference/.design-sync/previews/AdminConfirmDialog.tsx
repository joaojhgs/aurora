'use client'

import { useState } from 'react'
import { AdminConfirmDialog } from '@aurora/ui-mock-reference'

export function HighRisk() {
  const [open, setOpen] = useState(true)
  return (
    <div className="rounded-lg bg-background text-foreground">
      <AdminConfirmDialog
        open={open}
        onOpenChange={setOpen}
        action={{
          title: 'Stop TTS',
          description: 'This will stop the TTS service. Dependent assistant and admin features may be briefly unavailable.',
          methodId: 'Supervisor.StopService',
          severity: 'critical',
          affected: [
            { type: 'service', label: 'TTS' },
            { type: 'capability', label: 'synthesize' },
            { type: 'capability', label: 'playback' },
          ],
          requireReason: true,
          requireTypedPhrase: 'TTS',
        }}
        onConfirm={() => {}}
      />
    </div>
  )
}

export function LowRisk() {
  const [open, setOpen] = useState(true)
  return (
    <div className="rounded-lg bg-background text-foreground">
      <AdminConfirmDialog
        open={open}
        onOpenChange={setOpen}
        action={{
          title: 'Approve cabin-node',
          description: 'This peer will be able to receive route-previewed assistant work according to its scoped permissions.',
          methodId: 'Auth.MeshApprovePeer',
          severity: 'medium',
          affected: [
            { type: 'peer', label: 'cabin-node' },
            { type: 'route-policy', label: 'mesh.route.preview' },
          ],
          diff: [
            { key: 'peer.status', before: 'pending', after: 'approved' },
            { key: 'peer.permissions', before: '[]', after: '[Orchestrator.use]' },
          ],
        }}
        onConfirm={() => {}}
      />
    </div>
  )
}

export function PermissionGrant() {
  const [open, setOpen] = useState(true)
  return (
    <div className="rounded-lg bg-background text-foreground">
      <AdminConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Grant permission"
        description='This will grant "Manage RBAC, devices, peers and audit" for the Admin role.'
        impact="medium"
        diff={[{ field: 'role-admin.Auth.manage', before: 'denied', after: 'granted' }]}
        confirmLabel="Grant"
        onConfirm={() => {}}
      />
    </div>
  )
}
