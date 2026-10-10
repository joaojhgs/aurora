// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AuroraClient } from '@aurora/client'
import { useAssistantAttachments } from './use-assistant-attachments'

const roots: Root[] = []
let createObjectURL: ReturnType<typeof vi.fn>
let revokeObjectURL: ReturnType<typeof vi.fn>

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(() => {
  act(() => { for (const root of roots.splice(0)) root.unmount() })
  document.body.innerHTML = ''
  delete (window as unknown as { showOpenFilePicker?: unknown }).showOpenFilePicker
  vi.restoreAllMocks()
})

describe('useAssistantAttachments', () => {
  it('revokes only the removed attachment preview and leaves remaining context staged', async () => {
    const harness = await renderAttachmentsHarness()

    await act(async () => {
      await harness.result.onFileInput(fileList([
        imageFile('first.png'),
        imageFile('second.png'),
      ]), true)
      await flushPromises()
    })

    expect(harness.result.attachments.map((attachment) => attachment.previewUrl)).toEqual(['blob:preview-1', 'blob:preview-2'])

    await act(async () => {
      harness.result.removeAttachment(harness.result.attachments[0]!.id)
      await flushPromises()
    })

    expect(revokeObjectURL).toHaveBeenCalledWith('blob:preview-1')
    expect(revokeObjectURL).not.toHaveBeenCalledWith('blob:preview-2')
    expect(harness.result.attachments.map((attachment) => attachment.label)).toEqual(['second.png'])
  })

  it('revokes staged previews when the hook unmounts', async () => {
    const harness = await renderAttachmentsHarness()

    await act(async () => {
      await harness.result.onFileInput(fileList([imageFile('cleanup.png')]), true)
      await flushPromises()
    })

    act(() => { harness.root.unmount() })

    expect(revokeObjectURL).toHaveBeenCalledWith('blob:preview-1')
  })

  it('marks pending context as accepted after ingest without revoking previews', async () => {
    const client = attachmentClient({ accepted: true })
    const harness = await renderAttachmentsHarness({ client })

    await act(async () => {
      await harness.result.onFileInput(fileList([textFile('notes.txt', 'remember this')]), true)
      await flushPromises()
    })

    await act(async () => {
      await expect(harness.result.ingestPendingAttachments('conversation-1')).resolves.toBe('ready')
      await flushPromises()
    })

    expect(client.assistant.ingestContext).toHaveBeenCalledWith(expect.objectContaining({
      session_id: 'conversation-1',
      namespace: 'assistant.attachments',
      privacy_class: 'personal',
    }))
    expect(harness.result.attachments[0]).toMatchObject({ status: 'accepted', progress: 100 })
    expect(revokeObjectURL).not.toHaveBeenCalled()
  })

  it('ignores late ingest results after attachments are cleared', async () => {
    const ingest = deferred<ReturnType<typeof acceptedIngestResponse>>()
    const client = attachmentClient({ ingest: ingest.promise })
    const harness = await renderAttachmentsHarness({ client })

    await act(async () => {
      await harness.result.onFileInput(fileList([textFile('late.txt', 'old context')]), true)
      await flushPromises()
    })

    const pendingIngest = harness.result.ingestPendingAttachments('conversation-1')
    await act(async () => {
      harness.result.clearAttachments()
      ingest.resolve(acceptedIngestResponse())
      await pendingIngest
      await flushPromises()
    })

    expect(harness.result.attachments).toEqual([])
    expect(client.assistant.ingestContext).toHaveBeenCalledTimes(1)
  })

  it('drops files selected from a stale picker after auth scope changes', async () => {
    const pickedFile = deferred<File>()
    const client = attachmentClient()
    ;(window as unknown as { showOpenFilePicker?: unknown }).showOpenFilePicker = vi.fn(async () => [{ getFile: () => pickedFile.promise }])
    const harness = await renderAttachmentsHarness({ client })

    const picker = harness.result.openAttachmentPicker(true)
    await act(async () => {
      client.emitAuth(authSnapshot({ principalId: 'next-user' }))
      pickedFile.resolve(imageFile('stale.png'))
      await picker
      await flushPromises()
    })

    expect(harness.result.attachments).toEqual([])
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:preview-1')
  })
})

interface AttachmentsHarnessOptions {
  client?: ReturnType<typeof attachmentClient>
}

async function renderAttachmentsHarness(options: AttachmentsHarnessOptions = {}) {
  let previewIndex = 0
  createObjectURL = vi.fn(() => {
    previewIndex += 1
    return `blob:preview-${previewIndex}`
  })
  revokeObjectURL = vi.fn()
  Object.defineProperty(window.URL, 'createObjectURL', { configurable: true, value: createObjectURL })
  Object.defineProperty(window.URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL })

  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  roots.push(root)
  let latest!: ReturnType<typeof useAssistantAttachments>

  function Harness() {
    latest = useAssistantAttachments({
      client: (options.client ?? attachmentClient()) as unknown as AuroraClient,
      privacyClass: 'personal',
      setLastError: vi.fn(),
      formatError: (error) => error instanceof Error ? error.message : String(error),
    })
    return null
  }

  await act(async () => {
    root.render(createElement(Harness))
    await flushPromises()
  })

  return { root, get result() { return latest } }
}

function attachmentClient(options: { accepted?: boolean; ingest?: Promise<ReturnType<typeof acceptedIngestResponse>> } = {}) {
  let auth = authSnapshot({ principalId: 'initial-user' })
  const listeners = new Set<(auth: ReturnType<typeof authSnapshot>) => void>()
  return {
    assistant: {
      ingestContext: vi.fn(async () => options.ingest ? await options.ingest : {
        ok: true as const,
        data: {
          accepted: options.accepted ?? false,
          rejected: false,
          accepted_items: options.accepted ? [{ item_id: 'context-0-test', status: 'accepted', message: 'Accepted', reason_code: null, redacted: false }] : [],
          rejected_items: [],
        },
      }),
    },
    auth: {
      snapshot: vi.fn(() => auth),
      subscribe: vi.fn((listener: (auth: ReturnType<typeof authSnapshot>) => void) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      }),
    },
    emitAuth(next: ReturnType<typeof authSnapshot>) {
      auth = next
      for (const listener of listeners) listener(next)
    },
  }
}

function acceptedIngestResponse() {
  return {
    ok: true as const,
    data: {
      accepted: true,
      rejected: false,
      accepted_items: [{ item_id: 'context-0-test', status: 'accepted' as const, message: 'Accepted', reason_code: null, redacted: false }],
      rejected_items: [],
    },
  }
}

function authSnapshot(overrides: { principalId?: string } = {}) {
  return {
    state: 'authenticated' as const,
    principalId: overrides.principalId ?? 'principal',
    effectivePermissions: new Set(['assistant:use']),
  }
}

function imageFile(name: string): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type: 'image/png' })
}

function textFile(name: string, text: string): File {
  const file = new File([text], name, { type: 'text/plain' })
  Object.defineProperty(file, 'text', {
    configurable: true,
    value: vi.fn(async () => text),
  })
  return file
}

function fileList(files: File[]): FileList {
  return {
    length: files.length,
    item: (index: number) => files[index] ?? null,
    [Symbol.iterator]: function* () { yield* files },
    ...Object.fromEntries(files.map((file, index) => [index, file])),
  } as unknown as FileList
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

async function flushPromises() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
}
