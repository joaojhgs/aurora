import {
  Sheet,
  SheetTrigger,
  SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
  Button,
} from '@aurora/ui-mock-reference'

export function Default() {
  return (
    <div className="rounded-lg bg-background p-6 text-foreground">
      <Sheet defaultOpen>
        <SheetTrigger render={<Button variant="outline">Inspect peer</Button>} />
        <SheetContent side="right">
          <SheetHeader>
            <SheetTitle>Mesh peer — office-relay-04</SheetTitle>
            <SheetDescription>
              Identity fingerprint, routing hops, and trust history for this
              peer.
            </SheetDescription>
          </SheetHeader>
          <div className="flex flex-col gap-3 px-4 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Fingerprint</span>
              <span className="font-mono text-xs">4F:2A:9C:11:7E:B0</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Routing hops</span>
              <span>3</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Last handshake</span>
              <span>2 minutes ago</span>
            </div>
          </div>
          <SheetFooter>
            <Button variant="outline">Untrust peer</Button>
            <Button>Approve routing</Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </div>
  )
}
