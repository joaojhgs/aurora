import { AuroraRoutePage } from '../../page-content'

export default function Page() {
  return (
    <AuroraRoutePage
      routeId="native"
      title="Native Capabilities"
      description="Tauri and mobile native capability claims must come from the SDK native manifest; browser-only state cannot prove native behavior."
    />
  )
}
