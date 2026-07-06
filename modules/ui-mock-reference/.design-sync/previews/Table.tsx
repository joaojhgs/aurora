import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
  TableCaption,
  Badge,
} from '@aurora/ui-mock-reference'

const devices = [
  { name: 'Pixel 9 Pro', type: 'Mobile', lastSeen: '2 minutes ago', status: 'Trusted' },
  { name: 'Aurora Desktop — office', type: 'Desktop', lastSeen: '14 minutes ago', status: 'Trusted' },
  { name: 'Unregistered node', type: 'Mesh peer', lastSeen: '1 hour ago', status: 'Pending' },
  { name: 'Old MacBook Air', type: 'Desktop', lastSeen: '30 days ago', status: 'Revoked' },
]

export function Default() {
  return (
    <div className="rounded-lg bg-background p-6 text-foreground">
      <Table>
        <TableCaption>Paired and trusted devices for this identity.</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead>Device</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Last seen</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {devices.map((d) => (
            <TableRow key={d.name}>
              <TableCell className="font-medium">{d.name}</TableCell>
              <TableCell>{d.type}</TableCell>
              <TableCell>{d.lastSeen}</TableCell>
              <TableCell>
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
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
