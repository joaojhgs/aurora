'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AuroraClient } from '@aurora/client'
import { Button, Card, StatStrip } from './primitives'
import { safeErrorCopy } from './product-copy'
import { findForbiddenProductionCopyTerms } from './product-copy-forbidden-terms'
import { Badge } from '#components/ui/badge'

type SpeechLanguage = 'de' | 'en' | 'es' | 'fr' | 'it' | 'ja' | 'ko' | 'pt' | 'zh'
type TtsModelStatus = 'degraded' | 'error' | 'loading' | 'ready' | 'unavailable'
type TtsVoiceKind = 'cloned' | 'standard'
type InstallStatus = 'installed' | 'not_found' | 'queued' | 'rejected' | 'revision_conflict' | 'unchanged'

interface TtsResidentLanguagePack {
  pack_id: string
  ready_languages?: SpeechLanguage[] | undefined
}

interface TtsCapabilities {
  ready?: boolean | undefined
  model_status?: TtsModelStatus | undefined
  ready_languages?: SpeechLanguage[] | undefined
  supported_language_pack_ids?: string[] | undefined
  installed_language_pack_ids?: string[] | undefined
  resident_language_packs?: TtsResidentLanguagePack[] | undefined
}

interface TtsVoice {
  voice_id: string
  display_name: string
  ready?: boolean | undefined
  compatible_language_pack_ids?: string[] | undefined
}

interface TtsVoiceProfile {
  voice_id: string
  display_name: string
  revision: string
  kind: TtsVoiceKind
  enabled?: boolean | undefined
  installed?: boolean | undefined
  ready?: boolean | undefined
  compatible_language_pack_ids?: string[] | undefined
}

interface VoiceSettingsState {
  capabilities: TtsCapabilities | null
  voices: TtsVoice[]
  profiles: TtsVoiceProfile[]
  loadState: 'loading' | 'ready' | 'error'
  managementState: 'loading' | 'ready' | 'limited'
  message: string | null
}

const initialVoiceSettingsState: VoiceSettingsState = {
  capabilities: null,
  voices: [],
  profiles: [],
  loadState: 'loading',
  managementState: 'loading',
  message: null
}

export interface VoiceSettingsViewProps {
  client: AuroraClient
}

