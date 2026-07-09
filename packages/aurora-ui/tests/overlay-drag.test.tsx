// @vitest-environment jsdom
import React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AuroraOverlayShell } from '../src/overlay/aurora-overlay-shell'
import { useDraggableOverlay, type AuroraOverlayMoveResult } from '../src/overlay/use-draggable-overlay'

type DragHarnessProps = {
  onStartDrag?: () => Promise<AuroraOverlayMoveResult> | AuroraOverlayMoveResult
  onMoveBy?: (dx: number, dy: number) => Promise<unknown> | void
  child?: React.ReactNode
}

function DragHarness({ onStartDrag, onMoveBy, child }: DragHarnessProps) {
  const drag = useDraggableOverlay({ onStartDrag, onMoveBy })
  return (
    <div
      data-testid="drag-target"
      data-offset={`${drag.offset.x},${drag.offset.y}`}
      onMouseDown={drag.startDrag}
    >
      drag
      {child}
    </div>
  )
}

describe('useDraggableOverlay native drag fallback', () => {
  let container: HTMLDivElement
  let root: Root
  let rafCallbacks: FrameRequestCallback[]

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    rafCallbacks = []
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      rafCallbacks.push(callback)
      return rafCallbacks.length
    })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.restoreAllMocks()
  })

  it('uses native start-drag without attaching the move-by fallback when native succeeds', async () => {
    const onStartDrag = vi.fn(async () => ({ ok: true }))
    const onMoveBy = vi.fn()
    const target = await renderHarness({ onStartDrag, onMoveBy })

    await act(async () => {
      target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: 10, clientY: 20 }))
      await flushMicrotasks()
    })
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 30, clientY: 40 }))
    window.dispatchEvent(new MouseEvent('mouseup'))

    expect(onStartDrag).toHaveBeenCalledTimes(1)
    expect(onMoveBy).not.toHaveBeenCalled()
    expect(target.dataset.offset).toBe('0,0')
  })

  it('falls back to one coalesced move-by call per animation frame when native drag is unavailable', async () => {
    const onStartDrag = vi.fn(async () => ({ ok: false }))
    const onMoveBy = vi.fn(async () => ({ ok: true }))
    const target = await renderHarness({ onStartDrag, onMoveBy })

    await act(async () => {
      target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: 0, clientY: 0 }))
      await flushMicrotasks()
    })

    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 3, clientY: 4 }))
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 5, clientY: 8 }))

    expect(onMoveBy).not.toHaveBeenCalled()
    await act(async () => {
      flushRaf()
      await flushMicrotasks()
    })

    expect(onMoveBy).toHaveBeenCalledTimes(1)
    expect(onMoveBy).toHaveBeenCalledWith(5, 8)
    expect(target.dataset.offset).toBe('0,0')
  })



  it('does not start native or fallback drag from interactive or explicitly blocked descendants', async () => {
    const onStartDrag = vi.fn(async () => ({ ok: true }))
    const onMoveBy = vi.fn()
    const target = await renderHarness({
      onStartDrag,
      onMoveBy,
      child: (
        <>
          <button type="button" data-testid="button-child">button</button>
          <input data-testid="input-child" />
          <textarea data-testid="textarea-child" />
          <select data-testid="select-child"><option>one</option></select>
          <a href="#blocked" data-testid="link-child">link</a>
          <span role="button" data-testid="role-button-child">role button</span>
          <span role="link" data-testid="role-link-child">role link</span>
          <span contentEditable data-testid="editable-child">editable</span>
          <span data-aurora-drag-block data-testid="blocked-child">blocked</span>
        </>
      )
    })

    for (const blocked of target.querySelectorAll<HTMLElement>('[data-testid$="-child"]')) {
      await act(async () => {
        blocked.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: 1, clientY: 2 }))
        await flushMicrotasks()
      })
    }

    expect(onStartDrag).not.toHaveBeenCalled()
    expect(onMoveBy).not.toHaveBeenCalled()
  })

  it('starts native drag from non-interactive overlay descendants', async () => {
    const onStartDrag = vi.fn(async () => ({ ok: true }))
    const target = await renderHarness({
      onStartDrag,
      child: <span data-testid="plain-child">plain</span>
    })

    await act(async () => {
      target.querySelector<HTMLElement>('[data-testid="plain-child"]')?.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: 6, clientY: 7 })
      )
      await flushMicrotasks()
    })

    expect(onStartDrag).toHaveBeenCalledTimes(1)
  })

  it('keeps body overlay cursor neutral until an active drag while the handle keeps grab affordance', async () => {
    const onStartDrag = vi.fn(async () => ({ ok: true }))

    await act(async () => {
      root.render(
        <AuroraOverlayShell
          mode="text"
          owlSrc="/aurora.png"
          voiceState="listening"
          onStartDrag={onStartDrag}
        />
      )
      await flushMicrotasks()
    })

    const overlay = container.querySelector<HTMLElement>('[data-aurora-overlay="text"]')
    const positionedOverlay = overlay?.parentElement as HTMLElement | null
    const handle = container.querySelector<HTMLElement>('[title="Drag to move"]')
    expect(positionedOverlay?.style.cursor).toBe('')
    expect(handle?.style.cursor).toBe('grab')

    await act(async () => {
      overlay?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: 10, clientY: 12 }))
      await flushMicrotasks()
    })

    expect(onStartDrag).toHaveBeenCalledTimes(1)
    expect(positionedOverlay?.style.cursor).toBe('grabbing')

    await act(async () => {
      window.dispatchEvent(new MouseEvent('mouseup'))
      await flushMicrotasks()
    })

    expect(positionedOverlay?.style.cursor).toBe('')
  })

  it('keeps the voice orb transparent outside masked art and centers the visualizer clip', async () => {
    await act(async () => {
      root.render(
        <AuroraOverlayShell
          mode="voice"
          owlSrc="/aurora.png"
          voiceState="listening"
        />
      )
      await flushMicrotasks()
    })

    const orbButton = container.querySelector<HTMLButtonElement>('[title="Aurora voice overlay"]')
    const icon = container.querySelector<HTMLImageElement>('img[alt="Aurora"]')
    const clip = container.querySelector<HTMLElement>('[data-aurora-orb-clip="true"]')
    const handle = container.querySelector<HTMLElement>('[title="Drag to move"]')
    const positionedOverlay = container.querySelector<HTMLElement>('[data-aurora-overlay="voice"]')?.parentElement

    expect(orbButton?.style.background).toBe('transparent')
    expect(orbButton?.style.width).toBe('132px')
    expect(orbButton?.style.height).toBe('132px')
    const iconStyle = icon?.getAttribute('style') ?? ''
    expect(iconStyle).toContain('clip-path: circle')
    expect(iconStyle).toContain('radial-gradient')
    expect(iconStyle).toContain('mask')
    expect(clip?.style.left).toBe('50%')
    expect(clip?.style.top).toBe('50%')
    expect(clip?.style.width).toBe('132px')
    expect(clip?.style.height).toBe('132px')
    expect(clip?.style.transform).toBe('translate(-50%,-50%)')
    expect(positionedOverlay?.style.cursor).toBe('')
    expect(handle?.style.cursor).toBe('grab')
  })

  it('updates local offset when the move-by fallback reports failure', async () => {
    const onMoveBy = vi.fn(async () => ({ ok: false }))
    const target = await renderHarness({ onMoveBy })

    await act(async () => {
      target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }))
    })
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 14, clientY: 17 }))

    await act(async () => {
      flushRaf()
      await flushMicrotasks()
    })

    expect(onMoveBy).toHaveBeenCalledWith(4, 7)
    expect(target.dataset.offset).toBe('4,7')
  })

  async function renderHarness(props: DragHarnessProps) {
    await act(async () => {
      root.render(<DragHarness {...props} />)
      await flushMicrotasks()
    })
    const target = container.querySelector<HTMLElement>('[data-testid="drag-target"]')
    expect(target).toBeDefined()
    return target!
  }

  function flushRaf() {
    const callbacks = [...rafCallbacks]
    rafCallbacks = []
    callbacks.forEach((callback) => callback(performance.now()))
  }
})

async function flushMicrotasks() {
  await Promise.resolve()
  await Promise.resolve()
}
