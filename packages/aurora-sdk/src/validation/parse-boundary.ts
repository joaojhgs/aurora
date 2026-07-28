import type { z } from 'zod/v4'

import { AuroraValidationError, type AuroraValidationBoundaryKind, type AuroraValidationIssue } from './error.js'

export interface ParseBoundaryContext {
  boundary: AuroraValidationBoundaryKind
}

function redactPath(path: readonly PropertyKey[]): string {
  if (path.length === 0) return '$'
  return `$${path
    .map((segment) => (typeof segment === 'number' ? `[${segment}]` : `.${String(segment).replace(/[^A-Za-z0-9_$-]/g, '_')}`))
    .join('')}`
}

function redactIssues(error: z.ZodError): AuroraValidationIssue[] {
  return error.issues.map((issue) => ({
    path: redactPath(issue.path),
    code: issue.code,
    message: issue.message
  }))
}

export function parseBoundary<TSchema extends z.ZodType>(
  schemaId: string,
  schema: TSchema,
  value: unknown,
  context: ParseBoundaryContext
): z.output<TSchema> {
  const result = schema.safeParse(value)
  if (result.success) return result.data
  throw new AuroraValidationError({
    schemaId,
    boundary: context.boundary,
    issues: redactIssues(result.error),
    cause: result.error
  })
}
