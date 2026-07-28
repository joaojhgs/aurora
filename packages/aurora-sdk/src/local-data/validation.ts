import { z, type ZodType } from 'zod/v4'

import { LocalDataError } from './backend.js'

export function parseLocalDataBoundary<T>(schema: ZodType<T>, value: unknown, boundaryName: string): T {
  const result = schema.safeParse(value)
  if (result.success) return result.data
  throw new LocalDataError('invalid_record', `Invalid ${boundaryName}: ${summarizeIssues(result.error.issues)}`, {
    validation: 'redacted',
    issues: result.error.issues.slice(0, 8).map((issue) => ({
      code: issue.code,
      path: issue.path.map(String).join('.')
    }))
  })
}

export function isJsonRoundTripStable(value: unknown): boolean {
  try {
    const encoded = JSON.stringify(value)
    return encoded !== undefined && JSON.stringify(JSON.parse(encoded)) === encoded
  } catch {
    return false
  }
}

function summarizeIssues(issues: z.core.$ZodIssue[]): string {
  return issues.slice(0, 3).map((issue) => {
    const path = issue.path.map(String).join('.')
    if (issue.code === 'unrecognized_keys') {
      return `${path ? `${path}.` : ''}${issue.keys.join(',')}`
    }
    return path || issue.code
  }).join('; ')
}
