'use client'

import { Bell, Fingerprint, Lock, Mic, Moon, Network, ShieldCheck, Smartphone, Volume2, WandSparkles } from 'lucide-react'
import { PageHeader } from '@/components/aurora/page-header'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { CapabilityStateBadge, PrivacyBadge } from '@/components/aurora/status-badges'

const permissions = [
  { label: 'Microphone', icon: Mic, state: 'available' as const, detail: 'Push-to-talk and voice sessions can start.' },
  { label: 'Notifications', icon: Bell, state: 'available' as const, detail: 'Background status and reminders enabled.' },
  { label: 'Local network', icon: Network, state: 'needs_native_permission' as const, detail: 'Needed for peer discovery and local gateway.' },
  { label: 'Biometrics', icon: Fingerprint, state: 'degraded' as const, detail: 'Available for admin confirmation, not required.' },
]

const androidStates = [
  ['Tauri Kotlin plugin', 'loaded', 'available'],
  ['Package qualification', 'manifest/service prototype pending', 'degraded'],
  ['ROLE_ASSISTANT available', 'true on Android 15 ATD', 'available'],
  ['Role held', 'false', 'needs_native_permission'],
  ['Requestable', 'blocked until package qualifies', 'degraded'],
  ['Fallback-only entrypoints', 'app · notification · widget · tile · share', 'available'],
] as const

const iosStates = [
  ['App Intents', 'planned', 'degraded'],
  ['Shortcuts', 'supported path', 'available'],
  ['Share Sheet', 'planned extension', 'degraded'],
  ['Siri replacement', 'not supported / not claimed', 'unsupported_platform'],
] as const

export function SettingsPermissionsView() {
  return (
    <div>
      <PageHeader title="Settings & Permissions" description="Privacy defaults, voice behavior, native permissions and mobile system integration states." />
      <div className="space-y-6 p-4 sm:p-6">
        <Tabs defaultValue="privacy">
          <TabsList className="grid w-full grid-cols-4 lg:w-auto">
            <TabsTrigger value="privacy">Privacy</TabsTrigger>
            <TabsTrigger value="voice">Voice</TabsTrigger>
            <TabsTrigger value="native">Native</TabsTrigger>
            <TabsTrigger value="mobile">Mobile</TabsTrigger>
          </TabsList>

          <TabsContent value="privacy" className="mt-6 grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Lock className="size-4 text-primary" />Route privacy defaults</CardTitle></CardHeader>
              <CardContent className="space-y-4">
                {[['Prefer local routes', true], ['Allow remote fallback for personal data', false], ['Require prompt before mesh peer route', true], ['Store raw audio', false]].map(([label, checked]) => (
                  <div key={String(label)} className="flex items-center justify-between rounded-lg border p-3"><div><p className="font-medium">{label}</p><p className="text-xs text-muted-foreground">Shown in route preview before execution.</p></div><Switch defaultChecked={Boolean(checked)} /></div>
                ))}
                <div className="flex flex-wrap gap-2"><PrivacyBadge privacy="personal" /><PrivacyBadge privacy="sensitive" /><PrivacyBadge privacy="secret" /></div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle className="flex items-center gap-2 text-base"><ShieldCheck className="size-4 text-primary" />Admin confirmation</CardTitle></CardHeader>
              <CardContent className="space-y-3 text-sm">
                <p>High/critical admin actions require diff preview, reason capture and audit event.</p>
                <div className="rounded-lg border bg-muted/30 p-3 font-mono text-xs">method_type=&quot;manage&quot; → AdminActionDraft → Confirm → Audit</div>
                <Button variant="outline">Preview confirmation policy</Button>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="voice" className="mt-6 grid gap-4 lg:grid-cols-3">
            {['Push-to-talk', 'Wake mode', 'Spoken replies'].map((label, index) => <Card key={label}><CardContent className="pt-6"><div className="mb-3 flex items-center justify-between"><Volume2 className="size-5 text-primary" /><Switch defaultChecked={index !== 1} /></div><p className="font-medium">{label}</p><p className="text-xs text-muted-foreground">{index === 1 ? 'Desktop local only until native/mobile policies pass.' : 'Available when STT/TTS capabilities are healthy.'}</p></CardContent></Card>)}
          </TabsContent>

          <TabsContent value="native" className="mt-6 grid gap-4 md:grid-cols-2">
            {permissions.map((permission) => { const Icon = permission.icon; return <Card key={permission.label}><CardContent className="flex items-start gap-3 pt-6"><span className="rounded-lg bg-primary/10 p-2 text-primary"><Icon className="size-4" /></span><div className="min-w-0 flex-1"><div className="flex items-center justify-between gap-2"><p className="font-medium">{permission.label}</p><CapabilityStateBadge state={permission.state} /></div><p className="text-sm text-muted-foreground">{permission.detail}</p></div></CardContent></Card> })}
          </TabsContent>

          <TabsContent value="mobile" className="mt-6 grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Smartphone className="size-4 text-primary" />Android assistant role</CardTitle></CardHeader>
              <CardContent className="space-y-2">
                {androidStates.map(([label, value, state]) => <div key={label} className="flex items-center justify-between gap-3 rounded-lg border p-3"><div><p className="font-medium">{label}</p><p className="text-xs text-muted-foreground">{value}</p></div><CapabilityStateBadge state={state} /></div>)}
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle className="flex items-center gap-2 text-base"><WandSparkles className="size-4 text-primary" />iOS invocation</CardTitle></CardHeader>
              <CardContent className="space-y-2">
                {iosStates.map(([label, value, state]) => <div key={label} className="flex items-center justify-between gap-3 rounded-lg border p-3"><div><p className="font-medium">{label}</p><p className="text-xs text-muted-foreground">{value}</p></div><CapabilityStateBadge state={state} /></div>)}
                <Badge variant="outline" className="border-warning/30 text-warning">No Siri replacement claim</Badge>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  )
}
