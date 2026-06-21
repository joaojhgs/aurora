import { describe, expect, it } from 'vitest'

import {
  AuroraClient,
  MockAuroraTransport,
  SCHEDULER_METHODS,
  normalizeSchedulerActionSupport,
  normalizeSchedulerJob,
  type SchedulerJobInfo
} from '../src/index.js'
import type { AuroraTransportRequest } from '../src/transport.js'

const schedulerJob: SchedulerJobInfo = {
  job_id: 'job-1',
  name: 'Morning summary',
  schedule: '0 8 * * *',
  action: 'Orchestrator.ProcessUserInput',
  enabled: true,
  next_run: '2026-06-22T08:00:00Z',
  last_run: null,
  status: 'scheduled',
  namespace: 'home',
  owner_peer_id: 'peer-local',
  owner_principal_id: 'principal-admin',
  target_peer_id: null,
  target_resource_namespace: null,
  delegated_permissions: ['Scheduler.use'],
  policy_decision_id: 'policy-1',
  delegated_approval_token_present: false,
  correlation_id: 'corr-1',
  blocked_reason: null,
  timezone: 'America/New_York',
  source: 'admin',
  failure_count: 2,
  privacy_class: 'sensitive',
  last_error: 'last failure',
  action_support: [
    {
      action: 'cancel',
      supported: true,
      status: 'supported',
      reason: null
    },
    {
      action: 'pause',
      supported: false,
      status: 'unsupported',
      reason: 'scheduler_pause_resume_unsupported'
    },
    {
      action: 'resume',
      supported: false,
      status: 'unsupported',
      reason: 'scheduler_pause_resume_unsupported'
    }
  ]
}

describe('SchedulerClient', () => {
  it('normalizes scheduler jobs and disabled admin actions', () => {
    const normalized = normalizeSchedulerJob(schedulerJob)

    expect(normalized.timezone).toBe('America/New_York')
    expect(normalized.source).toBe('admin')
    expect(normalized.failure_count).toBe(2)
    expect(normalized.privacy_class).toBe('sensitive')
    expect(normalized.last_error).toBe('last failure')
    expect(normalized.actions.cancel).toEqual(
      expect.objectContaining({
        supported: true,
        disabled: false
      })
    )
    expect(normalized.actions.pause).toEqual(
      expect.objectContaining({
        supported: false,
        disabled: true,
        status: 'unsupported',
        reason: 'scheduler_pause_resume_unsupported'
      })
    )
  })

  it('marks non-supported action status as disabled even when supported is true', () => {
    expect(
      normalizeSchedulerActionSupport({
        action: 'pause',
        supported: true,
        status: 'degraded',
        reason: 'pending_backend_support'
      })
    ).toEqual({
      action: 'pause',
      supported: true,
      status: 'degraded',
      reason: 'pending_backend_support',
      disabled: true
    })
  })

  it('lists normalized jobs through the Scheduler.ListJobs contract route', async () => {
    const requests: AuroraTransportRequest[] = []
    const transport = MockAuroraTransport.empty().register('Scheduler.ListJobs', (request) => {
      requests.push(request)
      return {
        jobs: [schedulerJob],
        total: 1
      }
    })
    const client = new AuroraClient({ transport })

    const jobs = await client.scheduler.listNormalizedJobs({
      namespace: 'home',
      caller_peer_id: 'peer-local',
      caller_principal_id: 'principal-admin'
    })

    expect(requests).toEqual([
      expect.objectContaining({
        method: SCHEDULER_METHODS.listJobs,
        busTopic: SCHEDULER_METHODS.listJobs,
        path: '/api/Scheduler/ListJobs',
        payload: expect.objectContaining({
          namespace: 'home',
          caller_peer_id: 'peer-local',
          caller_principal_id: 'principal-admin'
        })
      })
    ])
    expect(jobs).toHaveLength(1)
    expect(jobs[0]?.actions.pause).toEqual(
      expect.objectContaining({
        disabled: true
      })
    )
    expect(jobs[0]?.actions.resume).toEqual(
      expect.objectContaining({
        reason: 'scheduler_pause_resume_unsupported'
      })
    )
  })

  it('calls degraded pause and resume management routes without hiding response status', async () => {
    const requests: AuroraTransportRequest[] = []
    const transport = MockAuroraTransport.empty()
      .register('Scheduler.Pause', (request) => {
        requests.push(request)
        return {
          ok: false,
          status: 'unsupported',
          job_id: 'job-1',
          action: 'pause',
          reason: 'scheduler_pause_resume_unsupported',
          audit_event: 'scheduler.pause.unsupported'
        }
      })
      .register('Scheduler.Resume', (request) => {
        requests.push(request)
        return {
          ok: false,
          status: 'unsupported',
          job_id: 'job-1',
          action: 'resume',
          reason: 'scheduler_pause_resume_unsupported',
          audit_event: 'scheduler.resume.unsupported'
        }
      })
    const client = new AuroraClient({ transport })

    await expect(
      client.scheduler.pause({
        job_id: 'job-1',
        namespace: 'home',
        caller_peer_id: 'peer-local',
        caller_principal_id: 'principal-admin'
      })
    ).resolves.toEqual(
      expect.objectContaining({
        ok: false,
        status: 'unsupported',
        action: 'pause',
        audit_event: 'scheduler.pause.unsupported'
      })
    )
    await expect(
      client.scheduler.resume({
        job_id: 'job-1',
        namespace: 'home',
        caller_peer_id: 'peer-local',
        caller_principal_id: 'principal-admin'
      })
    ).resolves.toEqual(
      expect.objectContaining({
        ok: false,
        status: 'unsupported',
        action: 'resume',
        audit_event: 'scheduler.resume.unsupported'
      })
    )

    expect(requests).toEqual([
      expect.objectContaining({
        method: SCHEDULER_METHODS.pause,
        path: '/api/Scheduler/Pause',
        payload: expect.objectContaining({ job_id: 'job-1', namespace: 'home' })
      }),
      expect.objectContaining({
        method: SCHEDULER_METHODS.resume,
        path: '/api/Scheduler/Resume',
        payload: expect.objectContaining({ job_id: 'job-1', namespace: 'home' })
      })
    ])
  })
})
