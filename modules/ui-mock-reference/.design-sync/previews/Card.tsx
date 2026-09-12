import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardAction,
  CardContent,
  CardFooter,
  Button,
  Badge,
} from '@aurora/ui-mock-reference'

export function Default() {
  return (
    <div className="rounded-lg bg-background p-6 text-foreground">
      <Card className="w-80">
        <CardHeader>
          <CardTitle>Mesh peer trust</CardTitle>
          <CardDescription>3 peers awaiting approval</CardDescription>
          <CardAction>
            <Badge>Pending</Badge>
          </CardAction>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Review each peer&apos;s identity fingerprint before granting mesh
            routing access.
          </p>
        </CardContent>
        <CardFooter>
          <Button variant="outline" size="sm">
            Dismiss
          </Button>
          <Button size="sm">Review queue</Button>
        </CardFooter>
      </Card>
    </div>
  )
}

export function Compact() {
  return (
    <div className="rounded-lg bg-background p-6 text-foreground">
      <Card size="sm" className="w-72">
        <CardHeader>
          <CardTitle>Diagnostics export</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Redacted export ready for download.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
