import { BackendCoverageBadge } from '@aurora/ui-mock-reference'

export function Default() {
  return (
    <div className="rounded-lg bg-background p-6 text-foreground">
      <BackendCoverageBadge coverage="implemented" />
    </div>
  )
}

export function AllCoverage() {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg bg-background p-6 text-foreground">
      <BackendCoverageBadge coverage="implemented" />
      <BackendCoverageBadge coverage="partial" />
      <BackendCoverageBadge coverage="internal_only" />
      <BackendCoverageBadge coverage="missing_contract" />
      <BackendCoverageBadge coverage="planned" />
      <BackendCoverageBadge coverage="mock_only" />
    </div>
  )
}
