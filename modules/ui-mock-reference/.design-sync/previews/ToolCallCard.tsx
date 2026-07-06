import { ToolCallCard } from '@aurora/ui-mock-reference'

export function Pending() {
  return (
    <div className="rounded-lg bg-background p-6 text-foreground min-w-[420px]">
      <ToolCallCard
        call={{
          name: 'diagnostics.serviceHealth',
          target: 'Gateway',
          inputs: { scope: 'all-services', includeLogs: 'false' },
          risk: 'read-only',
          dataLeavesDevice: false,
          status: 'pending',
        }}
        onDecision={() => {}}
      />
    </div>
  )
}

export function Approved() {
  return (
    <div className="rounded-lg bg-background p-6 text-foreground min-w-[420px]">
      <ToolCallCard
        call={{
          name: 'web.search',
          target: 'external.search-provider',
          inputs: { query: 'aurora 0.9 release notes' },
          risk: 'external',
          dataLeavesDevice: true,
          status: 'approved',
        }}
        onDecision={() => {}}
      />
    </div>
  )
}
