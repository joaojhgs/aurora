import { ScrollArea, Badge } from '@aurora/ui-mock-reference'

const events = [
  'Peer office-relay-04 rejoined the mesh (14:02:11)',
  'Routing table recalculated after 2 hops changed (14:01:58)',
  'Attestation check failed for unregistered-node-3 (13:58:40)',
  'Diagnostics probe completed: DNS resolution nominal (13:55:12)',
  'Device "Old MacBook Air" auto-revoked after 3 failed checks (13:40:02)',
  'New pairing request from unregistered-node-3 (13:38:47)',
  'Assistant routed voice session to edge node 2 (13:31:19)',
  'Mesh topology resynced, 12 peers re-registered (13:20:03)',
]

const devices = [
  { name: 'Pixel 9 Pro', status: 'Trusted' as const },
  { name: 'Aurora Desktop — office', status: 'Trusted' as const },
  { name: 'office-relay-04', status: 'Trusted' as const },
  { name: 'unregistered-node-3', status: 'Pending' as const },
  { name: 'Old MacBook Air', status: 'Revoked' as const },
  { name: 'Aurora Tablet — lobby', status: 'Trusted' as const },
]

export function Default() {
  return (
    <div className="rounded-lg bg-background p-6 text-foreground">
      <ScrollArea className="h-48 w-80 rounded-lg border">
        <div className="flex flex-col gap-2 p-3 text-sm">
          {events.map((e) => (
            <p key={e} className="text-muted-foreground">
              {e}
            </p>
          ))}
        </div>
      </ScrollArea>
    </div>
  )
}

export function DeviceList() {
  return (
    <div className="rounded-lg bg-background p-6 text-foreground">
      <ScrollArea className="h-48 w-72 rounded-lg border">
        <div className="flex flex-col gap-1 p-2">
          {devices.map((d) => (
            <div
              key={d.name}
              className="flex items-center justify-between rounded-md px-2 py-1.5 text-sm"
            >
              <span>{d.name}</span>
              <Badge
                variant={
                  d.status === 'Trusted'
                    ? 'default'
                    : d.status === 'Pending'
                      ? 'secondary'
                      : 'destructive'
                }
              >
                {d.status}
              </Badge>
            </div>
          ))}
        </div>
      </ScrollArea>
    </div>
  )
}
