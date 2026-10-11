import { useEffect, useRef, useState } from 'react'
import type { AttachmentContextIngestResponse, AttachmentContextPrivacyClass, AuthSessionSnapshot, AuroraClient, AuroraError } from '@aurora/client'
import {
  attachmentStatusFromBackend,
  attachmentToContextItem,
  fileToAttachmentDraft,
  isAcceptedContextStatus,
  mapContextIngestOutcomesByPendingIndex,
  revokeAttachmentPreview,
  summarizeAttachments,
  type AssistantAttachmentDraft,
} from './assistant-attachments'
import { browserErrorName } from './assistant-browser-voice-runtime'

type BrowserFileSystemFileHandle = { getFile: () => Promise<File> }
type BrowserOpenFilePicker = (options?: {
  multiple?: boolean
  excludeAcceptAllOption?: boolean
  types?: Array<{ description: string; accept: Record<string, string[]> }>
}) => Promise<BrowserFileSystemFileHandle[]>

const defaultContextLimits = {
  max_items: 8,
  max_item_bytes: 262_144,
  max_total_bytes: 1_048_576,
  max_text_chars: 120_000
}

interface UseAssistantAttachmentsOptions {
  readonly client: Pick<AuroraClient, 'assistant' | 'auth'>
  readonly privacyClass: AttachmentContextPrivacyClass
  readonly setLastError: (message: string | null) => void
  readonly formatError: (error: AuroraError | Error) => string
}

