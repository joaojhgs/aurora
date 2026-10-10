import { Badge } from '#components/ui/badge'
import { Volume2 } from 'lucide-react'
import { Card } from './primitives'
import { EmptyState, RouteStateNotice } from './state-surface'

export interface VoiceSettingsSummaryProps {
  readiness: string
  readinessCaption: string
  ready: boolean
  readyLanguages: readonly string[]
  voiceCount: number
  managementState: 'locked' | 'loading' | 'ready' | 'limited'
  loadState: 'loading' | 'ready' | 'error'
}

export function VoiceSettingsSummary({
  readiness,
  readinessCaption,
  ready,
  readyLanguages,
  voiceCount,
  managementState,
  loadState,
}: VoiceSettingsSummaryProps) {
  // The error notice already explains availability and the next step.
  if (loadState === 'error') return null

  return (
    <section aria-label="Spoken reply summary" className="rounded-xl border border-border/70 bg-card p-4 sm:p-5">
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary" aria-hidden>
          <Volume2 size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <h2 className="text-base font-semibold">Spoken replies</h2>
            <Badge variant="secondary" className={ready ? 'text-success' : 'text-muted-foreground'}>{readiness}</Badge>
          </div>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{readinessCaption}</p>
        </div>
      </div>
      {voiceCount > 0 || readyLanguages.length > 0 ? (
        <dl className="mt-4 grid grid-cols-1 gap-3 border-t border-border/60 pt-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs text-muted-foreground">Voices</dt>
            <dd className="mt-1 font-medium">{voiceCount} available</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-xs text-muted-foreground">Languages</dt>
            <dd className="mt-1 break-words font-medium">{readyLanguages.length > 0 ? readyLanguages.join(', ') : 'Choose a voice to start'}</dd>
          </div>
        </dl>
      ) : null}
      {managementState === 'limited' ? <p className="mt-3 text-xs text-muted-foreground">You can view voices. Editing needs access.</p> : null}
    </section>
  )
}

export interface VoiceSettingsNoticesProps {
  loadState: 'loading' | 'ready' | 'error'
  messages: readonly (string | null)[]
}

export function VoiceSettingsNotices({ loadState, messages }: VoiceSettingsNoticesProps) {
  return (
    <>
      {messages.map((message, index) => (
        message ? (() => {
          const productVoiceNoticeCopy = index === 0 && loadState === 'error'
            ? 'Spoken replies unavailable'
            : 'Spoken reply update'
          return (
            <RouteStateNotice
              key={`${index}:${message}`}
              state={index === 0 && loadState === 'error' ? 'error' : 'empty'}
              title={productVoiceNoticeCopy}
              message={message}
            />
          )
        })() : null
      ))}
    </>
  )
}

export interface SpokenReplyVoiceRow {
  voiceId: string
  label: string
  detail: string
  ready: boolean
}

export interface SpokenReplyVoicesCardProps {
  loadState: 'loading' | 'ready' | 'error'
  voiceRows: readonly SpokenReplyVoiceRow[]
}

export function SpokenReplyVoicesCard({ loadState, voiceRows }: SpokenReplyVoicesCardProps) {
  return (
    <Card title="Spoken reply voices" description="Voices Aurora can use for spoken replies.">
      <div className="flex flex-col gap-3">
        {loadState === 'loading' ? <RouteStateNotice state="loading" title="Loading voice choices" message="Loading voices Aurora can use for spoken replies." /> : null}
        {voiceRows.map((voice) => (
          <div key={voice.voiceId} className="flex flex-col gap-2 border-b border-border/60 pb-3 last:border-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="text-sm font-medium">{voice.label}</p>
              <p className="text-xs text-muted-foreground">{voice.detail}</p>
            </div>
            <Badge variant={voice.ready ? 'default' : 'secondary'}>{voice.ready ? 'Ready' : 'Needs setup'}</Badge>
          </div>
        ))}
        {voiceRows.length === 0 && loadState !== 'loading' ? (
          <EmptyState title="No voice choices" message="No voice choices are available yet." variant="inline" />
        ) : null}
      </div>
    </Card>
  )
}

export interface LanguageOptionRow {
  packId: string
  label: string
  detail: string
  ready: boolean
  badge: string
}

export interface LanguageOptionsCardProps {
  managementState: 'locked' | 'loading' | 'ready' | 'limited'
  languageCatalogState: 'locked' | 'loading' | 'ready' | 'limited'
  languageCatalogMessage: string | null
  packRows: readonly LanguageOptionRow[]
}

export function LanguageOptionsCard({
  managementState,
  languageCatalogState,
  languageCatalogMessage,
  packRows,
}: LanguageOptionsCardProps) {
  return (
    <Card title="Language options" description="Languages available through voices Aurora can add.">
      <div className="flex flex-col gap-3">
        {managementState === 'locked' ? (
          <p className="text-sm text-muted-foreground">Show available voices to view language options.</p>
        ) : null}
        {languageCatalogMessage ? (
          <RouteStateNotice state="empty" title="Language options update" message={languageCatalogMessage} />
        ) : null}
        {packRows.map((pack) => (
          <div key={pack.packId} className="flex flex-col gap-2 border-b border-border/60 pb-3 last:border-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="text-sm font-medium">{pack.label}</p>
              <p className="text-xs text-muted-foreground">{pack.detail}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={pack.ready ? 'default' : 'secondary'}>{pack.badge}</Badge>
            </div>
          </div>
        ))}
        {packRows.length === 0 && managementState === 'ready' && languageCatalogState === 'ready' ? (
          <p className="text-sm text-muted-foreground">No language options are available yet.</p>
        ) : null}
      </div>
    </Card>
  )
}
