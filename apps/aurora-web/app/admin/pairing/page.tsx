import { AuroraRoutePage } from '../../page-content'

export default function Page() {
  return (
    <AuroraRoutePage
      routeId="pairing"
      title="Pairing"
      description="Pairing must show bilateral pending, approved, and denied state from Auth; presence alone is not treated as trust."
    />
  )
}
