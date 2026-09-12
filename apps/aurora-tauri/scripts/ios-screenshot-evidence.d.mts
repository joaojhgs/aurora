export type IosScreenshotEvidence = {
  schema: 'aurora.ios-screenshot-evidence.v1'
  status: 'passed' | 'failed'
  width: number
  height: number
  colorType: number
  crop: Record<string, number>
  thresholds: Record<string, number>
  sampleStep: number
  sampledPixelCount: number
  opaqueRatio: number
  minimumLuminance: number
  maximumLuminance: number
  luminanceRange: number
  meanLuminance: number
  luminanceStandardDeviation: number
  dominantColor: {
    r: number
    g: number
    b: number
    sampleRatio: number
  }
  contrastPixelRatio: number
  distinctColorBucketCount: number
  edgeContrastRatio: number
  failures: string[]
  secretsRedacted: true
  captureAttempts?: number
}

export type IosScreenshotEvidenceOptions = {
  crop?: Partial<{
    topRatio: number
    rightRatio: number
    bottomRatio: number
    leftRatio: number
  }>
  thresholds?: Record<string, number>
}

export function analyzeIosScreenshot(
  path: string,
  options?: IosScreenshotEvidenceOptions,
): IosScreenshotEvidence

export function assertIosScreenshotVisible(
  evidence: IosScreenshotEvidence,
  label?: string,
): void
