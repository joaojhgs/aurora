import { DiffViewer } from '@aurora/ui-mock-reference'

export function Default() {
  return (
    <div className="w-[420px] rounded-lg bg-background p-6 text-foreground">
      <DiffViewer
        rows={[
          { key: 'gateway.cors.origins', before: 'https://app.aurora.local', after: 'https://app.aurora.example' },
          { key: 'auth.session.ttl', before: '24h', after: '24h' },
          { key: 'privacy.allow_remote_fallback', before: 'false', after: 'true' },
        ]}
      />
    </div>
  )
}

export function PeerApproval() {
  return (
    <div className="w-[420px] rounded-lg bg-background p-6 text-foreground">
      <DiffViewer
        rows={[
          { key: 'peer.status', before: 'pending', after: 'approved' },
          { key: 'peer.permissions', before: '[]', after: '[Orchestrator.use]' },
        ]}
      />
    </div>
  )
}
