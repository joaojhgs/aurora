// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  AuroraClient as Aurora,
  MockAuroraTransport,
  SCHEDULER_METHODS,
  capabilityCatalogFixture,
  cloneFixture,
  gatewayRegistryFixture,
  schedulerJobsFixture,
  toolCatalogFixture,
  type GetRegistryResponse,
  type SchedulerActionResponse
} from '@aurora/client'
import { AdminSchedulerView, buildAdminSchedulerSnapshot } from '../src/admin-scheduler-view'
import { auroraNavSections, navItemSnapshot } from '../src/nav'
import type { RouteAvailability } from '../src/shell-data'

const roots: Root[] = []

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(() => {
  for (const root of roots.splice(0)) root.unmount()
})

describe('AdminSchedulerView', () => {
  it('renders scheduler jobs with recurrence, next/run history, tool integration, and disabled missing edit contract', async () => {
    const client = new Aurora({ transport: schedulerTransport() })
    const snapshot = await buildAdminSchedulerSnapshot(client, schedulerRoute())
    const markup = renderToStaticMarkup(<AdminSchedulerView client={client} route={schedulerRoute()} initialSnapshot={snapshot} />)

    expect(snapshot.loadState).toBe('ready')
    expect(snapshot.totals).toEqual({ local: 1, delegatedOwned: 1, remoteRunning: 1, foreignDenied: 1 })
    expect(snapshot.jobs[0]).toMatchObject({
      name: 'daily-digest',
      schedule: '0 8 * * *',
      nextRun: '2026-06-26T08:00:00Z',
      runHistory: expect.stringContaining('last 2026-06-25T08:00:00Z')
    })
    expect(snapshot.jobs[1]?.toolIntegration).toContain('Execute Tool -> rag:studio')
    expect(snapshot.jobs[0]?.operationControls.find((control) => control.action === 'edit')).toEqual(
      expect.objectContaining({
        available: false,
        reason: expect.stringContaining('Editing is not ready in this version')
      })
    )

    expect(markup).toContain('Ownership-scoped job table')
    expect(markup).toContain('0 8 * * *')
    expect(markup).toContain('next 2026-06-26T08:00:00Z')
    expect(markup).toContain('this device')
    expect(markup).toContain('Execute Tool -&gt; rag:studio')
    expect(markup).toContain('Editing is not ready in this version')
    expect(markup).toContain('Create schedule')
  })

  it('executes scheduler mutations through AdminAction draft, confirm, and audited backend submit', async () => {
    const calls: string[] = []
    const client = new Aurora({ transport: schedulerTransport(calls) })
    const snapshot = await buildAdminSchedulerSnapshot(client, schedulerRoute())
    calls.splice(0)
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)

    await act(async () => {
      root.render(<AdminSchedulerView client={client} route={schedulerRoute()} initialSnapshot={snapshot} />)
    })

    const cancelButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('cancel'))
    expect(cancelButton).toBeDefined()
    expect(cancelButton?.hasAttribute('disabled')).toBe(true)

    const unlock = container.querySelector('input[type="checkbox"]') as HTMLInputElement | null
    expect(unlock).not.toBeNull()
    await act(async () => {
      unlock!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    expect(cancelButton?.hasAttribute('disabled')).toBe(false)

    await act(async () => {
      cancelButton!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(calls).toEqual([
      'Gateway.AdminActionDraft',
      'Gateway.AdminActionConfirm',
      SCHEDULER_METHODS.cancel,
      SCHEDULER_METHODS.listJobs,
      'Gateway.GetRegistry',
      'Tooling.GetToolCatalog'
    ])
    expect(container.textContent).toContain('scheduler.cancel.audit')
  })


  it('creates typed Tooling scheduled actions through AdminAction and Scheduler.ScheduleAction', async () => {
    const calls: string[] = []
    const client = new Aurora({ transport: schedulerTransport(calls) })
    const snapshot = await buildAdminSchedulerSnapshot(client, schedulerRoute())
    calls.splice(0)
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)

    await act(async () => {
      root.render(<AdminSchedulerView client={client} route={schedulerRoute()} initialSnapshot={snapshot} />)
    })

    const unlock = container.querySelector('input[type="checkbox"]') as HTMLInputElement | null
    const action = container.querySelector('#scheduler-action') as HTMLSelectElement | null
    const form = container.querySelector('form') as HTMLFormElement | null
    expect(unlock).not.toBeNull()
    expect(action).not.toBeNull()
    expect(form).not.toBeNull()

    await act(async () => {
      unlock!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      action!.value = 'tooling.execute'
      action!.dispatchEvent(new Event('change', { bubbles: true }))
    })

    const toolSelect = container.querySelector('#scheduler-tool') as HTMLSelectElement | null
    const args = container.querySelector('#scheduler-tool-args') as HTMLTextAreaElement | null
    expect(toolSelect).not.toBeNull()
    expect(args).not.toBeNull()

    await act(async () => {
      toolSelect!.value = toolSelect!.options[0]?.value ?? ''
      toolSelect!.dispatchEvent(new Event('change', { bubbles: true }))
      setNativeValue(args!, '{"target":"daily-report"}')
      args!.dispatchEvent(new Event('input', { bubbles: true }))
      await Promise.resolve()
    })

    await act(async () => {
      form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(calls).toEqual([
      'Gateway.AdminActionDraft',
      'Gateway.AdminActionConfirm',
      SCHEDULER_METHODS.scheduleAction,
      SCHEDULER_METHODS.listJobs,
      'Gateway.GetRegistry',
      'Tooling.GetToolCatalog'
    ])
    expect(container.textContent).toContain('job-typed-tooling')
    expect(container.textContent).toContain('daily-report')
  })

  it('disables create and mutation controls when Scheduler.manage is missing from advertised contracts', async () => {
    const client = new Aurora({ transport: schedulerTransport([], registryWithoutSchedulerManage()) })
    const snapshot = await buildAdminSchedulerSnapshot(client, schedulerRoute())
    const markup = renderToStaticMarkup(<AdminSchedulerView client={client} route={schedulerRoute()} initialSnapshot={snapshot} />)

    expect(snapshot.loadState).toBe('degraded')
    expect(snapshot.createControl).toMatchObject({
      available: false,
      state: 'denied',
      reason: expect.stringContaining('Permission is needed')
    })
    expect(snapshot.jobs[0]?.operationControls.find((control) => control.action === 'cancel')).toEqual(
      expect.objectContaining({ available: false, state: 'denied' })
    )
    expect(markup).toContain('Permission is needed')
    expect(markup).toContain('Create schedule')
    expect(markup).not.toMatch(/Scheduler\.[A-Za-z]+/)

    const missingMethodClient = new Aurora({ transport: schedulerTransport([], registryWithoutSchedulerMutations()) })
    const missingMethodSnapshot = await buildAdminSchedulerSnapshot(missingMethodClient, schedulerRoute())
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)

    await act(async () => {
      root.render(<AdminSchedulerView client={missingMethodClient} route={schedulerRoute()} initialSnapshot={missingMethodSnapshot} />)
    })

    const disabledTitles = Array.from(container.querySelectorAll('button[disabled][title]'))
      .map((button) => button.getAttribute('title') ?? '')
      .join(' ')
    expect(disabledTitles).toContain('Cancel is not ready for this job.')
    expect(disabledTitles).toContain('Pause is not ready for this job.')
    expect(disabledTitles).not.toMatch(/Scheduler\.[A-Za-z]+/)
  })
})

function schedulerRoute(): RouteAvailability {
  const item = auroraNavSections.flatMap((section) => section.items).find((candidate) => candidate.id === 'scheduler')
  if (!item) throw new Error('scheduler route missing')
  return {
    item: navItemSnapshot(item),
    state: 'available-local',
    explanation: 'Scheduler route available from live registry and capability catalog status.',
    providerLabel: 'mock Scheduler.ListJobs',
    blockers: [],
    repairActions: [],
    candidateProviders: [],
    evidenceSources: ['Scheduler.ListJobs', 'Gateway.GetRegistry', 'Gateway.GetCapabilityCatalog'],
    selectorRequired: false,
    approvalRequired: true,
    routeable: true,
    disabled: false,
    requiresAdminAction: true
  }
}

function setNativeValue(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const prototype = Object.getPrototypeOf(element) as HTMLElement
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value')
  descriptor?.set?.call(element, value)
}

function schedulerTransport(calls: string[] = [], registry: GetRegistryResponse = gatewayRegistryFixture): MockAuroraTransport {
  return MockAuroraTransport.empty()
    .register(SCHEDULER_METHODS.listJobs, () => {
      calls.push(SCHEDULER_METHODS.listJobs)
      return schedulerJobsFixture
    })
    .register('Gateway.GetRegistry', () => {
      calls.push('Gateway.GetRegistry')
      return registry
    })
    .register('Gateway.GetCapabilityCatalog', () => {
      calls.push('Gateway.GetCapabilityCatalog')
      return capabilityCatalogFixture
    })
    .register('Tooling.GetToolCatalog', () => {
      calls.push('Tooling.GetToolCatalog')
      return toolCatalogFixture
    })
    .register('Gateway.AdminActionDraft', () => {
      calls.push('Gateway.AdminActionDraft')
      return {
        action_id: 'aa-scheduler',
        nonce: 'nonce',
        digest: 'digest',
        method_id: SCHEDULER_METHODS.cancel,
        affected_resources: ['scheduler.jobs'],
        required_phrase: 'CONFIRM',
        required_reason: true,
        required_reauth: true,
        expires_at: '2026-07-02T00:05:00Z',
        expires_in_seconds: 300,
        confirmation_headers: {
          action_id: 'X-Aurora-AdminAction-Id',
          confirmation_token: 'X-Aurora-AdminAction-Token',
          digest: 'X-Aurora-AdminAction-Digest'
        }
      }
    })
    .register('Gateway.AdminActionConfirm', () => {
      calls.push('Gateway.AdminActionConfirm')
      return {
        action_id: 'aa-scheduler',
        confirmation_token: 'token',
        digest: 'digest',
        confirmed: true,
        expires_at: '2026-07-02T00:05:00Z',
        audit_receipt: 'audit-scheduler-001',
        confirmation_headers: {
          action_id: 'X-Aurora-AdminAction-Id',
          confirmation_token: 'X-Aurora-AdminAction-Token',
          digest: 'X-Aurora-AdminAction-Digest'
        }
      }
    })
    .register(SCHEDULER_METHODS.cancel, () => {
      calls.push(SCHEDULER_METHODS.cancel)
      return {
        ok: true,
        status: 'cancelled',
        job_id: 'job-local-daily-digest',
        action: 'cancel',
        reason: 'scheduler.cancel.audit',
        audit_event: 'scheduler.cancel.audit'
      } satisfies SchedulerActionResponse
    })
    .register(SCHEDULER_METHODS.scheduleAction, (request) => {
      calls.push(SCHEDULER_METHODS.scheduleAction)
      return {
        ok: true,
        job_id: 'job-typed-tooling',
        status: 'scheduled',
        reason: `scheduled typed tooling action job-typed-tooling ${JSON.stringify(request.payload)}`,
        policy_decision_id: 'policy-schedule-action-ui',
        correlation_id: 'corr-schedule-action-ui'
      }
    })
}

function registryWithoutSchedulerManage(): GetRegistryResponse {
  const registry = cloneFixture(gatewayRegistryFixture)
  return {
    ...registry,
    modules: registry.modules.map((module) => module.module !== 'Scheduler'
      ? module
      : {
          ...module,
          methods: module.methods.map((method) => method.bus_topic?.startsWith('Scheduler.') === true && method.method_type === 'manage'
            ? { ...method, required_perms: ['Scheduler.use'] }
            : method)
        })
  }
}

function registryWithoutSchedulerMutations(): GetRegistryResponse {
  const registry = cloneFixture(gatewayRegistryFixture)
  const omittedMethods = new Set<string>([
    SCHEDULER_METHODS.cancel,
    SCHEDULER_METHODS.pause,
    SCHEDULER_METHODS.resume
  ])
  return {
    ...registry,
    modules: registry.modules.map((module) => module.module !== 'Scheduler'
      ? module
      : {
          ...module,
          methods: module.methods.filter((method) => !omittedMethods.has(method.bus_topic ?? ''))
        })
  }
}
