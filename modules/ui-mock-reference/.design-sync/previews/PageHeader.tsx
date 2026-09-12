import { PageHeader, Button } from '@aurora/ui-mock-reference'
import { ShieldCheck, Settings, Download } from 'lucide-react'

export function Default() {
  return (
    <div className="w-[640px] rounded-lg border bg-background text-foreground">
      <PageHeader
        title="Devices"
        description="Trusted devices, pending pairings, platform capabilities and remote/local sources."
      />
    </div>
  )
}

export function WithIcon() {
  return (
    <div className="w-[640px] rounded-lg border bg-background text-foreground">
      <PageHeader
        title="Roles & permissions"
        description="Define what each role can do across the assistant and admin surfaces. Changes are audited and require confirmation."
        icon={ShieldCheck}
      />
    </div>
  )
}

export function WithActions() {
  return (
    <div className="w-[640px] rounded-lg border bg-background text-foreground">
      <PageHeader
        title="Diagnostics"
        description="Service probes, traces, redaction preview and export workflow for support/debugging."
        actions={
          <Button>
            <Download className="size-4" />
            Export bundle
          </Button>
        }
      />
    </div>
  )
}

export function IconAndActions() {
  return (
    <div className="w-[640px] rounded-lg border bg-background text-foreground">
      <PageHeader
        title="Configuration"
        description="Server and client settings. Edits are staged into a reviewable diff and applied only after confirmation."
        icon={Settings}
        actions={
          <Button size="sm">
            <Settings className="size-4" />
            Review (3)
          </Button>
        }
      />
    </div>
  )
}
