// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { AuroraClient as Aurora, AuroraError, MockAuroraTransport, backupListFixture, createAuditReceipt } from '@aurora/client'
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
  it('renders the backups table with snapshot, scope, size, and status', () => {
    const markup = renderToStaticMarkup(
      <BackupRestoreView client={client()} route={backupRoute()} initialList={backupListFixture} />
    )

    expect(markup).toContain('Backups')
    expect(markup).toContain('Create and verify snapshots, or preview a restore before making changes.')
    expect(markup).toContain('Create backup now')
    expect(markup).toContain('backup-20260625T120000Z-config-rag')
    expect(markup).toContain('Config + Rag')
    expect(markup).toContain('Verify')
    expect(markup).toContain('Preview restore')
    expect(markup).not.toContain('AdminAction draft/confirm/audit')
    expect(markup).not.toContain('Manifest integrity')
  })

  it('passes the query abort signal to the backup list request', async () => {
    const seenSignals: Array<AbortSignal | undefined> = []
    const transport = MockAuroraTransport.empty().register('Backup.List', (request) => {
      seenSignals.push(request.signal)
      return backupListFixture
    })
    const container = mount(<BackupRestoreView client={new Aurora({ transport })} route={backupRoute()} />)

    await act(async () => {
      await flushPromises()
    })

    expect(seenSignals).toHaveLength(1)
    expect(seenSignals[0]).toBeInstanceOf(AbortSignal)
    container.remove()
  })

  it('updates the scoped backups query data after creating a backup', async () => {
    const backupClient = client()
    const createdBackup = {
      ...backupListFixture.backups[0]!,
      backup_id: 'backup-created-from-query-cache',
      created_at: '2026-07-01T00:00:00.000Z',
    }
    const backendList: typeof backupListFixture = { ...backupListFixture, backups: [], total: 0 }
    const list = vi.spyOn(backupClient.backups, 'list').mockImplementation(async () => ({
      ok: true,
      data: backendList,
      audit: createAuditReceipt({}, { method: 'Backup.List', correlationId: 'corr-list' }),
    }))
    const create = vi.spyOn(backupClient.backups, 'create').mockImplementation(async () => {
      backendList.backups = [createdBackup, ...backendList.backups]
      backendList.total = backendList.backups.length
      return {
        ok: true,
        data: {
          status: 'ok',
          backup: createdBackup,
          audit_receipt: 'audit-created',
          message: 'Backup created.',
        },
        audit: createAuditReceipt({}, { method: 'Backup.Create', correlationId: 'corr-created' }),
      }
    })

    const container = mount(
      <BackupRestoreView client={backupClient} route={backupRoute()} initialList={{ ...backupListFixture, backups: [], total: 0 }} />
    )
    const createButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Create backup now')
    await act(async () => {
      createButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    })

    const confirmButton = Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')).find((button) =>
      button.textContent === 'Create backup'
    )
    await act(async () => {
      confirmButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await flushPromises()
    })

    expect(create).toHaveBeenCalledOnce()
    await vi.waitFor(async () => {
      await act(async () => { await flushPromises() })
      expect(list).toHaveBeenCalled()
      expect(container.textContent).toContain('backup-created-from-query-cache')
    })
  })

  it('keeps create and row actions disabled with honest repair state when backend contract status is missing', () => {
    const route = backupRoute({
      state: 'unsupported',
      routeable: false,
      disabled: true,
      providerLabel: 'capability missing',
      blockers: ['capability_not_advertised']
    })
    const container = mount(
      <BackupRestoreView client={client()} route={route} initialList={backupListFixture} />
    )
    const markup = container.innerHTML

    expect(markup).toContain('Backup operations are disabled')

    const buttonByLabel = (label: string) =>
      Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes(label))
    expect(buttonByLabel('Create backup now')?.disabled).toBe(true)
    expect(buttonByLabel('Verify')?.disabled).toBe(true)
    expect(buttonByLabel('Preview restore')?.disabled).toBe(true)
  })

  it('opens a non-destructive preview dialog that requires no reason capture', async () => {
    const container = mount(
      <BackupRestoreView client={client()} route={backupRoute()} initialList={backupListFixture} />
    )
    const restoreTrigger = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent === 'Preview restore'
    )
    await act(async () => {
      restoreTrigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      // Base UI's AlertDialog mounts its portal content over two animation-frame
      // ticks (unmounted -> starting-style -> open); flush both before asserting.
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    })

    const dialog = document.body.querySelector('[role="alertdialog"]')
    expect(dialog).not.toBeNull()
    expect(dialog?.textContent).toContain('Preview restore')
    expect(dialog?.textContent).toContain('No saved data will be overwritten')
    expect(dialog?.querySelector('textarea')).toBeNull()

    const confirmButton = Array.from(document.body.querySelectorAll('[role="alertdialog"] button')).find((button) =>
      button.textContent === 'Preview restore'
    ) as HTMLButtonElement | undefined
    expect(confirmButton?.disabled).toBe(false)
  })

  it('handles a rejected restore preview without leaving the dialog busy', async () => {
    const rejectingClient = client()
    let rejectRestore: ((error: Error) => void) | null = null
    const restore = vi.spyOn(rejectingClient.backups, 'restore').mockImplementation(() => new Promise<never>((_, reject) => {
      rejectRestore = reject
    }))
    const container = mount(
      <BackupRestoreView client={rejectingClient} route={backupRoute()} initialList={backupListFixture} />
    )
    const restoreTrigger = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent === 'Preview restore'
    )
    await act(async () => {
      restoreTrigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    })
    const confirmButton = Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')).find((button) =>
      button.textContent === 'Preview restore'
    )
    await act(async () => {
      confirmButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })

    expect(restore).toHaveBeenCalledOnce()
    expect(confirmButton?.disabled).toBe(true)
    expect(confirmButton?.textContent).toContain('Working')
    expect(Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Create backup now')?.disabled).toBe(true)
    expect(Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Verify')?.disabled).toBe(true)
    expect(Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Preview restore')?.disabled).toBe(true)

    await act(async () => {
      rejectRestore?.(new Error('connection reset'))
      await flushPromises()
      await new Promise((resolve) => requestAnimationFrame(resolve))
    })

    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull()
    expect(Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Create backup now')?.disabled).toBe(false)
  })

  it('maps backup SDK errors to operator-safe recovery copy', () => {
    expect(backupErrorMessage(new AuroraError({ code: 'permission', message: 'denied' }))).toContain('Permission is needed')
    expect(backupErrorMessage(new AuroraError({ code: 'unsupported_feature', message: 'missing' }))).toContain('cannot use that feature yet')
    expect(backupErrorMessage(new AuroraError({ code: 'transport_loss', message: 'lost' }))).toContain('Reconnecting')
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

async function flushPromises(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}
