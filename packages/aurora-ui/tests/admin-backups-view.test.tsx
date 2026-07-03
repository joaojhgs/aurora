import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AuroraClient as Aurora, AuroraError, MockAuroraTransport, backupListFixture } from '@aurora/client'
import { BackupRestoreView, backupErrorMessage } from '../src/backup-restore-view'
import { auroraNavSections, navItemSnapshot } from '../src/nav'
import type { RouteAvailability } from '../src/shell-data'

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
    const markup = renderToStaticMarkup(
      <BackupRestoreView client={client()} route={route} initialList={backupListFixture} />
    )

    expect(markup).toContain('Create is disabled: Unavailable')
    expect(markup).toContain('Backup operations are disabled until backend Backup.List capability state')
    expect(markup).toContain('Expose Backup contracts')
    expect(markup).toContain('Backend has not advertised Backup.List or Backup.* AdminAction contracts.')
    expect(markup).toContain('<button type="submit" disabled="">Create via AdminAction</button>')
    expect(markup).toContain('<button type="submit" disabled="">Preview restore impact</button>')
  })

  it('describes AdminAction as required for mutations even when route-level read access does not require AdminAction', () => {
    const markup = renderToStaticMarkup(
      <BackupRestoreView client={client()} route={backupRoute({ requiresAdminAction: false })} initialList={backupListFixture} />
    )

    expect(markup).toContain('required for create, verify, restore dry-run and rollback dry-run')
    expect(markup).not.toContain('not required')
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
