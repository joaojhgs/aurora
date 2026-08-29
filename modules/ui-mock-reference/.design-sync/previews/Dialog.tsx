import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
  Button,
} from '@aurora/ui-mock-reference'

export function Default() {
  return (
    <div className="rounded-lg bg-background p-6 text-foreground">
      <Dialog defaultOpen>
        <DialogTrigger render={<Button variant="outline">Revoke device</Button>} />
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revoke paired device</DialogTitle>
            <DialogDescription>
              This immediately ends the device&apos;s session and removes it
              from the trusted devices list.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter showCloseButton>
            <Button variant="destructive">Revoke device</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
