'use client'

import { useRef, useState } from 'react'
import {
  ArrowUp,
  Copy,
  Mic,
  Paperclip,
  Pin,
  Quote,
  Route as RouteIcon,
  Save,
  Square,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { conversations, sampleMessages } from '@/lib/aurora/data'
import type { ChatMessage, RouteKind } from '@/lib/aurora/types'
import { PrivacyBadge, RouteBadge } from '@/components/aurora/status-badges'
import { RouteSheet } from './route-sheet'
import { ToolCallCard } from './tool-call-card'

export function AssistantView() {
  const [messages, setMessages] = useState<ChatMessage[]>(sampleMessages)
  const [input, setInput] = useState('')
  const [route, setRoute] = useState<RouteKind>('Local')
  const [routeOpen, setRouteOpen] = useState(false)
  const [listening, setListening] = useState(false)
  const [activeConv, setActiveConv] = useState('c-01')
  const endRef = useRef<HTMLDivElement>(null)

  function send() {
    if (!input.trim()) return
    const userMsg: ChatMessage = {
      id: `u-${Date.now()}`,
      role: 'user',
      content: input,
      privacyClass: 'personal',
    }
    const reply: ChatMessage = {
      id: `a-${Date.now()}`,
      role: 'assistant',
      content:
        'This is a simulated response for the visual prototype. In a live deployment this would stream from the orchestrator via the selected route.',
      route,
      model: route === 'Local' ? 'llama.cpp · 8B' : 'gpt-class-large',
      privacyClass: 'personal',
    }
    setMessages((m) => [...m, userMsg, reply])
    setInput('')
    requestAnimationFrame(() => endRef.current?.scrollIntoView({ behavior: 'smooth' }))
  }

  function decideToolCall(id: string, decision: 'approved' | 'denied') {
    setMessages((m) =>
      m.map((msg) =>
        msg.id === id && msg.toolCall
          ? { ...msg, toolCall: { ...msg.toolCall, status: decision } }
          : msg,
      ),
    )
  }

  return (
    <div className="flex h-full min-h-0">
      {/* Conversation list */}
      <div className="hidden w-64 shrink-0 flex-col border-r md:flex">
        <div className="border-b p-3">
          <Button className="w-full justify-start" variant="secondary">
            <Quote className="size-4" />
            New conversation
          </Button>
        </div>
        <ScrollArea className="flex-1">
          <ul className="p-2">
            {conversations.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => setActiveConv(c.id)}
                  className={cn(
                    'w-full rounded-md p-2.5 text-left transition-colors',
                    activeConv === c.id ? 'bg-accent' : 'hover:bg-accent/50',
                  )}
                >
                  <div className="flex items-center gap-1.5">
                    {c.pinned && <Pin className="size-3 text-muted-foreground" aria-hidden />}
                    <span className="truncate text-sm font-medium">{c.title}</span>
                  </div>
                  <div className="mt-1.5 flex items-center gap-1.5">
                    <RouteBadge route={c.route} className="px-1.5 py-0" />
                    <span className="ml-auto text-[11px] text-muted-foreground">{c.updated}</span>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </ScrollArea>
      </div>

      {/* Thread */}
      <div className="flex min-w-0 flex-1 flex-col">
        <ScrollArea className="flex-1">
          <div className="mx-auto max-w-3xl space-y-6 px-4 py-6 sm:px-6">
            {messages.map((msg) => (
              <MessageBubble key={msg.id} msg={msg} onDecision={decideToolCall} />
            ))}
            {listening && <VoiceCapture />}
            <div ref={endRef} />
          </div>
        </ScrollArea>

        {/* Composer */}
        <div className="border-t bg-background p-3 sm:p-4">
          <div className="mx-auto max-w-3xl">
            <div className="flex items-center justify-between gap-2 pb-2">
              <button
                type="button"
                onClick={() => setRouteOpen(true)}
                className="inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                <RouteIcon className="size-3.5" aria-hidden />
                Routing via
                <RouteBadge route={route} className="px-1.5 py-0" />
              </button>
              <PrivacyBadge privacy="personal" className="px-1.5 py-0" />
            </div>
            <div className="flex items-end gap-2 rounded-xl border bg-card p-2 focus-within:border-primary/50">
              <Button variant="ghost" size="icon" className="shrink-0" aria-label="Attach">
                <Paperclip className="size-5" />
              </Button>
              <Textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    send()
                  }
                }}
                placeholder="Ask Aurora anything…"
                rows={1}
                className="min-h-9 resize-none border-0 bg-transparent p-1.5 shadow-none focus-visible:ring-0"
              />
              <Button
                variant={listening ? 'destructive' : 'ghost'}
                size="icon"
                className="shrink-0"
                onClick={() => setListening((v) => !v)}
                aria-label={listening ? 'Stop listening' : 'Push to talk'}
              >
                {listening ? <Square className="size-5" /> : <Mic className="size-5" />}
              </Button>
              <Button size="icon" className="shrink-0" onClick={send} aria-label="Send" disabled={!input.trim()}>
                <ArrowUp className="size-5" />
              </Button>
            </div>
            <p className="pt-2 text-center text-[11px] text-muted-foreground">
              Aurora routes locally by default. Remote and mesh routes are shown before any data leaves this device.
            </p>
          </div>
        </div>
      </div>

      <RouteSheet open={routeOpen} onOpenChange={setRouteOpen} selected={route} onSelect={setRoute} />
    </div>
  )
}

function MessageBubble({
  msg,
  onDecision,
}: {
  msg: ChatMessage
  onDecision: (id: string, decision: 'approved' | 'denied') => void
}) {
  if (msg.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-tr-sm bg-primary/15 px-4 py-2.5 text-sm text-foreground">
          {msg.content}
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="flex size-6 items-center justify-center rounded-md bg-primary/15 text-[10px] font-bold text-primary">
          AI
        </span>
        {msg.route && <RouteBadge route={msg.route} className="px-1.5 py-0" />}
        {msg.model && <span className="font-mono text-xs text-muted-foreground">{msg.model}</span>}
      </div>
      <div className="whitespace-pre-wrap rounded-2xl rounded-tl-sm bg-card px-4 py-3 text-sm leading-relaxed">
        {msg.content}
      </div>

      {msg.toolCall && (
        <ToolCallCard call={msg.toolCall} onDecision={(d) => onDecision(msg.id, d)} />
      )}

      {msg.citations && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-muted-foreground">Sources:</span>
          {msg.citations.map((c) => (
            <Badge key={c} variant="outline" className="font-mono text-[11px] font-normal">
              {c}
            </Badge>
          ))}
        </div>
      )}

      <div className="flex items-center gap-1">
        <Button variant="ghost" size="sm" className="h-7 px-2 text-muted-foreground">
          <Copy className="size-3.5" />
          Copy
        </Button>
        <Button variant="ghost" size="sm" className="h-7 px-2 text-muted-foreground">
          <Save className="size-3.5" />
          Save to memory
        </Button>
      </div>
    </div>
  )
}

function VoiceCapture() {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed bg-card/60 px-4 py-6">
      <div className="flex items-end gap-1" aria-hidden>
        {[12, 24, 18, 32, 22, 14, 28, 16].map((h, i) => (
          <span
            key={i}
            className="w-1 animate-pulse rounded-full bg-primary"
            style={{ height: h, animationDelay: `${i * 80}ms` }}
          />
        ))}
      </div>
      <p className="text-sm font-medium">Listening…</p>
      <p className="text-xs text-muted-foreground">&ldquo;summarize today&apos;s deployment health&rdquo;</p>
      <RouteBadge route="Local" />
    </div>
  )
}
