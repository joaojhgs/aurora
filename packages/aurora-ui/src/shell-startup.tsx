'use client'

type ShellStartupCenteredPageProps = {
  dataAttribute: string
  dataValue: string
  ariaBusy?: boolean
  ariaLabel?: string
  showIndicator?: boolean
  title: string
  description?: string
  action?: {
    label: string
    onClick: () => void
  }
}

function ShellStartupCenteredPage({
  dataAttribute,
  dataValue,
  ariaBusy,
  ariaLabel,
  showIndicator = false,
  title,
  description,
  action,
}: ShellStartupCenteredPageProps) {
  const dataProps = { [dataAttribute]: dataValue }
  return (
    <main
      {...dataProps}
      {...(ariaBusy ? { 'aria-busy': true } : {})}
      {...(ariaLabel ? { 'aria-label': ariaLabel } : {})}
      className="grid min-h-dvh place-items-center bg-background px-6 text-foreground"
    >
      <div
        className={
          action
            ? 'flex max-w-sm flex-col items-center gap-3 text-center'
            : 'flex flex-col items-center gap-3 text-center'
        }
      >
        {showIndicator ? (
          <div
            aria-hidden
            className="size-8 animate-pulse rounded-xl bg-primary/20"
          />
        ) : null}
        <p className="text-sm font-medium">{title}</p>
        {description ? (
          <p className="text-xs text-muted-foreground">{description}</p>
        ) : null}
        {action ? (
          <button
            type="button"
            className="rounded-lg border border-border px-3 py-2 text-sm"
            onClick={action.onClick}
          >
            {action.label}
          </button>
        ) : null}
      </div>
    </main>
  )
}

export function BrowserShellBootScreen() {
  return (
    <ShellStartupCenteredPage
      dataAttribute="data-browser-shell-boot"
      dataValue="true"
      ariaBusy
      ariaLabel="Loading Aurora"
      showIndicator
      title="Loading Aurora…"
    />
  )
}

export function BrowserShellStartError({ onRetry }: { onRetry: () => void }) {
  return (
    <ShellStartupCenteredPage
      dataAttribute="data-browser-shell-start"
      dataValue="failed"
      title="Aurora could not start on this device."
      description="Your saved connection is safe. Try opening Aurora again."
      action={{ label: 'Try again', onClick: onRetry }}
    />
  )
}