export function useAssistantAttachments({
  client,
  privacyClass,
  setLastError,
  formatError,
}: UseAssistantAttachmentsOptions) {
  const [attachments, setAttachments] = useState<AssistantAttachmentDraft[]>([])
  const attachmentsRef = useRef<AssistantAttachmentDraft[]>([])
  const attachmentInputRef = useRef<HTMLInputElement | null>(null)
  const attachmentGenerationRef = useRef(0)
  const attachmentAuthScopeRef = useRef(assistantAttachmentAuthScope(client.auth.snapshot()))

  const isCurrentAttachmentGeneration = (generation: number): boolean => attachmentGenerationRef.current === generation

  useEffect(() => {
    attachmentsRef.current = attachments
  }, [attachments])

  useEffect(() => {
    return client.auth.subscribe((auth) => {
      const nextScope = assistantAttachmentAuthScope(auth)
      if (attachmentAuthScopeRef.current === nextScope) return
      attachmentAuthScopeRef.current = nextScope
      clearAttachments()
    })
  }, [client])

  useEffect(() => () => {
    attachmentGenerationRef.current += 1
    for (const attachment of attachmentsRef.current) revokeAttachmentPreview(attachment)
  }, [])

  const hasContextUpload = attachments.some((attachment) => attachment.status === 'uploading')
  const attachmentsAwaitingValidation = attachments.filter((attachment) =>
    attachment.status === 'staged' || attachment.status === 'error'
  )
  const contextSummary = summarizeAttachments(attachments)

  function clearAttachments() {
    attachmentGenerationRef.current += 1
    for (const attachment of attachmentsRef.current) revokeAttachmentPreview(attachment)
    setAttachments([])
  }

  async function ingestPendingAttachments(sessionId: string | null): Promise<'ready' | 'blocked'> {
    if (attachments.some((attachment) => attachment.status === 'rejected' || attachment.status === 'unsupported')) {
      setLastError('Remove rejected or unsupported context items before sending.')
      return 'blocked'
    }
    const generation = attachmentGenerationRef.current
    const pending = attachments.filter((attachment) => attachment.status === 'staged' || attachment.status === 'error')
    if (pending.length === 0) return 'ready'

    setLastError(null)
    setAttachments((current) =>
      current.map((attachment) =>
        pending.some((candidate) => candidate.id === attachment.id)
          ? { ...attachment, status: 'uploading', progress: 48, message: 'Uploading context metadata through Aurora' }
          : attachment
      )
    )

    const result = await client.assistant.ingestContext({
      items: pending.map(attachmentToContextItem),
      session_id: sessionId,
      namespace: 'assistant.attachments',
      storage_policy: 'ephemeral',
      privacy_class: privacyClass,
      limits: defaultContextLimits
    })

    if (!isCurrentAttachmentGeneration(generation) || !attachmentsStillPending(pending)) {
      restoreCurrentPendingAttachments(pending)
      return 'blocked'
    }

    if (!result.ok) {
      const message = formatError(result.error)
      setLastError(message)
      setAttachments((current) =>
        current.map((attachment) =>
          pending.some((candidate) => candidate.id === attachment.id)
            ? { ...attachment, status: 'error', progress: 0, message }
            : attachment
        )
      )
      return 'blocked'
    }

    applyContextIngestResult(pending, result.data)
    return result.data.accepted && !result.data.rejected ? 'ready' : 'blocked'
  }

  function applyContextIngestResult(
    pending: AssistantAttachmentDraft[],
    response: AttachmentContextIngestResponse
  ) {
    const outcomes = mapContextIngestOutcomesByPendingIndex(response)
    setAttachments((current) =>
      current.map((attachment) => {
        const pendingIndex = pending.findIndex((candidate) => candidate.id === attachment.id)
        if (pendingIndex === -1) return attachment
        const outcome = outcomes.get(pendingIndex)
        if (!outcome) {
          return { ...attachment, status: 'error', progress: 0, message: 'Aurora could not finish this context item. Try again.' }
        }
        return {
          ...attachment,
          status: attachmentStatusFromBackend(outcome.status),
          progress: isAcceptedContextStatus(outcome.status) ? 100 : 0,
          message: outcome.message || outcome.reason_code || 'Context ingestion completed.',
          reasonCode: outcome.reason_code,
          redacted: outcome.redacted
        }
      })
    )
    if (response.rejected) {
      setLastError('Some context items were rejected or unsupported. Remove or revise them before retrying.')
    }
  }

  async function openAttachmentPicker(canAttach: boolean) {
    if (!canAttach) return
    const picker = typeof window === 'undefined'
      ? undefined
      : (window as unknown as { showOpenFilePicker?: BrowserOpenFilePicker }).showOpenFilePicker
    if (!picker) {
      attachmentInputRef.current?.click()
      return
    }
    const generation = attachmentGenerationRef.current
    try {
      const handles = await picker({
        multiple: true,
        excludeAcceptAllOption: true,
        types: [{
          description: 'Aurora context files',
          accept: {
            'image/*': ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp'],
            'application/pdf': ['.pdf'],
            'application/json': ['.json'],
            'text/plain': ['.txt'],
            'text/markdown': ['.md', '.markdown']
          }
        }]
      })
      const files = await Promise.all(handles.map((handle) => handle.getFile()))
      await stageAttachmentFiles(files, generation)
    } catch (error) {
      if (browserErrorName(error) === 'AbortError') return
      attachmentInputRef.current?.click()
    }
  }

  async function onFileInput(files: FileList | null, canAttach: boolean) {
    if (!files || !canAttach) return
    const generation = attachmentGenerationRef.current
    await stageAttachmentFiles([...files], generation)
  }

  async function stageAttachmentFiles(files: File[], generation: number) {
    const drafts = await Promise.all(files.map((file) => fileToAttachmentDraft(file, 'chat', privacyClass)))
    const supported = drafts.filter((draft) => draft.status !== 'rejected' && draft.status !== 'unsupported')
    if (!isCurrentAttachmentGeneration(generation)) {
      for (const draft of supported) revokeAttachmentPreview(draft)
      return
    }
    if (supported.length === 0) return
    setAttachments((current) => isCurrentAttachmentGeneration(generation) ? [...current, ...supported] : current)
  }

  function removeAttachment(id: string) {
    attachmentGenerationRef.current += 1
    setAttachments((current) => {
      const removed = current.find((attachment) => attachment.id === id)
      if (removed) revokeAttachmentPreview(removed)
      return current.filter((attachment) => attachment.id !== id)
    })
  }

  function attachmentsStillPending(pending: AssistantAttachmentDraft[]): boolean {
    const currentIds = new Set(attachmentsRef.current.map((attachment) => attachment.id))
    return pending.every((attachment) => currentIds.has(attachment.id))
  }

  function restoreCurrentPendingAttachments(pending: AssistantAttachmentDraft[]) {
    const pendingIds = new Set(pending.map((attachment) => attachment.id))
    setAttachments((current) => current.map((attachment) => (
      pendingIds.has(attachment.id) && attachment.status === 'uploading'
        ? { ...attachment, status: 'staged', progress: 0, message: 'Ready for review.' }
        : attachment
    )))
  }

  return {
    attachments,
    setAttachments,
    attachmentInputRef,
    hasContextUpload,
    attachmentsAwaitingValidation,
    contextSummary,
    clearAttachments,
    ingestPendingAttachments,
    openAttachmentPicker,
    onFileInput,
    removeAttachment,
  }
}

function assistantAttachmentAuthScope(auth: AuthSessionSnapshot): string {
  return `${auth.state}:${auth.principalId ?? ''}:${[...auth.effectivePermissions].sort().join(',')}`
}
