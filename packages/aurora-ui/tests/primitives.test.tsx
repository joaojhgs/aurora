// @vitest-environment jsdom
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { AudioRecorderVisualizer } from '../src/audio-recorder-visualizer'
import {
  isAuthoritativeVoiceTranscriptEvent,
  mergeTranscriptText
} from '../src/assistant-view'
import {
  AdminConfirmDialog,
  Card,
  DataTable,
  DetailSheet,
  MetaGrid,
  StatStrip,
  Switch,
  ToastProvider,
  type DataColumn
} from '../src/primitives'

const roots: Root[] = []

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(() => {
  for (const root of roots.splice(0)) root.unmount()
})

function mount(node: React.ReactElement): HTMLElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => {
    root.render(node)
  })
  return container
}

describe('foundation primitives', () => {
  it('Card renders header, actions, and body', () => {
    const markup = renderToStaticMarkup(
      <Card title="Backups" actions={<button type="button">New</button>}>
        <p>content</p>
      </Card>
    )
    expect(markup).toContain('data-slot="card"')
    expect(markup).toContain('data-slot="card-title"')
    expect(markup).toContain('Backups')
    expect(markup).toContain('data-slot="card-action"')
    expect(markup).toContain('content')
  })

  it('StatStrip renders metric list items', () => {
    const markup = renderToStaticMarkup(
      <StatStrip items={[{ label: 'Snapshots', value: 12 }, { label: 'Failed', value: 0, tone: 'danger' }]} />
    )
    expect(markup).toContain('role="list"')
    expect(markup).toContain('Snapshots')
    expect(markup).toContain('bg-destructive/5')
    expect((markup.match(/role="listitem"/g) ?? []).length).toBe(2)
  })

  it('MetaGrid emits definition list rows', () => {
    const markup = renderToStaticMarkup(
      <MetaGrid items={[{ label: 'Owner', value: 'admin' }, { label: 'Digest', value: 'abc', mono: true }]} />
    )
    expect(markup).toContain('<dt class="text-muted-foreground">Owner</dt>')
    expect(markup).toContain('admin')
    expect(markup).toContain('font-mono')
  })

  it('DataTable renders rows and empty state', () => {
    interface Row { id: string; name: string }
    const columns: Array<DataColumn<Row>> = [
      { key: 'name', header: 'Name', render: (row) => row.name }
    ]
    const populated = renderToStaticMarkup(
      <DataTable columns={columns} rows={[{ id: '1', name: 'daily-digest' }]} getRowKey={(row) => row.id} />
    )
    expect(populated).toContain('data-slot="table"')
    expect(populated).toContain('daily-digest')

    const empty = renderToStaticMarkup(
      <DataTable columns={columns} rows={[]} getRowKey={(row) => row.id} empty={<span>No jobs</span>} />
    )
    expect(empty).toContain('data-slot="empty"')
    expect(empty).toContain('No jobs')
  })

  it('DataTable row click fires and is keyboard reachable', () => {
    interface Row { id: string }
    const clicked: string[] = []
    const container = mount(
      <DataTable
        columns={[{ key: 'id', header: 'Id', render: (row) => row.id }]}
        rows={[{ id: 'r1' }]}
        getRowKey={(row) => row.id}
        onRowClick={(row) => clicked.push(row.id)}
      />
    )
    const row = container.querySelector('tr[role="button"]') as HTMLElement | null
    expect(row).not.toBeNull()
    expect(row?.getAttribute('tabindex')).toBe('0')
    act(() => {
      row!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(clicked).toEqual(['r1'])
  })

  it('DetailSheet renders nothing when closed and a dialog when open', () => {
    const closed = renderToStaticMarkup(<DetailSheet open={false} onClose={() => undefined} title="Job" />)
    expect(closed).toBe('')

    // Base UI's Sheet/Dialog primitives portal their content to document.body, which
    // renderToStaticMarkup cannot capture (it only serializes the returned tree, not
    // portals) -- mount into real jsdom and inspect document.body instead.
    mount(<DetailSheet open onClose={() => undefined} title="Job detail" description="info" />)
    const dialog = document.body.querySelector('[role="dialog"]')
    expect(dialog).not.toBeNull()
    expect(dialog?.textContent).toContain('Job detail')
    expect(dialog?.textContent).toContain('info')
  })

  it('Switch toggles through onChange', () => {
    const changes: boolean[] = []
    const container = mount(<Switch checked={false} label="Dark mode" onChange={(next) => changes.push(next)} />)
    const control = container.querySelector('[role="switch"]') as HTMLElement
    expect(control).not.toBeNull()
    expect(control.getAttribute('aria-checked')).toBe('false')
    act(() => {
      control.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(changes).toEqual([true])
  })

  it('AdminConfirmDialog gates confirm until reason and phrase satisfied', () => {
    let confirmed = 0
    mount(
      <AdminConfirmDialog
        open
        title="Delete backup"
        description="This removes the snapshot."
        severity="destructive"
        requireReason
        reasonValue=""
        requireTypedPhrase="DELETE"
        typedValue=""
        onConfirm={() => {
          confirmed += 1
        }}
        onCancel={() => undefined}
      />
    )
    const confirmButton = Array.from(document.body.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Confirm')
    )
    expect(confirmButton?.hasAttribute('disabled')).toBe(true)
    act(() => {
      confirmButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(confirmed).toBe(0)
  })

  it('AdminConfirmDialog confirms when requirements met', () => {
    let confirmed = 0
    mount(
      <AdminConfirmDialog
        open
        title="Delete backup"
        description="This removes the snapshot."
        requireReason
        reasonValue="cleanup"
        requireTypedPhrase="DELETE"
        typedValue="DELETE"
        onConfirm={() => {
          confirmed += 1
        }}
        onCancel={() => undefined}
      />
    )
    const confirmButton = Array.from(document.body.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Confirm')
    )
    expect(confirmButton?.hasAttribute('disabled')).toBe(false)
    act(() => {
      confirmButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(confirmed).toBe(1)
  })

  it('ToastProvider renders a polite live region', () => {
    const markup = renderToStaticMarkup(
      <ToastProvider>
        <span>app</span>
      </ToastProvider>
    )
    expect(markup).toContain('aria-live="polite"')
    expect(markup).toContain('app')
  })

  it('AudioRecorderVisualizer renders timer, waveform canvas, and active stop control', () => {
    const markup = renderToStaticMarkup(
      <AudioRecorderVisualizer
        status="listening"
        bars={[20, 60, 35, 80]}
        elapsedSeconds={65}
        title="Listening"
        detail="Backend microphone"
        onToggle={() => undefined}
        onReset={() => undefined}
      />
    )
    expect(markup).toContain('aui-audio-recorder')
    expect(markup).toContain('aui-audio-recorder-active')
    expect(markup).toContain('Recording timer 00:01:05')
    expect(markup).toContain('aria-label="Stop listening"')
    expect(markup).toContain('aui-audio-recorder-canvas')
  })


describe('assistant voice transcript helpers', () => {
  it('merges rolling long-form transcription tails without dropping the prompt prefix', () => {
    let preview = ''
    for (const update of [
      'how much is 3 plus 5 plus 6?',
      'how much is 3 plus 5 plus 6 and search for me the FGIPT latest news.',
      'and search for me the ad-gift latest news.'
    ]) {
      preview = mergeTranscriptText(preview, update, { appendOnMiss: false })
    }
    expect(preview).toBe('how much is 3 plus 5 plus 6 and search for me the ad-gift latest news.')
  })

  it('uses coordinator transcript events as authoritative for voice chat turns', () => {
    expect(isAuthoritativeVoiceTranscriptEvent({ kind: 'transcription_final', topic: 'Transcription.Result' })).toBe(false)
    expect(isAuthoritativeVoiceTranscriptEvent({ kind: 'transcription_partial', topic: 'Transcription.Result' })).toBe(false)
    expect(isAuthoritativeVoiceTranscriptEvent({ kind: 'transcription_partial', topic: 'STTCoordinator.Partial' })).toBe(true)
    expect(isAuthoritativeVoiceTranscriptEvent({ kind: 'transcription_final', topic: 'STTCoordinator.UserSpeechCaptured' })).toBe(true)
  })
})

  it('keeps em-dashes out of aurora-ui source strings', () => {
    function walk(dir: string): string[] {
      return readdirSync(dir).flatMap((entry) => {
        const path = join(dir, entry)
        return statSync(path).isDirectory() ? walk(path) : path.endsWith('.ts') || path.endsWith('.tsx') ? [path] : []
      })
    }
    for (const file of walk(join(process.cwd(), 'src'))) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/—/)
    }
  })
})
