import type {
  AttachmentContextIngestResponse,
  AttachmentContextItem,
  AttachmentContextItemResult,
  AttachmentContextPrivacyClass,
  AttachmentContextSourceChannel,
  AttachmentContextStatus,
} from '@aurora/client'
import type { RouteAvailability } from './shell-data'

export type AttachmentTrayStatus =
  | 'staged'
  | 'uploading'
  | 'accepted'
  | 'redacted'
  | 'stored'
  | 'unsupported'
  | 'rejected'
  | 'error'

export interface AssistantAttachmentDraft {
  id: string
  kind: 'text' | 'url' | 'file' | 'image'
  label: string
  detail: string
  contentText?: string | null
  url?: string | null
  filename?: string | null
  mimeType?: string | null
  sizeBytes?: number | null
  previewUrl?: string | null
  sourceChannel: AttachmentContextSourceChannel
  sourceDisplayName: string
  privacyClass: AttachmentContextPrivacyClass
  status: AttachmentTrayStatus
  progress: number
  message: string
  reasonCode?: string | null
  redacted: boolean
}

export function attachmentToContextItem(attachment: AssistantAttachmentDraft): AttachmentContextItem {
  const source = {
    channel: attachment.sourceChannel,
    display_name: attachment.sourceDisplayName,
    mime_type: attachment.mimeType ?? null,
    uri: attachment.url ?? null,
    shared_at: new Date().toISOString()
  }
  return {
    kind: attachment.kind,
    content_text: attachment.contentText ?? null,
    url: attachment.url ?? null,
    title: attachment.label,
    filename: attachment.filename ?? null,
    mime_type: attachment.mimeType ?? null,
    size_bytes: attachment.sizeBytes ?? null,
    source,
    metadata: {
      ui_status: attachment.status,
      route_privacy_class: attachment.privacyClass
    }
  }
}

export function attachmentStatusFromBackend(status: AttachmentContextStatus): AttachmentTrayStatus {
  if (status === 'accepted' || status === 'redacted' || status === 'stored') return status
  if (status === 'unsupported') return 'unsupported'
  return 'rejected'
}

export function isAcceptedContextStatus(status: AttachmentContextStatus): boolean {
  return status === 'accepted' || status === 'redacted' || status === 'stored'
}

export function contextIngestOutcomeIndex(itemId: string): number | null {
  const productionMatch = /^context-(\d+)-.+$/.exec(itemId)
  if (productionMatch) return Number(productionMatch[1])
  const mockMatch = /^mock-context-(\d+)$/.exec(itemId)
  if (mockMatch) return Number(mockMatch[1])
  return null
}

export function mapContextIngestOutcomesByPendingIndex(
  response: Pick<AttachmentContextIngestResponse, 'accepted_items' | 'rejected_items'>
): Map<number, AttachmentContextItemResult> {
  const outcomes = new Map<number, AttachmentContextItemResult>()
  for (const outcome of [...response.accepted_items, ...response.rejected_items]) {
    const index = contextIngestOutcomeIndex(outcome.item_id)
    if (index === null) continue
    outcomes.set(index, outcome)
  }
  return outcomes
}

