import type { AuroraClient } from './client.js'
import { routePath } from './descriptors.js'

export const SCHEDULER_METHODS = {
  listJobs: 'Scheduler.ListJobs',
  schedule: 'Scheduler.Schedule',
  cancel: 'Scheduler.Cancel',
  pause: 'Scheduler.Pause',
  resume: 'Scheduler.Resume'
} as const

export interface SchedulerScheduleJobRequest {
  name: string
  schedule: string
  action: string
  enabled?: boolean
  timezone?: string | null
  source?: string | null
  privacy_class?: string | null
  namespace?: string | null
  owner_peer_id?: string | null
  owner_principal_id?: string | null
  target_selector?: Record<string, unknown> | null
  delegated_permissions?: string[]
  policy_decision_id?: string | null
  delegated_approval_token?: string | null
  correlation_id?: string | null
  caller_peer_id?: string | null
  caller_principal_id?: string | null
}

export interface SchedulerScopedJobRequest {
  job_id: string | number
  namespace?: string | null
  owner_peer_id?: string | null
  owner_principal_id?: string | null
  caller_peer_id?: string | null
  caller_principal_id?: string | null
}

export interface SchedulerListJobsRequest {
  enabled_only?: boolean
  limit?: number
  offset?: number
  namespace?: string | null
  owner_peer_id?: string | null
  owner_principal_id?: string | null
  caller_peer_id?: string | null
  caller_principal_id?: string | null
}

export interface SchedulerActionSupport {
  action: string
  supported: boolean
  status: string
  reason: string | null
}

export interface SchedulerActionResponse {
  ok: boolean
  status: string
  job_id: string
  action: string
  reason: string | null
  audit_event: string | null
}

export interface SchedulerJobInfo {
  job_id: string
  name: string
  schedule: string
  action: string
  enabled: boolean
  next_run: string | null
  last_run: string | null
  status: string | null
  namespace: string
  owner_peer_id: string
  owner_principal_id: string
  target_peer_id: string | null
  target_resource_namespace: string | null
  delegated_permissions: string[]
  policy_decision_id: string | null
  delegated_approval_token_present: boolean
  correlation_id: string | null
  blocked_reason: string | null
  timezone: string | null
  source: string
  failure_count: number
  privacy_class: string
  last_error: string | null
  action_support: SchedulerActionSupport[]
}

export interface SchedulerListJobsResponse {
  jobs: SchedulerJobInfo[]
  total: number
}

export interface NormalizedSchedulerAction {
  action: string
  supported: boolean
  status: string
  reason: string | null
  disabled: boolean
}

export interface NormalizedSchedulerJob extends SchedulerJobInfo {
  actions: Record<string, NormalizedSchedulerAction>
}

export function normalizeSchedulerActionSupport(
  action: SchedulerActionSupport
): NormalizedSchedulerAction {
  return {
    action: action.action,
    supported: action.supported,
    status: action.status,
    reason: action.reason,
    disabled: !action.supported || action.status !== 'supported'
  }
}

export function normalizeSchedulerJob(job: SchedulerJobInfo): NormalizedSchedulerJob {
  return {
    ...job,
    actions: Object.fromEntries(
      job.action_support.map((action) => [
        action.action,
        normalizeSchedulerActionSupport(action)
      ])
    )
  }
}

export class SchedulerClient {
  constructor(private readonly client: AuroraClient) {}

  listJobs(request: SchedulerListJobsRequest = {}): Promise<SchedulerListJobsResponse> {
    return this.client.request<SchedulerListJobsResponse, SchedulerListJobsRequest>(
      SCHEDULER_METHODS.listJobs,
      request,
      { path: routePath('Scheduler', 'ListJobs') }
    )
  }

  async listNormalizedJobs(request: SchedulerListJobsRequest = {}): Promise<NormalizedSchedulerJob[]> {
    const response = await this.listJobs(request)
    return response.jobs.map(normalizeSchedulerJob)
  }

  schedule(payload: SchedulerScheduleJobRequest): Promise<unknown> {
    return this.client.request<unknown, SchedulerScheduleJobRequest>(
      SCHEDULER_METHODS.schedule,
      payload,
      { path: routePath('Scheduler', 'Schedule') }
    )
  }

  cancel(payload: SchedulerScopedJobRequest): Promise<unknown> {
    return this.client.request<unknown, SchedulerScopedJobRequest>(
      SCHEDULER_METHODS.cancel,
      payload,
      { path: routePath('Scheduler', 'Cancel') }
    )
  }

  pause(payload: SchedulerScopedJobRequest): Promise<SchedulerActionResponse> {
    return this.client.request<SchedulerActionResponse, SchedulerScopedJobRequest>(
      SCHEDULER_METHODS.pause,
      payload,
      { path: routePath('Scheduler', 'Pause') }
    )
  }

  resume(payload: SchedulerScopedJobRequest): Promise<SchedulerActionResponse> {
    return this.client.request<SchedulerActionResponse, SchedulerScopedJobRequest>(
      SCHEDULER_METHODS.resume,
      payload,
      { path: routePath('Scheduler', 'Resume') }
    )
  }
}
