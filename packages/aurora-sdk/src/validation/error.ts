export type AuroraValidationBoundaryKind =
  | 'http-request'
  | 'http-response'
  | 'webrtc-frame'
  | 'native-bridge'
  | 'local-record'
  | 'import-export'
  | 'runtime-profile'
  | 'unknown'

export interface AuroraValidationIssue {
  path: string
  code: string
  message: string
}

export interface AuroraValidationErrorOptions {
  schemaId: string
  boundary: AuroraValidationBoundaryKind
  issues: AuroraValidationIssue[]
  cause?: unknown
}

export class AuroraValidationError extends Error {
  readonly name = 'AuroraValidationError'
  readonly code = 'validation_failed'
  readonly schemaId: string
  readonly boundary: AuroraValidationBoundaryKind
  readonly issues: AuroraValidationIssue[]

  constructor(options: AuroraValidationErrorOptions) {
    super(`Validation failed for ${options.schemaId} at ${options.boundary}`)
    this.schemaId = options.schemaId
    this.boundary = options.boundary
    this.issues = options.issues
    if (options.cause !== undefined) {
      this.cause = options.cause
    }
  }

  toJSON(): { code: string; schemaId: string; boundary: AuroraValidationBoundaryKind; issues: AuroraValidationIssue[] } {
    return {
      code: this.code,
      schemaId: this.schemaId,
      boundary: this.boundary,
      issues: this.issues
    }
  }
}
