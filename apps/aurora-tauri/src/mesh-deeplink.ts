import { extractMeshInviteToken, getAuroraSurfaceProfile } from '@aurora/ui'

/**
 * Deep-link and QR-scan glue for mesh invites (`aurora://mesh/invite?i=amv2.…`, and the
 * older `amv1.` generation, which stays decodable forever).
 *
 * Both Tauri plugins are imported dynamically so the same bundle keeps working in the
 * browser/mock shells where the Tauri IPC bridge is absent.
 */

export function isTauriShell(): boolean {
  if (typeof window === 'undefined') return false
  return '__TAURI_INTERNALS__' in window || '__TAURI__' in window
}

export function isMobileTauriShell(): boolean {
  if (!isTauriShell()) return false
  return getAuroraSurfaceProfile({
    userAgent: typeof navigator === 'undefined' ? undefined : navigator.userAgent,
  }).isMobile
}

/** Opens the native barcode scanner (mobile only) and resolves with the scanned text, or null when cancelled. */
export async function scanMeshInviteQr(): Promise<string | null> {
  const scanner = await import('@tauri-apps/plugin-barcode-scanner')
  let permission = await scanner.checkPermissions()
  if (permission !== 'granted') {
    permission = await scanner.requestPermissions()
  }
  if (permission !== 'granted') {
    throw new Error('Camera permission was not granted for QR scanning.')
  }
  try {
    const scanned = await scanner.scan({
      windowed: false,
      formats: [scanner.Format.QRCode],
    })
    return scanned?.content ?? null
  } catch (error) {
    if (isBarcodeScanCancellation(error)) return null
    throw error
  }
}

function isBarcodeScanCancellation(error: unknown): boolean {
  const message = error instanceof Error
    ? error.message
    : typeof error === 'object'
      && error !== null
      && 'message' in error
      && typeof error.message === 'string'
      ? error.message
      : String(error)
  return message.trim().toLowerCase() === 'cancelled'
}

/**
 * Subscribes to `aurora://` deep links (runtime opens and the cold-start URL) and forwards
 * mesh invites to the handler. Resolves with an unlisten function.
 */
export async function initMeshDeepLinks(onMeshInvite: (inviteText: string) => void): Promise<() => void> {
  if (!isTauriShell()) return () => undefined
  const deepLink = await import('@tauri-apps/plugin-deep-link')
  const handleUrls = (urls: string[] | null) => {
    for (const url of urls ?? []) {
      if (extractMeshInviteToken(url)) {
        onMeshInvite(url)
        return
      }
    }
  }
  try {
    handleUrls(await deepLink.getCurrent())
  } catch (error) {
    console.warn('aurora deep-link getCurrent failed', error)
  }
  const unlisten = await deepLink.onOpenUrl(handleUrls)
  return unlisten
}
