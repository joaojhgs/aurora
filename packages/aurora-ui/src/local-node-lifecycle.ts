export interface LocalNodeLifecycleHost {
  suspend(reason?: string): void | Promise<void>
  resume(): void | Promise<void>
  renew(): void | Promise<void>
}

export interface LocalNodeLifecycleOptions {
  readonly host: LocalNodeLifecycleHost
  readonly document?: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>
  readonly window?: Pick<Window, 'addEventListener' | 'removeEventListener'>
  readonly renewMs?: number
  readonly setInterval?: typeof globalThis.setInterval
  readonly clearInterval?: typeof globalThis.clearInterval
}

const DEFAULT_RENEW_MS = 20_000

export class LocalNodeLifecycleController {
  private readonly host: LocalNodeLifecycleHost
  private readonly document: LocalNodeLifecycleOptions['document']
  private readonly windowTarget: LocalNodeLifecycleOptions['window']
  private readonly renewMs: number
  private readonly setIntervalFn: typeof globalThis.setInterval
  private readonly clearIntervalFn: typeof globalThis.clearInterval
  private interval: ReturnType<typeof setInterval> | null = null
  private started = false

  constructor(options: LocalNodeLifecycleOptions) {
    this.host = options.host
    this.document = options.document ?? (typeof document === 'undefined' ? undefined : document)
    this.windowTarget = options.window ?? (typeof window === 'undefined' ? undefined : window)
    this.renewMs = options.renewMs ?? DEFAULT_RENEW_MS
    this.setIntervalFn = options.setInterval ?? globalThis.setInterval
    this.clearIntervalFn = options.clearInterval ?? globalThis.clearInterval
  }

  start(): void {
    if (this.started) return
    this.started = true
    this.document?.addEventListener('visibilitychange', this.handleVisibilityChange)
    this.windowTarget?.addEventListener('pagehide', this.handlePageHide)
    this.windowTarget?.addEventListener('pageshow', this.handlePageShow)
    this.document?.addEventListener('freeze', this.handleFreeze as EventListener)
    this.windowTarget?.addEventListener('blur', this.handleBlur)
    if (this.document?.visibilityState === 'hidden') this.stopRenewal()
    else {
      void this.resumeAndAnnounceLease().catch(() => undefined)
      this.startRenewal()
    }
  }

  stop(): void {
    if (!this.started) return
    this.started = false
    this.stopRenewal()
    this.document?.removeEventListener('visibilitychange', this.handleVisibilityChange)
    this.windowTarget?.removeEventListener('pagehide', this.handlePageHide)
    this.windowTarget?.removeEventListener('pageshow', this.handlePageShow)
    this.document?.removeEventListener('freeze', this.handleFreeze as EventListener)
    this.windowTarget?.removeEventListener('blur', this.handleBlur)
  }

  private readonly handleVisibilityChange = (): void => {
    if (this.document?.visibilityState === 'hidden') {
      this.stopRenewal()
      return
    }
    void this.resumeAndAnnounceLease().catch(() => undefined)
    this.startRenewal()
  }

  private readonly handlePageHide = (): void => {
    this.stopRenewal()
    void Promise.resolve(this.host.suspend('page_hidden')).catch(() => undefined)
  }

  private readonly handleFreeze = (): void => {
    this.stopRenewal()
    void Promise.resolve(this.host.suspend('page_frozen')).catch(() => undefined)
  }

  private readonly handlePageShow = (): void => {
    void this.resumeAndAnnounceLease().catch(() => undefined)
    this.startRenewal()
  }

  private readonly handleBlur = (): void => {
    // Focus changes release focused capture elsewhere; provider availability is lease-based.
  }

  private startRenewal(): void {
    if (this.interval !== null) return
    this.interval = this.setIntervalFn(() => {
      void Promise.resolve(this.host.renew()).catch(() => undefined)
    }, this.renewMs)
  }

  private stopRenewal(): void {
    if (this.interval === null) return
    this.clearIntervalFn(this.interval)
    this.interval = null
  }

  private async resumeAndAnnounceLease(): Promise<void> {
    await this.host.resume()
  }
}
