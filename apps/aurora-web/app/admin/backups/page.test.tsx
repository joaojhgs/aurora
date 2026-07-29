import { AuroraError } from '@aurora/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import Page from './page'

const { listBackups } = vi.hoisted(() => ({
  listBackups: vi.fn()
}))

vi.mock('../../aurora-client', () => ({
  createAuroraWebClient: () => ({
    backups: {
      list: listBackups
    }
  })
}))

vi.mock('../../shell-state', () => ({
  getShellSnapshot: () => ({
    routes: [{
      item: { id: 'backups' },
      disabled: false,
      state: 'available-local',
      routeable: true,
      requiresAdminAction: false,
      blockers: [],
      explanation: 'Ready'
    }]
  })
}))

vi.mock('../../backup-client', () => ({
  BackupClientPage: ({ initialError }: { initialError?: string | null }) => (
    <section aria-label="Backup status" data-initial-error={initialError ?? ''}>
      {initialError ?? 'Backups ready'}
    </section>
  )
}))

describe('web backup page copy', () => {
  beforeEach(() => {
    listBackups.mockReset()
  })

  it('sanitizes hostile typed initial-list errors before rendering text or user-facing attributes', async () => {
    listBackups.mockResolvedValueOnce({
      ok: false,
      error: new AuroraError({
        code: 'transport_loss',
        message: 'Backup.List Gateway.GetSupportBundle /home/alice room-password WebRTC sidecar evidence SDK fallback raw token',
        correlationId: 'BACKUP_REF-9'
      })
    })

    const markup = renderToStaticMarkup(await Page())
    const text = visibleOutput(markup)
    const attributes = userFacingAttributes(markup)

    expect(text).toContain('Connection lost. Reconnecting... Ref BACKUP_REF-9.')
    expect(`${text} ${attributes}`).not.toMatch(/Backup\.List|Gateway\.|\/home\/|room-password|WebRTC|sidecar|evidence|SDK|fallback|raw|token/i)
  })
})

function visibleOutput(markup: string): string {
  return markup
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

function userFacingAttributes(markup: string): string {
  return Array.from(markup.matchAll(/\s(?:aria-label|aria-description|title|placeholder|alt|data-initial-error)="([^"]*)"/giu))
    .map((match) => match[1] ?? '')
    .join(' ')
    .replace(/&quot;/g, '"')
}
