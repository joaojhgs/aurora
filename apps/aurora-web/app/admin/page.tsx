import { AuroraRoutePage } from '../page-content'

export default function Page() {
  return (
    <AuroraRoutePage
      routeId="admin"
      title="Admin Overview"
      description="Operator status is read-only in this shell slice; manage actions require AdminAction and downstream admin task wiring."
    />
  )
}
