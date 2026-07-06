// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { AuroraClient as Aurora, AuroraError, MockAuroraTransport, backupListFixture } from '@aurora/client'
import { BackupRestoreView, backupErrorMessage } from '../src/backup-restore-view'
import { auroraNavSections, navItemSnapshot } from '../src/nav'
import type { RouteAvailability } from '../src/shell-data'

const roots: Root[] = []

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(() => {
  for (const root of roots.splice(0)) root.unmount()
})

function mount(node: React.ReactElement): HTMLElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => {
    root.render(node)
  })
  return container
}

describe('BackupRestoreView', () => {
  it('renders manifests with encryption, manifest integrity, AdminAction operations, and dry-run rollback warnings', () => {
    const markup = renderToStaticMarkup(
      <BackupRestoreView client={client()} route={backupRoute()} initialList={backupListFixture} />
    )

    expect(markup).toContain('Backups &amp; Restore')
    expect(markup).toContain('Create via AdminAction')
    expect(markup).toContain('Verify via AdminAction')
    expect(markup).toContain('Preview restore impact')
    expect(markup).toContain('Preview rollback dry-run')
    expect(markup).toContain('AdminAction draft/confirm/audit')
    expect(markup).toContain('Manifest integrity')
    expect(markup).toContain('Schema aurora.backup.v1')
    expect(markup).toContain('not encrypted')
    expect(markup).toContain('secrets protected')
    expect(markup).toContain('Destructive restore is intentionally unavailable')
    expect(markup).toContain('warning-only')
    expect(markup).toContain('backup-20260625T120000Z-config-rag')
  })

  it('keeps create and restore controls disabled with honest repair state when backend contract status is missing', () => {
    const route = backupRoute({
      state: 'unsupported',
      routeable: false,
      disabled: true,
      providerLabel: 'capability missing',
      blockers: ['capability_not_advertised'],
      repairActions: [{
        id: 'configure-route',
        label: 'Expose Backup contracts',
        href: '/admin/contracts',
        disabled: true,
        reason: 'Backend has not advertised Backup.List or Backup.* AdminAction contracts.'
      }]
    })
    const container = mount(
      <BackupRestoreView client={client()} route={route} initialList={backupListFixture} />
    )
    const markup = container.innerHTML

    expect(markup).toContain('Create is disabled: Unavailable')
    expect(markup).toContain('Backup operations are disabled until backend Backup.List capability state')
    expect(markup).toContain('Expose Backup contracts')
    expect(markup).toContain('Backend has not advertised Backup.List or Backup.* AdminAction contracts.')

    const buttonByLabel = (label: string) =>
      Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes(label))
    expect(buttonByLabel('Create via AdminAction')?.disabled).toBe(true)
    expect(buttonByLabel('Verify via AdminAction')?.disabled).toBe(true)
    expect(buttonByLabel('Preview restore impact')?.disabled).toBe(true)
  })

  it('describes AdminAction as required for mutations even when route-level read access does not require AdminAction', () => {
    const markup = renderToStaticMarkup(
      <BackupRestoreView client={client()} route={backupRoute({ requiresAdminAction: false })} initialList={backupListFixture} />
    )

    expect(markup).toContain('required for create, verify, restore dry-run and rollback dry-run')
    expect(markup).not.toContain('not required')
  })

  it('opens an AdminAction confirm dialog that stays gated until reason and reauthentication are provided', () => {
    const container = mount(
      <BackupRestoreView client={client()} route={backupRoute()} initialList={backupListFixture} />
    )
    const createTrigger = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Create via AdminAction')
    )
    expect(createTrigger?.disabled).toBe(false)
    act(() => {
      createTrigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const dialog = container.querySelector('[role="dialog"]')
    expect(dialog).not.toBeNull()
    expect(dialog?.textContent).toContain('Create backup')

    const confirmButton = Array.from(container.querySelectorAll('[role="dialog"] button')).find((button) =>
      button.textContent === 'Create backup'
    ) as HTMLButtonElement | undefined
    // reauthentication not yet acknowledged -> confirm stays disabled
    expect(confirmButton?.disabled).toBe(true)
  })

  it('opens a manifest detail sheet when a row is activated', () => {
    const container = mount(
      <BackupRestoreView client={client()} route={backupRoute()} initialList={backupListFixture} />
    )
    const row = container.querySelector('tr.aui-row-clickable') as HTMLElement | null
    expect(row).not.toBeNull()
    act(() => {
      row!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const sheet = container.querySelector('[role="dialog"]')
    expect(sheet).not.toBeNull()
    expect(sheet?.textContent).toContain('Components')
  })

  it('maps backup SDK errors to operator-safe recovery copy', () => {
    expect(backupErrorMessage(new AuroraError({ code: 'permission', message: 'denied' }))).toContain('denied')
    expect(backupErrorMessage(new AuroraError({ code: 'unsupported_feature', message: 'missing' }))).toContain('unavailable')
    expect(backupErrorMessage(new AuroraError({ code: 'transport_loss', message: 'lost' }))).toContain('retry')
  })
})

function client(): Aurora {
  return new Aurora({ transport: new MockAuroraTransport() })
}

function backupRoute(overrides: Partial<RouteAvailability> = {}): RouteAvailability {
  const item = auroraNavSections.flatMap((section) => section.items).find((candidate) => candidate.id === 'backups')
  if (!item) throw new Error('backups route missing')
  return {
    item: navItemSnapshot(item),
    state: 'available-local',
    explanation: 'Backup route available from mock status.',
    providerLabel: 'mock Backup.List',
    blockers: [],
    repairActions: [],
    candidateProviders: [],
    evidenceSources: ['Backup.List', 'Gateway.AdminActionDraft', 'Gateway.AdminActionConfirm'],
    selectorRequired: false,
    approvalRequired: false,
    routeable: true,
    disabled: false,
    requiresAdminAction: false,
    ...overrides
  }
}
