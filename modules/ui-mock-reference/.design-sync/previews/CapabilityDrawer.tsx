'use client'

import { useState } from 'react'
import { CapabilityDrawer } from '@aurora/ui-mock-reference'

export function Degraded() {
  const [open, setOpen] = useState(true)
  return (
    <div className="h-[520px] w-full rounded-lg bg-background text-foreground">
      <CapabilityDrawer
        open={open}
        onOpenChange={setOpen}
        feature={{
          id: 'assistant.voice.ptt',
          label: 'Push-to-talk voice',
          category: 'assistant',
          state: 'degraded',
          privacyClass: 'raw-audio',
          requiredServices: ['STT', 'TTS'],
          requiredMethods: ['Transcription.Transcribe', 'TTS.Synthesize', 'STTCoordinator.Listen (internal-only)'],
          requiredPermissions: ['Transcription.use', 'TTS.use', 'Orchestrator.use'],
          backendCoverage: 'partial',
          transportNotes: ['Server web captures client audio; local desktop may use STTCoordinator internal bus controls.'],
          missing: ['TTS healthy'],
          userActions: ['request_microphone'],
          note: 'TTS is warming up; replies will be text-only until it recovers.',
        }}
      />
    </div>
  )
}

export function Available() {
  const [open, setOpen] = useState(true)
  return (
    <div className="h-[520px] w-full rounded-lg bg-background text-foreground">
      <CapabilityDrawer
        open={open}
        onOpenChange={setOpen}
        feature={{
          id: 'assistant.chat.text',
          label: 'Text chat',
          category: 'assistant',
          state: 'available',
          privacyClass: 'personal',
          requiredServices: ['Orchestrator'],
          requiredMethods: ['Orchestrator.ExternalUserInput'],
          requiredPermissions: ['Orchestrator.use'],
          backendCoverage: 'implemented',
          transportNotes: ['HTTP uses generated POST route; local desktop can use internal bus path.'],
        }}
      />
    </div>
  )
}