export function VoiceSettingsView({ client }: VoiceSettingsViewProps) {
  const [state, setState] = useState<VoiceSettingsState>(initialVoiceSettingsState)
  const [installingVoiceId, setInstallingVoiceId] = useState<string | null>(null)
  const [installMessage, setInstallMessage] = useState<string | null>(null)

  const refresh = useCallback(() => {
    let active = true
    setState(initialVoiceSettingsState)

    void Promise.all([
      client.speech.tts.getCapabilities(),
      client.speech.tts.listVoices(),
      client.speech.tts.listVoiceProfiles({ include_unavailable: true })
    ]).then(([capabilitiesResult, voicesResult, profilesResult]) => {
      if (!active) return
      const capabilities = capabilitiesResult.ok ? capabilitiesResult.data.capabilities as TtsCapabilities : null
      const voices = voicesResult.ok ? (voicesResult.data.voices as TtsVoice[] | undefined) ?? [] : []
      const profiles = profilesResult.ok ? (profilesResult.data.profiles as TtsVoiceProfile[] | undefined) ?? [] : []
      const readError = !capabilitiesResult.ok || !voicesResult.ok
      const readProblem = capabilitiesResult.ok
        ? voicesResult.ok ? null : voicesResult.error
        : capabilitiesResult.error
      setState({
        capabilities,
        voices,
        profiles,
        loadState: readError ? 'error' : 'ready',
        managementState: profilesResult.ok ? 'ready' : 'limited',
        message: readError
          ? productVoiceSettingsErrorCopy(readProblem)
          : profilesResult.ok
            ? null
            : voiceSettingsManagementCopy(profilesResult.error)
      })
    }, (error: unknown) => {
      if (!active) return
      setState({
        ...initialVoiceSettingsState,
        loadState: 'error',
        managementState: 'limited',
        message: productVoiceSettingsErrorCopy(error)
      })
    })

    return () => {
      active = false
    }
  }, [client])

  useEffect(() => refresh(), [refresh])

  const managedProfiles = useMemo(() => state.profiles.map((profile, index) => toManagedVoice(profile, index, state.capabilities)), [state.profiles, state.capabilities])
  const voiceRows = useMemo(() => state.voices.map((voice, index) => toVoiceRow(voice, index, state.capabilities)), [state.voices, state.capabilities])
  const readyLanguages = useMemo(() => languageList(state.capabilities?.ready_languages), [state.capabilities])
  const canShowInstall = state.managementState === 'ready'

  async function installProfile(profile: ManagedVoice) {
    if (!profile.installable) return
    setInstallingVoiceId(profile.voiceId)
    setInstallMessage(null)
    try {
      const result = await client.speech.tts.installVoiceProfile({
        voice_id: profile.voiceId,
        expected_revision: profile.revision,
        operation_id: `voice-install-${Date.now().toString(36)}`
      })
      if (!result.ok) {
        setInstallMessage(productVoiceSettingsErrorCopy(result.error, 'Voice was not added. Try again.'))
        return
      }
      setInstallMessage(installOutcomeCopy(result.data.status))
      refresh()
    } catch (error) {
      setInstallMessage(productVoiceSettingsErrorCopy(error, 'Voice was not added. Try again.'))
    } finally {
      setInstallingVoiceId(null)
    }
  }

  return (
    <div className="flex flex-col gap-4 py-4">
      <StatStrip
        ariaLabel="Spoken reply summary"
        items={[
          {
            label: 'Readiness',
            value: readinessLabel(state.capabilities),
            caption: state.capabilities?.ready ? 'Spoken replies can use saved voices.' : 'Spoken replies need attention.',
            tone: state.capabilities?.ready ? 'success' : 'warning'
          },
          {
            label: 'Languages',
            value: readyLanguages.length > 0 ? readyLanguages.join(', ') : 'None ready',
            caption: readyLanguages.length > 0 ? 'Available for spoken replies.' : 'Add a voice to start.'
          },
          {
            label: 'Voices',
            value: String(state.voices.length),
            caption: state.managementState === 'limited' ? 'Voice choices loaded. Editing needs access.' : 'Voice choices available.'
          }
        ]}
      />

      {state.message ? (
        <p role={state.loadState === 'error' ? 'alert' : 'status'} className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm">
          {state.message}
        </p>
      ) : null}
      {installMessage ? (
        <p role="status" className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm">
          {installMessage}
        </p>
      ) : null}

      <Card title="Spoken reply voices" description="Voices Aurora can use for spoken replies.">
        <div className="flex flex-col gap-3">
          {state.loadState === 'loading' ? <p className="text-sm text-muted-foreground">Loading voice choices.</p> : null}
          {voiceRows.map((voice) => (
            <div key={voice.voiceId} className="flex flex-col gap-2 border-b border-border/60 pb-3 last:border-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="text-sm font-medium">{voice.label}</p>
                <p className="text-xs text-muted-foreground">{voice.detail}</p>
              </div>
              <Badge variant={voice.ready ? 'default' : 'secondary'}>{voice.ready ? 'Ready' : 'Needs setup'}</Badge>
            </div>
          ))}
          {voiceRows.length === 0 && state.loadState !== 'loading' ? (
            <p className="text-sm text-muted-foreground">No voice choices are available yet.</p>
          ) : null}
        </div>
      </Card>

      <Card title="Saved voices" description="Voices kept on this device.">
        <div className="flex flex-col gap-3">
          {state.managementState === 'loading' ? <p className="text-sm text-muted-foreground">Loading saved voices.</p> : null}
          {state.managementState === 'limited' ? (
            <p className="text-sm text-muted-foreground">Saved voices could not be loaded. Review access and try again.</p>
          ) : null}
          {managedProfiles.map((profile) => (
            <div key={profile.voiceId} className="flex flex-col gap-2 border-b border-border/60 pb-3 last:border-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="text-sm font-medium">{profile.label}</p>
                <p className="text-xs text-muted-foreground">{profile.detail}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={profile.ready ? 'default' : 'secondary'}>{profile.badge}</Badge>
                {canShowInstall && profile.installable ? (
                  <Button
                    variant="outline"
                    className="h-8 px-3 text-xs"
                    onClick={() => void installProfile(profile)}
                    disabled={installingVoiceId === profile.voiceId}
                  >
                    {installingVoiceId === profile.voiceId ? 'Adding' : 'Add voice'}
                  </Button>
                ) : null}
              </div>
            </div>
          ))}
          {managedProfiles.length === 0 && state.managementState === 'ready' ? (
            <p className="text-sm text-muted-foreground">No saved voices are available yet.</p>
          ) : null}
        </div>
      </Card>
    </div>
  )
}

interface VoiceRow {
  voiceId: string
  label: string
  detail: string
  ready: boolean
}

interface ManagedVoice extends VoiceRow {
  revision: string
  installable: boolean
  badge: string
}

