'use client'

import { useCallback, useState, type MouseEvent as ReactMouseEvent } from 'react'

import type { AuroraOverlayDragOffset } from './types'

export type AuroraOverlayMoveResult = { ok?: boolean } | boolean | null | undefined

export interface UseDraggableOverlayOptions {
  initialOffset?: AuroraOverlayDragOffset | undefined
  onMoveBy?: ((dx: number, dy: number) => void | Promise<unknown>) | undefined
  onStartDrag?: (() => Promise<AuroraOverlayMoveResult> | AuroraOverlayMoveResult) | undefined
}

const NON_DRAGGABLE_SELECTOR = [
  'button',
  'input',
  'textarea',
  'select',
  'a',
  '[role="button"]',
  '[role="link"]',
  '[contenteditable="true"]',
  '[data-aurora-drag-block]'
].join(',')

export function useDraggableOverlay(options: UseDraggableOverlayOptions = {}) {
  const { initialOffset = { x: 0, y: 0 }, onMoveBy, onStartDrag } = options
  const [offset, setOffset] = useState<AuroraOverlayDragOffset>(initialOffset)
  const [isDragging, setIsDragging] = useState(false)

  const startDrag = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    const target = event.target
    if (!(target instanceof Element)) return
    if (target.closest(NON_DRAGGABLE_SELECTOR)) return

    event.preventDefault()
    setIsDragging(true)
    let dragCancelled = false
    const startX = event.clientX
    const startY = event.clientY

    const stopDragging = () => {
      dragCancelled = true
      setIsDragging(false)
      window.removeEventListener('mouseup', stopDragging)
      window.removeEventListener('blur', stopDragging)
    }

    window.addEventListener('mouseup', stopDragging, { once: true })
    window.addEventListener('blur', stopDragging, { once: true })

    const startFallbackDrag = () => {
      if (dragCancelled) return
      let previousX = startX
      let previousY = startY
      let pendingDx = 0
      let pendingDy = 0
      let frame: number | null = null

      const applyLocalOffset = (dx: number, dy: number) => {
        setOffset((current) => ({ x: current.x + dx, y: current.y + dy }))
      }

      const flushMove = () => {
        frame = null
        const dx = pendingDx
        const dy = pendingDy
        pendingDx = 0
        pendingDy = 0
        if (!dx && !dy) return

        if (!onMoveBy) {
          applyLocalOffset(dx, dy)
          return
        }

        Promise.resolve(onMoveBy(dx, dy)).then((result) => {
          if (isMoveRejected(result)) applyLocalOffset(dx, dy)
        }).catch(() => applyLocalOffset(dx, dy))
      }

      const scheduleMove = () => {
        if (frame !== null) return
        frame = window.requestAnimationFrame(flushMove)
      }

      const onMove = (moveEvent: MouseEvent) => {
        pendingDx += moveEvent.clientX - previousX
        pendingDy += moveEvent.clientY - previousY
        previousX = moveEvent.clientX
        previousY = moveEvent.clientY
        scheduleMove()
      }
      const onUp = () => {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
        if (frame !== null) {
          window.cancelAnimationFrame(frame)
          flushMove()
        }
      }

      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    }

    if (!onStartDrag) {
      startFallbackDrag()
      return
    }

    Promise.resolve(onStartDrag()).then((result) => {
      if (!isNativeDragStarted(result)) startFallbackDrag()
    }).catch(() => startFallbackDrag())
  }, [onMoveBy, onStartDrag])

  const reset = useCallback(() => {
    setOffset({ x: 0, y: 0 })
  }, [])

  return { isDragging, offset, reset, startDrag, setOffset }
}

function isNativeDragStarted(result: AuroraOverlayMoveResult): boolean {
  if (result === true) return true
  if (result === false || result === null || result === undefined) return false
  return result.ok !== false
}

function isMoveRejected(result: unknown): boolean {
  return Boolean(result && typeof result === 'object' && 'ok' in result && result.ok === false)
}