export function createAttachmentDraft(input: {
  kind: AssistantAttachmentDraft['kind']
  label: string
  detail: string
  contentText?: string | null
  url?: string | null
  filename?: string | null
  mimeType?: string | null
  sizeBytes?: number | null
  previewUrl?: string | null
  sourceChannel: AttachmentContextSourceChannel
  privacyClass: AttachmentContextPrivacyClass
}): AssistantAttachmentDraft {
  return {
    id: `context-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    kind: input.kind,
    label: input.label,
    detail: input.detail,
    contentText: input.contentText ?? null,
    url: input.url ?? null,
    filename: input.filename ?? null,
    mimeType: input.mimeType ?? null,
    sizeBytes: input.sizeBytes ?? null,
    previewUrl: input.previewUrl ?? null,
    sourceChannel: input.sourceChannel,
    sourceDisplayName: sourceLabel(input.sourceChannel),
    privacyClass: input.privacyClass,
    status: 'staged',
    progress: 0,
    message: input.contentText
      ? 'Ready for review.'
      : 'Preview staged; Aurora will receive file details only until full file reading is available.',
    reasonCode: null,
    redacted: false
  }
}

export async function fileToAttachmentDraft(
  file: File,
  sourceChannel: AttachmentContextSourceChannel,
  privacyClass: AttachmentContextPrivacyClass
): Promise<AssistantAttachmentDraft> {
  const validation = validateAssistantAttachmentFile(file)
  if (!validation.allowed) {
    return {
      ...createAttachmentDraft({
        kind: 'file',
        label: file.name,
        detail: `${file.type || 'unknown type'} / ${formatBytes(file.size)}`,
        filename: file.name,
        mimeType: file.type || null,
        sizeBytes: file.size,
        sourceChannel,
        privacyClass
      }),
      status: 'rejected',
      progress: 0,
      message: validation.reason
    }
  }
  const isTextLike = validation.kind === 'text' || validation.kind === 'json'
  const isImage = validation.kind === 'image'
  const previewUrl = isImage || validation.kind === 'pdf' ? URL.createObjectURL(file) : null
  const contentText = isTextLike
    ? await file.text()
    : `${isImage ? 'Image' : 'PDF'} attachment: ${file.name} (${file.type || validation.mimeType || 'unknown type'}, ${formatBytes(file.size)}). The file preview is available; its full contents are not included in the message yet.`
  return createAttachmentDraft({
    kind: isImage ? 'image' : 'file',
    label: file.name,
    detail: `${validation.label} · ${formatBytes(file.size)}`,
    contentText,
    previewUrl,
    filename: file.name,
    mimeType: file.type || validation.mimeType,
    sizeBytes: file.size,
    sourceChannel,
    privacyClass
  })
}

export function validateAssistantAttachmentFile(file: File):
  | { allowed: true; kind: 'image' | 'pdf' | 'text' | 'json'; label: string; mimeType: string | null }
  | { allowed: false; reason: string } {
  const name = file.name.toLowerCase()
  const mime = file.type || ''
  const imageMime = imageMimeTypeFromFile(name, mime)
  if (imageMime) return { allowed: true, kind: 'image', label: imageMime, mimeType: imageMime }
  if (mime === 'application/pdf' || name.endsWith('.pdf')) return { allowed: true, kind: 'pdf', label: 'PDF', mimeType: 'application/pdf' }
  if (mime === 'application/json' || mime === 'text/json' || name.endsWith('.json')) return { allowed: true, kind: 'json', label: 'JSON', mimeType: mime || 'application/json' }
  if (mime === 'text/plain' || mime === 'text/markdown' || name.endsWith('.txt') || name.endsWith('.md') || name.endsWith('.markdown')) {
    return { allowed: true, kind: 'text', label: name.endsWith('.md') || name.endsWith('.markdown') ? 'Markdown' : 'Text', mimeType: mime || 'text/plain' }
  }
  return { allowed: false, reason: 'Unsupported attachment type. Add only images, PDF, JSON, .txt, or .md files.' }
}

export function imageMimeTypeFromFile(name: string, mime: string): string | null {
  if (mime.startsWith('image/')) return mime
  if (name.endsWith('.jpg') || name.endsWith('.jpeg')) return 'image/jpeg'
  if (name.endsWith('.png')) return 'image/png'
  if (name.endsWith('.gif')) return 'image/gif'
  if (name.endsWith('.webp')) return 'image/webp'
  if (name.endsWith('.svg')) return 'image/svg+xml'
  if (name.endsWith('.bmp')) return 'image/bmp'
  return null
}

export function summarizeAttachments(attachments: AssistantAttachmentDraft[]): { ready: number; blocked: number } {
  return attachments.reduce(
    (summary, attachment) => {
      if (['accepted', 'redacted', 'stored'].includes(attachment.status)) summary.ready += 1
      if (['unsupported', 'rejected', 'error'].includes(attachment.status)) summary.blocked += 1
      return summary
    },
    { ready: 0, blocked: 0 }
  )
}

export function attachmentStateBadge(status: AttachmentTrayStatus): RouteAvailability['state'] {
  if (status === 'accepted' || status === 'stored' || status === 'redacted') return 'available-local'
  if (status === 'uploading' || status === 'staged') return 'pending'
  if (status === 'unsupported') return 'unsupported'
  return 'denied'
}

export function revokeAttachmentPreview(attachment: Pick<AssistantAttachmentDraft, 'previewUrl'>): void {
  if (!attachment.previewUrl || typeof URL === 'undefined') return
  URL.revokeObjectURL(attachment.previewUrl)
}

export function sourceLabel(source: AttachmentContextSourceChannel): string {
  if (source === 'mobile_share_sheet') return 'mobile share sheet'
  if (source === 'deep_link') return 'deep link'
  if (source === 'browser_extension') return 'browser extension'
  if (source === 'desktop') return 'desktop'
  if (source === 'api') return 'API'
  return 'chat composer'
}

export function urlLabel(value: string): string {
  try {
    return new URL(value).hostname
  } catch {
    return 'URL context'
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
