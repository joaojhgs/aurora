import {
  Alert,
  AlertTitle,
  AlertDescription,
  AlertAction,
  Button,
} from '@aurora/ui-mock-reference'
import { RadioTower, ShieldAlert, X } from 'lucide-react'

export function Default() {
  return (
    <div className="rounded-lg bg-background p-6 text-foreground">
      <Alert className="max-w-md">
        <RadioTower />
        <AlertTitle>Mesh topology resynced</AlertTitle>
        <AlertDescription>
          12 peers re-registered after the routing table refresh completed.
        </AlertDescription>
      </Alert>
    </div>
  )
}

export function Destructive() {
  return (
    <div className="rounded-lg bg-background p-6 text-foreground">
      <Alert variant="destructive" className="max-w-md">
        <ShieldAlert />
        <AlertTitle>Device trust revoked</AlertTitle>
        <AlertDescription>
          &quot;Old MacBook Air&quot; failed its last three attestation
          checks and was removed from the trusted devices list.
        </AlertDescription>
        <AlertAction>
          <Button variant="ghost" size="icon-sm" aria-label="Dismiss">
            <X />
          </Button>
        </AlertAction>
      </Alert>
    </div>
  )
}
