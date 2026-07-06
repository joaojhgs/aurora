import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
  Button,
} from '@aurora/ui-mock-reference'
import { Info } from 'lucide-react'

export function Default() {
  return (
    <div className="rounded-lg bg-background p-10 text-foreground">
      <TooltipProvider>
        <Tooltip defaultOpen>
          <TooltipTrigger
            render={
              <Button variant="outline" size="icon-sm" aria-label="Routing info">
                <Info />
              </Button>
            }
          />
          <TooltipContent>
            Routing priority affects which peer chain the assistant uses.
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  )
}

export function OnText() {
  return (
    <div className="rounded-lg bg-background p-10 text-foreground">
      <TooltipProvider>
        <Tooltip defaultOpen>
          <TooltipTrigger render={<Button variant="ghost" size="sm">Attestation status</Button>} />
          <TooltipContent side="bottom">
            Last checked 2 minutes ago — all probes passed.
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  )
}
