import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

describe('web backup page', () => {
  beforeEach(() => {
    listBackups.mockReset()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('does not server-prefetch backup data with shared environment credentials', async () => {
    vi.stubEnv('AURORA_GATEWAY_URL', 'https://gateway.example')
    vi.stubEnv('AURORA_GATEWAY_TOKEN', 'server-shared-token')

    const markup = renderToStaticMarkup(await Page())
    const text = visibleOutput(markup)
    const attributes = userFacingAttributes(markup)

    expect(text).toContain('Backups ready')
    expect(`${text} ${attributes}`).not.toContain('server-shared-token')
    expect(listBackups).not.toHaveBeenCalled()
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
