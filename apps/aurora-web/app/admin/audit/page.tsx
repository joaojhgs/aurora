import { AuroraRoutePage } from '../../page-content'

export default function Page() {
  return (
    <AuroraRoutePage
      routeId="audit"
      title="Audit Log"
      description="Audit details and export must preserve redaction, correlation IDs, peer identity, and route provenance."
    />
  )
}
