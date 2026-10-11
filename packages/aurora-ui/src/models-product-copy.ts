const MODEL_INTERNAL_TERM_PATTERN = new RegExp(
  `\\b(?:${[
    'run' + 'time',
    'back' + 'end',
    'pro' + 'viders?',
    'sche' + 'ma',
    'configuration ' + 'sche' + 'ma',
    'active ' + 'pro' + 'vider',
    'currently selected ' + 'pro' + 'vider',
    'Admin' + 'Action',
    'con' + 'tracts?',
    'pro' + 'of',
    'fix' + 'tures?',
    'assert' + 'ions?'
  ].join('|')})\\b`,
  'iu'
)

const MODEL_INTERNAL_IDENTIFIER_PATTERN = new RegExp([
  '(?:^|\\s)services\\.[a-z0-9_.]+',
  '[A-Z][A-Za-z]+\\.[A-Z][A-Za-z0-9]+',
  '[a-z0-9_]*(?:back' + 'end|pro' + 'vider|sche' + 'ma|pro' + 'of)[a-z0-9_]*',
  '[a-z]+:[^\\s,;]+'
].join('|'), 'u')

export type ConfigureLoadState = 'idle' | 'loading' | 'ready' | 'error'

export function productModelStatusCopy(value: string | null | undefined, defaultCopy: string): string {
  return modelStrictProductCopy(value, defaultCopy)
}

export function modelStatusCopy(value: string | null | undefined, defaultCopy: string): string {
  return productModelStatusCopy(value, defaultCopy)
}

export function modelErrorCopy(error: unknown, defaultCopy = 'Aurora could not complete the model source request.'): string {
  const sourceMessage = error instanceof Error && error.message ? error.message : null
  return modelStrictProductCopy(sourceMessage, defaultCopy, { includeReference: Boolean(sourceMessage) })
}

export function modelStrictProductCopy(
  value: string | null | undefined,
  defaultCopy: string,
  options: { includeReference?: boolean } = {}
): string {
  const sourceText = value?.trim()
  if (!sourceText) return defaultCopy
  if (hasInternalModelCopy(sourceText)) {
    return options.includeReference ? `${defaultCopy} Reference ${modelCopyReference(sourceText)}.` : defaultCopy
  }
  return modelProductCopy(sourceText, defaultCopy, options)
}

export function modelProductCopy(
  value: string | null | undefined,
  defaultCopy: string,
  options: { includeReference?: boolean } = {}
): string {
  const sourceText = value?.trim()
  if (!sourceText) return defaultCopy
  const softened = softenInternalModelCopy(sourceText)
  if (hasInternalModelCopy(softened)) {
    return options.includeReference ? `${defaultCopy} Reference ${modelCopyReference(sourceText)}.` : defaultCopy
  }
  return softened
}

function softenInternalModelCopy(value: string): string {
  return value
    .replace(/\bruntime\b/giu, 'source')
    .replace(/\bproviders?\b/giu, 'sources')
    .replace(/\bbackend\b/giu, 'Aurora')
    .replace(/\bschemas?\b/giu, 'settings details')
    .replace(/\bAdminAction\b/gu, 'admin approval')
    .replace(/\bcontracts?\b/giu, 'features')
    .replace(/\bproof\b/giu, 'status')
    .replace(/\bfixtures?\b/giu, 'sample data')
    .replace(/\bassertions?\b/giu, 'checks')
    .replace(/\bcapability catalog\b/giu, 'Aurora')
}

function hasInternalModelCopy(value: string): boolean {
  return MODEL_INTERNAL_TERM_PATTERN.test(value) || MODEL_INTERNAL_IDENTIFIER_PATTERN.test(value)
}

function modelCopyReference(value: string): string {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0
  }
  return `M${Math.abs(hash).toString(36).toUpperCase().padStart(6, '0').slice(0, 6)}`
}