function toVoiceRow(voice: TtsVoice, index: number, capabilities: TtsCapabilities | null): VoiceRow {
  const languages = languageListForPacks(capabilities, voice.compatible_language_pack_ids)
  return {
    voiceId: voice.voice_id,
    label: safeVoiceText(voice.display_name, `Voice option ${index + 1}`),
    detail: languages.length > 0 ? `Works with ${languages.join(', ')}.` : 'Language details are unavailable.',
    ready: voice.ready === true
  }
}

function toManagedVoice(profile: TtsVoiceProfile, index: number, capabilities: TtsCapabilities | null): ManagedVoice {
  const languages = languageListForPacks(capabilities, profile.compatible_language_pack_ids)
  const installed = profile.installed === true
  const ready = profile.ready === true
  return {
    voiceId: profile.voice_id,
    revision: profile.revision,
    label: safeVoiceText(profile.display_name, `Saved voice ${index + 1}`),
    detail: managedVoiceDetail(installed, ready, languages),
    ready,
    installable: canInstallProfile(profile, capabilities),
    badge: ready ? 'Ready' : installed ? 'Needs setup' : 'Available to add'
  }
}

function canInstallProfile(profile: TtsVoiceProfile, capabilities: TtsCapabilities | null): boolean {
  if (profile.installed === true) return false
  if (profile.enabled === false) return false
  if (profile.kind !== 'standard') return false
  if (!capabilities) return false
  const supportedPacks = new Set([...(capabilities.supported_language_pack_ids ?? []), ...(capabilities.installed_language_pack_ids ?? [])])
  const compatible = profile.compatible_language_pack_ids ?? []
  return compatible.length === 0 || compatible.some((packId) => supportedPacks.has(packId))
}

function managedVoiceDetail(installed: boolean, ready: boolean, languages: string[]): string {
  const languageCopy = languages.length > 0 ? ` ${languages.join(', ')}.` : ''
  if (ready) return `Ready for spoken replies.${languageCopy}`
  if (installed) return `Saved but not ready yet.${languageCopy}`
  return `Can be added to this device.${languageCopy}`
}

function readinessLabel(capabilities: TtsCapabilities | null): string {
  if (!capabilities) return 'Checking'
  if (capabilities.ready) return 'Ready'
  if (capabilities.model_status === 'loading') return 'Starting'
  return 'Needs setup'
}

function languageList(values: readonly string[] | null | undefined): string[] {
  const labels: Record<string, string> = {
    de: 'German',
    en: 'English',
    es: 'Spanish',
    fr: 'French',
    it: 'Italian',
    ja: 'Japanese',
    ko: 'Korean',
    pt: 'Portuguese',
    zh: 'Chinese'
  }
  return [...new Set(values ?? [])].map((value) => labels[value] ?? null).filter((value): value is string => Boolean(value))
}

function languageListForPacks(capabilities: TtsCapabilities | null, packIds: readonly string[] | null | undefined): string[] {
  if (!capabilities || !packIds || packIds.length === 0) return []
  const packs = new Set(packIds)
  return languageList(
    capabilities.resident_language_packs
      ?.filter((pack) => packs.has(pack.pack_id))
      .flatMap((pack) => pack.ready_languages ?? [])
  )
}

function safeVoiceText(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const compact = value.trim().replace(/\s+/gu, ' ')
  if (!compact || compact.length > 80) return fallback
  if (findForbiddenProductionCopyTerms(compact).length > 0) return fallback
  if (/^(?:standard|clone):/iu.test(compact)) return fallback
  if (/[a-z0-9]+(?:[._:-][a-z0-9]+){2,}/iu.test(compact)) return fallback
  return compact
}

function productVoiceSettingsErrorCopy(error: unknown, backup = 'Voice settings could not be loaded. Try again.'): string {
  const copy = safeErrorCopy(error)
  if (!copy.title) return backup
  if (!copy.action || copy.title.toLowerCase().includes(copy.action.toLowerCase())) return copy.title
  return `${copy.title}. ${copy.action}.`
}

function voiceSettingsManagementCopy(error: unknown): string {
  const copy = safeErrorCopy(error)
  if (copy.title.includes('Permission')) return 'Saved voices need access before they can be shown.'
  if (copy.title.includes('cannot use')) return 'Saved voices are not available on this Aurora version.'
  return 'Saved voices could not be loaded. Review access and try again.'
}

function installOutcomeCopy(status: InstallStatus): string {
  if (status === 'installed') return 'Voice added.'
  if (status === 'queued') return 'Voice will be added soon.'
  if (status === 'unchanged') return 'Voice is already saved.'
  if (status === 'revision_conflict') return 'Voice changed before it could be added. Try again.'
  if (status === 'not_found') return 'Voice is no longer available.'
  return 'Voice was not added. Try again.'
}
