export type IosCiEvidenceSummary = {
  schema: 'aurora.ios-ci-evidence-summary.v1'
  status: 'passed' | 'failed'
  generatedAt: string
  requiredSurfaces: string[]
  checkCount: number
  checks: Array<{ id: string; status: 'passed' | 'failed' }>
  failures: string[]
  secretsRedacted: true
}

export function validateIosCiEvidence(options?: {
  reportRoot?: string
  summaryPath?: string
}): {
  summary: IosCiEvidenceSummary
  summaryPath: string
}
