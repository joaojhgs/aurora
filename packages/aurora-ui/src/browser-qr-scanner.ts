import { decodeMeshInvite } from './mesh-invite'

type BarcodeResult = { rawValue?: string }
type BarcodeDetectorInstance = {
  detect(source: HTMLVideoElement): Promise<BarcodeResult[]>
}
type BarcodeDetectorConstructor = new (options?: {
  formats?: string[]
}) => BarcodeDetectorInstance

export interface BrowserQrScannerOptions {
  timeoutMs?: number
}

/**
 * Scans an Aurora invite with the browser camera and the native BarcodeDetector
 * API. Native Android/iOS shells should prefer their platform scanner.
 */
export async function scanQrInviteWithBrowserCamera(
  options: BrowserQrScannerOptions = {},
): Promise<string | null> {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    throw new Error('QR scanning requires an interactive browser window.')
  }
  if (!window.isSecureContext) {
    throw new Error('QR scanning requires HTTPS, localhost, or a trusted native WebView.')
  }
  const Detector = (globalThis as typeof globalThis & {
    BarcodeDetector?: BarcodeDetectorConstructor
  }).BarcodeDetector
  if (!Detector) {
    throw new Error(
      'This browser does not provide camera QR decoding. Open an invite file or paste the invite instead.',
    )
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Camera capture is unavailable in this browser.')
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: { ideal: 'environment' } },
  })
  const video = document.createElement('video')
  video.autoplay = true
  video.muted = true
  video.playsInline = true
  video.srcObject = stream

  const overlay = document.createElement('div')
  overlay.setAttribute('role', 'dialog')
  overlay.setAttribute('aria-modal', 'true')
  overlay.setAttribute('aria-label', 'Scan Aurora QR invite')
  overlay.style.cssText =
    'position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;background:rgba(0,0,0,.82);padding:1rem'
  const panel = document.createElement('div')
  panel.style.cssText =
    'display:grid;gap:.75rem;width:min(32rem,100%);padding:1rem;border-radius:.75rem;background:#111;color:#fff'
  const title = document.createElement('strong')
  title.textContent = 'Point the camera at an Aurora invite QR code'
  const cancel = document.createElement('button')
  cancel.type = 'button'
  cancel.textContent = 'Cancel scan'
  cancel.style.cssText =
    'justify-self:end;border:1px solid #777;border-radius:.4rem;background:#222;color:#fff;padding:.45rem .7rem'
  video.style.cssText = 'width:100%;max-height:70vh;border-radius:.5rem;background:#000'
  panel.append(title, video, cancel)
  overlay.append(panel)
  document.body.append(overlay)

  let cancelled = false
  cancel.addEventListener('click', () => {
    cancelled = true
  })

  try {
    await video.play()
    const detector = new Detector({ formats: ['qr_code'] })
    const deadline = Date.now() + (options.timeoutMs ?? 30_000)
    while (!cancelled && Date.now() < deadline) {
      const results = await detector.detect(video)
      for (const result of results) {
        const value = result.rawValue?.trim()
        if (value && decodeMeshInvite(value)) return value
      }
      await delay(120)
    }
    return null
  } finally {
    for (const track of stream.getTracks()) track.stop()
    video.srcObject = null
    overlay.remove()
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, milliseconds)
  })
}
