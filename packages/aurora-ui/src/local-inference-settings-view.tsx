'use client'

import { useEffect, useState } from 'react'
import type { LocalInferenceClient, LocalInferenceModelStatus } from '@aurora/client/local-inference'
import { Button, Card, Switch } from './primitives'
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from '#components/ui/field'
import { Alert, AlertDescription } from '#components/ui/alert'

export interface LocalInferenceSettingsViewProps {
  client: Pick<LocalInferenceClient, 'modelStatus' | 'downloadModel' | 'deleteModel'>
  modelId: string
  enabled: boolean
  onEnabledChange: (enabled: boolean) => Promise<void>
}

/** Model preparation is explicit; leaving Settings does not turn on offline answers. */
export function LocalInferenceSettingsView({ client, modelId, enabled, onEnabledChange }: LocalInferenceSettingsViewProps) {
  const [status, setStatus] = useState<LocalInferenceModelStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  useEffect(() => {
    let current = true
    setStatus(null)
    setNotice(null)
    void client.modelStatus(modelId).then(
      (next) => { if (current) setStatus(next) },
      () => { if (current) setNotice('Offline answers are unavailable on this device right now.') },
    )
    return () => { current = false }
  }, [client, modelId])

  async function perform(action: () => Promise<void>) {
    if (busy) return
    setBusy(true)
    setNotice(null)
    try {
      await action()
    } catch {
      setNotice('This change could not be completed. Try again when this device has enough space and a working connection.')
    } finally {
      setBusy(false)
    }
  }

  const downloaded = status?.state === 'ready'
  const description = busy
    ? 'Preparing offline answers. Keep Aurora open until this finishes.'
    : downloaded
      ? enabled ? 'Offline answers are turned on. Your questions stay on this device when no approved device is connected.' : 'Saved on this device. Turn on offline answers when you want to use them.'
      : 'Download offline answers to use Aurora without internet. The download uses about 563 MB of storage.'

  return (
    <Card title="Assistant on this device" description="Offline answers and local actions use the same conversations and approvals.">
      <FieldGroup>
        <Field orientation="horizontal" data-disabled={busy || (!downloaded && !enabled)}>
          <FieldContent>
            <FieldLabel htmlFor="offline-assistant-enabled">Use offline answers</FieldLabel>
            <FieldDescription>{description}</FieldDescription>
          </FieldContent>
          <Switch id="offline-assistant-enabled" label="Use offline answers" checked={enabled} disabled={busy || (!downloaded && !enabled)} onChange={(value) => { void perform(() => onEnabledChange(value)) }} />
        </Field>
        {notice ? <Alert variant="destructive"><AlertDescription>{notice}</AlertDescription></Alert> : null}
        <div className="flex flex-wrap gap-2">
          {!downloaded ? (
            <Button disabled={busy || !status || status.state === 'incompatible'} onClick={() => { void perform(async () => { setStatus(await client.downloadModel(modelId)) }) }}>
              {busy ? 'Downloading…' : 'Download offline answers'}
            </Button>
          ) : (
            <Button variant="outline" disabled={busy || enabled} onClick={() => { void perform(async () => { setStatus(await client.deleteModel(modelId)) }) }}>
              Remove download
            </Button>
          )}
        </div>
        {downloaded && enabled ? <FieldDescription>Turn off offline answers before removing the download.</FieldDescription> : null}
      </FieldGroup>
    </Card>
  )
}
