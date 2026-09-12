import { useState } from 'react'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  Button,
} from '@aurora/ui-mock-reference'

export function Default() {
  const [autoApprove, setAutoApprove] = useState(true)
  const [priority, setPriority] = useState('standard')
  return (
    <div className="rounded-lg bg-background p-6 text-foreground">
      <DropdownMenu defaultOpen>
        <DropdownMenuTrigger render={<Button variant="outline">Device actions</Button>} />
        <DropdownMenuContent>
          <DropdownMenuGroup>
            <DropdownMenuLabel>Pixel 9 Pro</DropdownMenuLabel>
            <DropdownMenuItem>
              Rename device
              <DropdownMenuShortcut>⌘R</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem>View attestation log</DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuCheckboxItem checked={autoApprove} onCheckedChange={setAutoApprove}>
              Auto-approve future requests
            </DropdownMenuCheckboxItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuRadioGroup value={priority} onValueChange={setPriority}>
            <DropdownMenuLabel>Routing priority</DropdownMenuLabel>
            <DropdownMenuRadioItem value="standard">Standard</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="low-latency">Low latency</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive">Revoke device</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
