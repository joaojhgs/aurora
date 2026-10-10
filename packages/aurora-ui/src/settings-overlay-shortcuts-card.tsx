'use client'

import { useEffect, useRef, useState } from 'react'
import { Keyboard } from 'lucide-react'
import type { AuroraDesktopOverlaySave, AuroraRuntimeProfileV2 } from './runtime-profile'
import { normalizeDesktopOverlayHotkey, resolveDesktopOverlayPreferences } from './runtime-profile'
import { Card, Switch } from './primitives'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '#components/ui/field'
import { Input } from '#components/ui/input'
import { PanelTitle } from './settings-panel-title'

export function OverlayShortcutsCard({
  runtimeProfile,
  onDesktopOverlayConfirmed,
}: {
  runtimeProfile: AuroraRuntimeProfileV2 | null | undefined
  onDesktopOverlayConfirmed?: AuroraDesktopOverlaySave | undefined
}) {
  const stored = resolveDesktopOverlayPreferences(runtimeProfile?.localNode.desktopOverlay)
  const [enabled, setEnabled] = useState(stored.enabled)
  const [voiceEnabled, setVoiceEnabled] = useState(stored.voiceEnabled)
  const [hotkeyDraft, setHotkeyDraft] = useState(stored.textHotkey)
  const [hideAfterSeconds, setHideAfterSeconds] = useState(String(stored.autoCloseDelayMs / 1000))
  const [message, setMessage] = useState<string | null>(null)
  const [savingOverlay, setSavingOverlay] = useState(false)
  const savingOverlayRef = useRef(false)

  useEffect(() => {
    const next = resolveDesktopOverlayPreferences(runtimeProfile?.localNode.desktopOverlay)
    setEnabled(next.enabled)
    setVoiceEnabled(next.voiceEnabled)
    setHotkeyDraft(next.textHotkey)
    setHideAfterSeconds(String(next.autoCloseDelayMs / 1000))
  }, [runtimeProfile?.localNode.desktopOverlay])

  async function persist(next: Partial<{
    enabled: boolean
    voiceEnabled: boolean
    textHotkey: string
    autoCloseDelayMs: number
  }>): Promise<void> {
    if (!onDesktopOverlayConfirmed || savingOverlayRef.current) return
    const parsedDelaySeconds = Number(hideAfterSeconds)
    const overlay = resolveDesktopOverlayPreferences({
      enabled,
      voiceEnabled,
      textHotkey: normalizeDesktopOverlayHotkey(hotkeyDraft) ?? stored.textHotkey,
      autoCloseDelayMs: Number.isFinite(parsedDelaySeconds)
        ? Math.round(parsedDelaySeconds * 1000)
        : stored.autoCloseDelayMs,
      ...next,
    })
    savingOverlayRef.current = true
    setSavingOverlay(true)
    try {
      await onDesktopOverlayConfirmed(overlay)
      setEnabled(overlay.enabled)
      setVoiceEnabled(overlay.voiceEnabled)
      setHotkeyDraft(overlay.textHotkey)
      setHideAfterSeconds(String(overlay.autoCloseDelayMs / 1000))
      setMessage(null)
    } catch {
      const restored = resolveDesktopOverlayPreferences(runtimeProfile?.localNode.desktopOverlay)
      setEnabled(restored.enabled)
      setVoiceEnabled(restored.voiceEnabled)
      setHotkeyDraft(restored.textHotkey)
      setHideAfterSeconds(String(restored.autoCloseDelayMs / 1000))
      setMessage('Those overlay settings were not saved. Finish setting up this device, then try again.')
    } finally {
      savingOverlayRef.current = false
      setSavingOverlay(false)
    }
  }

  return (
    <Card>
      <PanelTitle
        icon={<Keyboard size={18} aria-hidden />}
        title="Overlay & shortcuts"
        description="Show Aurora over other windows and use a keyboard shortcut."
        id="overlay-shortcuts-title"
      />
      <FieldGroup>
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-medium">Show overlay</p>
            <p className="text-xs text-muted-foreground">Lets Aurora appear over other windows.</p>
          </div>
          <Switch
            id="desktop-overlay-enabled"
            label="Show overlay"
            checked={enabled}
            disabled={!onDesktopOverlayConfirmed || savingOverlay}
            disabledReason={savingOverlay ? 'Overlay settings are still saving.' : undefined}
            onChange={(checked) => {
              setEnabled(checked)
              void persist({ enabled: checked })
            }}
          />
        </div>
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-medium">Show while listening</p>
            <p className="text-xs text-muted-foreground">Shows the overlay when Aurora is listening.</p>
          </div>
          <Switch
            id="desktop-overlay-voice"
            label="Show while listening"
            checked={voiceEnabled}
            disabled={!enabled || !onDesktopOverlayConfirmed || savingOverlay}
            disabledReason={savingOverlay ? 'Overlay settings are still saving.' : undefined}
            onChange={(checked) => {
              setVoiceEnabled(checked)
              void persist({ voiceEnabled: checked })
            }}
          />
        </div>
        <Field>
          <FieldLabel htmlFor="desktop-overlay-hotkey">Keyboard shortcut</FieldLabel>
          <Input
            id="desktop-overlay-hotkey"
            value={hotkeyDraft}
            aria-label="Keyboard shortcut"
            disabled={!enabled || !onDesktopOverlayConfirmed || savingOverlay}
            onChange={(event) => setHotkeyDraft(event.target.value)}
            onBlur={() => {
              const textHotkey = normalizeDesktopOverlayHotkey(hotkeyDraft)
              if (!textHotkey) {
                setHotkeyDraft(stored.textHotkey)
                setMessage('Use Ctrl, Command, Alt, or Shift plus a letter. Example: Ctrl+K.')
                return
              }
              setHotkeyDraft(textHotkey)
              void persist({ textHotkey })
            }}
          />
          <FieldDescription>Use Ctrl, Command, Alt, or Shift plus a letter.</FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="desktop-overlay-hide-after">Hide after (seconds)</FieldLabel>
          <Input
            id="desktop-overlay-hide-after"
            type="number"
            min={0}
            max={60}
            step={0.1}
            value={hideAfterSeconds}
            aria-label="Hide overlay after seconds"
            disabled={!enabled || !onDesktopOverlayConfirmed || savingOverlay}
            onChange={(event) => setHideAfterSeconds(event.target.value)}
            onBlur={() => {
              const seconds = Number(hideAfterSeconds)
              if (!Number.isFinite(seconds) || seconds < 0 || seconds > 60) {
                setHideAfterSeconds(String(stored.autoCloseDelayMs / 1000))
                setMessage('Hide after must be between 0 and 60 seconds.')
                return
              }
              void persist({ autoCloseDelayMs: Math.round(seconds * 1000) })
            }}
          />
          <FieldDescription>How long the overlay stays after a short reply.</FieldDescription>
        </Field>
        {message ? (
          <p role="status" className="text-sm text-muted-foreground">{message}</p>
        ) : null}
      </FieldGroup>
    </Card>
  )
}

