'use client'

import { FileText, ImageIcon, X } from 'lucide-react'
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle
} from '#components/ui/attachment'
import { cn } from '#lib/utils'
import type { AssistantAttachmentDraft, AttachmentTrayStatus } from './assistant-view'

export function ComposerAttachmentPreview({ attachments, onRemove }: { attachments: AssistantAttachmentDraft[]; onRemove: (id: string) => void }) {
  return (
    <AttachmentGroup data-aurora-part="assistant-composer-attachments" className="mx-auto w-full max-w-[var(--aui-chat-width)] items-stretch gap-[0.65rem] pb-[0.4rem] pt-[0.2rem] [@media(max-width:720px)]:mx-3 [@media(max-width:720px)]:w-auto [@media(max-width:720px)]:max-w-none" aria-label="Attached context previews">
      {attachments.map((attachment) => {
        const isImageAttachment = attachment.mimeType?.startsWith('image/') ?? false
        const usesImagePreviewSize = attachment.kind === 'image'
        return (
        <Attachment
          key={attachment.id}
          state={attachmentStateForUi(attachment.status)}
          size="sm"
          orientation="vertical"
          className={cn(
            'w-[13.5rem] min-w-[13.5rem] max-w-[min(13.5rem,82vw)] min-h-[8.6rem] flex-col items-stretch gap-[0.45rem] rounded-[0.95rem] border-[var(--aui-border)] bg-[color-mix(in_srgb,var(--aui-surface-2)_78%,var(--aui-bg))] p-[0.45rem] text-[var(--aui-ink)] [@media(max-width:640px)]:w-48 [@media(max-width:640px)]:min-w-48 [@media(max-width:640px)]:max-w-[78vw]',
            usesImagePreviewSize && 'w-[14.75rem] min-w-[14.75rem] max-w-[min(14.75rem,86vw)]'
          )}
        >
          <AttachmentMedia
            variant={attachment.previewUrl && isImageAttachment ? 'image' : 'icon'}
            className={cn(
              'grid w-full !h-[6.35rem] !min-h-[6.35rem] flex-[0_0_6.35rem] place-items-center overflow-hidden rounded-[0.8rem] bg-[color-mix(in_srgb,var(--aui-bg)_72%,var(--aui-surface-2))] text-[color-mix(in_srgb,var(--aui-muted)_72%,var(--aui-ink))] [&_img]:block [&_img]:!h-full [&_img]:!w-full [&_img]:object-cover [&_svg]:size-8 [@media(max-width:640px)]:!h-[5.8rem] [@media(max-width:640px)]:!min-h-[5.8rem] [@media(max-width:640px)]:flex-[0_0_5.8rem]',
              usesImagePreviewSize && '!h-[7.25rem] !min-h-[7.25rem] flex-[0_0_7.25rem] bg-[#05070a]'
            )}
          >
            {attachment.previewUrl && isImageAttachment ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={attachment.previewUrl} alt={attachment.label} />
            ) : isImageAttachment ? (
              <ImageIcon aria-hidden />
            ) : (
              <FileText aria-hidden />
            )}
          </AttachmentMedia>
          <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-end gap-[0.45rem]">
            <AttachmentContent className="min-w-0 max-w-none flex-1 !p-0 text-left [&_[data-slot=attachment-description]]:mt-[0.1rem] [&_[data-slot=attachment-description]]:max-w-full [&_[data-slot=attachment-description]]:text-[0.68rem] [&_[data-slot=attachment-description]]:leading-[1.2] [&_[data-slot=attachment-description]]:text-[var(--aui-muted)] [&_[data-slot=attachment-title]]:max-w-full [&_[data-slot=attachment-title]]:text-[0.78rem] [&_[data-slot=attachment-title]]:leading-[1.2] [&_[data-slot=attachment-title]]:text-[var(--aui-ink)]">
              <AttachmentTitle>{attachment.label}</AttachmentTitle>
              <AttachmentDescription>{attachment.detail}</AttachmentDescription>
            </AttachmentContent>
            <AttachmentActions className="static inset-auto shrink-0 self-end">
              <AttachmentAction type="button" aria-label={`Remove ${attachment.label}`} onClick={() => onRemove(attachment.id)} className="min-h-[1.65rem] min-w-[1.65rem] border-[color-mix(in_srgb,var(--aui-border)_80%,transparent)] bg-[color-mix(in_srgb,var(--aui-bg)_55%,transparent)]">
                <X aria-hidden />
              </AttachmentAction>
            </AttachmentActions>
          </div>
        </Attachment>
        )
      })}
    </AttachmentGroup>
  )
}

function attachmentStateForUi(status: AttachmentTrayStatus): 'idle' | 'uploading' | 'processing' | 'error' | 'done' {
  if (status === 'uploading') return 'uploading'
  if (status === 'staged') return 'idle'
  if (status === 'accepted' || status === 'redacted' || status === 'stored') return 'done'
  return 'error'
}
