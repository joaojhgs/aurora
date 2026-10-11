// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AttachmentContextIngestResponse } from '@aurora/client'

import {
  attachmentStateBadge,
  attachmentStatusFromBackend,
  attachmentToContextItem,
  contextIngestOutcomeIndex,
  createAttachmentDraft,
  fileToAttachmentDraft,
  formatBytes,
  imageMimeTypeFromFile,
  isAcceptedContextStatus,
  mapContextIngestOutcomesByPendingIndex,
  revokeAttachmentPreview,
  sourceLabel,
  summarizeAttachments,
  urlLabel,
  validateAssistantAttachmentFile,
  type AssistantAttachmentDraft,
} from './assistant-attachments'

describe('assistant attachment helpers', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(42)
    vi.spyOn(Math, 'random').mockReturnValue(0.123456)
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:preview')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('creates drafts and converts them to context items', () => {
    const draft = createAttachmentDraft({
      kind: 'text',
      label: 'notes.md',
      detail: 'Markdown · 32 B',
      contentText: '# Notes',
      filename: 'notes.md',
      mimeType: 'text/markdown',
      sizeBytes: 32,
      sourceChannel: 'chat',
      privacyClass: 'personal'
    })

    expect(draft).toMatchObject({
      id: 'context-42-4fzyo',
      sourceDisplayName: 'chat composer',
      status: 'staged',
      progress: 0,
      redacted: false,
      message: 'Ready for review.'
    })
    expect(attachmentToContextItem(draft)).toMatchObject({
      kind: 'text',
      content_text: '# Notes',
      title: 'notes.md',
      filename: 'notes.md',
      mime_type: 'text/markdown',
      size_bytes: 32,
      source: {
        channel: 'chat',
        display_name: 'chat composer',
        mime_type: 'text/markdown',
        uri: null
      },
      metadata: {
        ui_status: 'staged',
        route_privacy_class: 'personal'
      }
    })
  })

  it('maps backend statuses and pending outcome indexes', () => {
    const response = {
      accepted_items: [{ item_id: 'context-0-abcd', status: 'accepted', message: 'Ready', reason_code: null, redacted: false }],
      rejected_items: [{ item_id: 'mock-context-2', status: 'unsupported', message: 'Unsupported', reason_code: 'unsupported_type', redacted: false }]
    } as Pick<AttachmentContextIngestResponse, 'accepted_items' | 'rejected_items'>
    const outcomes = mapContextIngestOutcomesByPendingIndex(response)

    expect(attachmentStatusFromBackend('stored')).toBe('stored')
    expect(attachmentStatusFromBackend('unsupported')).toBe('unsupported')
    expect(attachmentStatusFromBackend('rejected' as Parameters<typeof attachmentStatusFromBackend>[0])).toBe('rejected')
    expect(isAcceptedContextStatus('redacted')).toBe(true)
    expect(isAcceptedContextStatus('rejected')).toBe(false)
    expect(contextIngestOutcomeIndex('context-7-qwert')).toBe(7)
    expect(contextIngestOutcomeIndex('mock-context-9')).toBe(9)
    expect(contextIngestOutcomeIndex('unmatched')).toBeNull()
    expect(outcomes.get(0)?.message).toBe('Ready')
    expect(outcomes.get(2)?.reason_code).toBe('unsupported_type')
  })

  it('validates files and creates text or preview drafts', async () => {
    const textFile = fileWithText(['hello'], 'notes.md', { type: 'text/markdown' })
    const imageFile = new File(['image-bytes'], 'photo.png', { type: 'image/png' })
    const binaryFile = new File(['binary'], 'archive.zip', { type: 'application/zip' })

    await expect(fileToAttachmentDraft(textFile, 'chat', 'personal')).resolves.toMatchObject({
      kind: 'file',
      contentText: 'hello',
      mimeType: 'text/markdown',
      detail: 'Markdown · 5 B'
    })
    await expect(fileToAttachmentDraft(imageFile, 'desktop', 'sensitive')).resolves.toMatchObject({
      kind: 'image',
      contentText: 'Image attachment: photo.png (image/png, 11 B). The file preview is available; its full contents are not included in the message yet.',
      previewUrl: 'blob:preview',
      sourceDisplayName: 'desktop'
    })
    expect(validateAssistantAttachmentFile(binaryFile)).toEqual({
      allowed: false,
      reason: 'Unsupported attachment type. Add only images, PDF, JSON, .txt, or .md files.'
    })
  })

  it('summarizes attachment state and utility labels', () => {
    const drafts: AssistantAttachmentDraft[] = [
      draftWithStatus('accepted'),
      draftWithStatus('stored'),
      draftWithStatus('redacted'),
      draftWithStatus('rejected'),
      draftWithStatus('error'),
      draftWithStatus('staged')
    ]

    expect(summarizeAttachments(drafts)).toEqual({ ready: 3, blocked: 2 })
    expect(attachmentStateBadge('accepted')).toBe('available-local')
    expect(attachmentStateBadge('uploading')).toBe('pending')
    expect(attachmentStateBadge('unsupported')).toBe('unsupported')
    expect(attachmentStateBadge('error')).toBe('denied')
    expect(imageMimeTypeFromFile('picture.jpeg', '')).toBe('image/jpeg')
    expect(sourceLabel('browser_extension')).toBe('browser extension')
    expect(urlLabel('https://example.com/path')).toBe('example.com')
    expect(urlLabel('not a url')).toBe('URL context')
    expect(formatBytes(999)).toBe('999 B')
    expect(formatBytes(2048)).toBe('2 KB')
    expect(formatBytes(2_621_440)).toBe('2.5 MB')
  })

  it('revokes preview URLs when present', () => {
    revokeAttachmentPreview({ previewUrl: 'blob:preview' })
    revokeAttachmentPreview({ previewUrl: null })

    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview')
  })
})

function fileWithText(parts: string[], name: string, options: FilePropertyBag): File {
  const file = new File(parts, name, options)
  if (typeof file.text !== 'function') {
    Object.defineProperty(file, 'text', {
      configurable: true,
      value: async () => parts.join('')
    })
  }
  return file
}

function draftWithStatus(status: AssistantAttachmentDraft['status']): AssistantAttachmentDraft {
  return {
    id: `draft-${status}`,
    kind: 'text',
    label: status,
    detail: status,
    contentText: status,
    url: null,
    filename: null,
    mimeType: 'text/plain',
    sizeBytes: status.length,
    previewUrl: null,
    sourceChannel: 'chat',
    sourceDisplayName: 'chat composer',
    privacyClass: 'personal',
    status,
    progress: 0,
    message: status,
    reasonCode: null,
    redacted: false
  }
}
