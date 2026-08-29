'use client'

import { Mic, Pin, Send, Settings, StickyNote, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEventHandler } from 'react'

import { DragGrip } from './aurora-voice-orb'
import type { AuroraOverlayMessage } from './types'

export interface AuroraTextOverlayProps {
  messages?: AuroraOverlayMessage[] | undefined
  thinking?: boolean | undefined
  pinned?: boolean | undefined
  onClose?: (() => void) | undefined
  onSubmit?: ((text: string) => void) | undefined
  onVoiceClick?: (() => void) | undefined
  onTogglePin?: (() => void) | undefined
  onDragStart?: MouseEventHandler<HTMLDivElement> | undefined
}

export function AuroraTextOverlay({
  messages = [],
  thinking = false,
  pinned = false,
  onClose,
  onSubmit,
  onVoiceClick,
  onTogglePin,
  onDragStart
}: AuroraTextOverlayProps) {
  const [input, setInput] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)
  const hasHistory = messages.length > 0 || thinking
  const pinStyle = useMemo<CSSProperties>(() => ({
    ...iconButtonStyle,
    background: pinned ? '#1ad1d122' : 'transparent',
    color: pinned ? '#1ad1d1' : '#8e9398'
  }), [pinned])

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  function submit() {
    const value = input.trim()
    if (!value) return
    setInput('')
    onSubmit?.(value)
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      event.preventDefault()
      submit()
    }
  }

  return (
    <div style={textPopupStackStyle} data-aurora-overlay="text">
      <DragGrip onMouseDown={onDragStart} />
      {hasHistory ? (
        <div style={historyStyle}>
          {messages.map((message) => (
            <div key={message.id} style={message.role === 'user' ? userBubbleStyle : assistantBubbleStyle}>
              {message.text}
            </div>
          ))}
          {thinking ? <div style={thinkingBubbleStyle}>Thinking…</div> : null}
        </div>
      ) : null}
      <div style={inputBarStyle}>
        <button type="button" onClick={onVoiceClick} title="Voice mode" style={voiceButtonStyle}>
          <Mic size={16} fill="#1ad1d1" stroke="#1ad1d1" />
        </button>
        <input
          ref={inputRef}
          autoFocus
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Ask Aurora..."
          style={inputStyle}
        />
        <button type="button" onClick={submit} title="Send" style={iconButtonStyle}>
          <Send size={15} fill="#8e9398" strokeWidth={1.5} />
        </button>
        <button type="button" title="Start meeting notes" style={iconButtonStyle}>
          <StickyNote size={15} strokeWidth={1.7} />
        </button>
        <button type="button" onClick={onTogglePin} title="Pin overlay" style={pinStyle}>
          <Pin size={14} strokeWidth={1.5} />
        </button>
        <button type="button" title="Settings" style={iconButtonStyle}>
          <Settings size={15} strokeWidth={1.6} />
        </button>
        <button type="button" onClick={onClose} title="Close" style={closeButtonStyle}>
          <X size={16} strokeWidth={1.7} />
        </button>
      </div>
    </div>
  )
}

const textPopupStackStyle: CSSProperties = {
  width: '100%',
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  fontFamily: "'Geist', system-ui, sans-serif"
}

const historyStyle: CSSProperties = {
  maxHeight: 230,
  overflowY: 'auto',
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  padding: '4px 2px'
}

const userBubbleStyle: CSSProperties = {
  alignSelf: 'flex-end',
  maxWidth: '78%',
  background: '#202327',
  color: '#f0f2f4',
  borderRadius: '14px 14px 4px 14px',
  padding: '8px 12px',
  font: "13px/1.4 'Geist', system-ui, sans-serif"
}

const assistantBubbleStyle: CSSProperties = {
  alignSelf: 'flex-start',
  maxWidth: '78%',
  background: '#131518',
  border: '1px solid #ffffff17',
  color: '#dcdee0',
  borderRadius: '14px 14px 14px 4px',
  padding: '8px 12px',
  font: "13px/1.4 'Geist', system-ui, sans-serif"
}

const thinkingBubbleStyle: CSSProperties = {
  ...assistantBubbleStyle,
  color: '#8e9398'
}

const inputBarStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  background: '#15171a',
  border: '1px solid #ffffff17',
  borderRadius: 999,
  padding: '8px 8px 8px 18px',
  boxShadow: '0 16px 40px rgba(0,0,0,.4)'
}

const voiceButtonStyle: CSSProperties = {
  width: 34,
  height: 34,
  borderRadius: 999,
  border: 'none',
  background: '#202327',
  color: '#f0f2f4',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  flex: 'none',
  padding: 0
}

const inputStyle: CSSProperties = {
  flex: 1,
  background: 'transparent',
  border: 'none',
  outline: 'none',
  color: '#f0f2f4',
  font: "14px/1.4 'Geist', system-ui, sans-serif",
  minWidth: 0
}

const iconButtonStyle: CSSProperties = {
  width: 30,
  height: 30,
  borderRadius: 999,
  border: 'none',
  background: 'transparent',
  color: '#8e9398',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  flex: 'none',
  padding: 0
}

const closeButtonStyle: CSSProperties = {
  ...iconButtonStyle,
  fontSize: 16
}
