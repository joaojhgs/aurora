import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as barcodeScanner from '@tauri-apps/plugin-barcode-scanner'
import { scanMeshInviteQr } from './mesh-deeplink'

vi.mock('@tauri-apps/plugin-barcode-scanner', () => ({
  Format: { QRCode: 'QR_CODE' },
  checkPermissions: vi.fn(),
  requestPermissions: vi.fn(),
  scan: vi.fn(),
}))

const checkPermissions = vi.mocked(barcodeScanner.checkPermissions)
const requestPermissions = vi.mocked(barcodeScanner.requestPermissions)
const scan = vi.mocked(barcodeScanner.scan)

describe('native mesh invite QR scanning', () => {
  beforeEach(() => {
    checkPermissions.mockReset()
    requestPermissions.mockReset()
    scan.mockReset()
    checkPermissions.mockResolvedValue('granted')
  })

  it('returns scanned QR content', async () => {
    scan.mockResolvedValue({
      content: 'aurora://mesh/invite?i=fixture',
      format: barcodeScanner.Format.QRCode,
      bounds: null,
    })

    await expect(scanMeshInviteQr()).resolves.toBe(
      'aurora://mesh/invite?i=fixture',
    )
    expect(scan).toHaveBeenCalledWith({
      windowed: false,
      formats: [barcodeScanner.Format.QRCode],
    })
  })

  it('settles as an empty scan when native cancellation is a string', async () => {
    scan.mockRejectedValue('cancelled')

    await expect(scanMeshInviteQr()).resolves.toBeNull()
  })

  it('settles as an empty scan when Android serializes cancellation as an object', async () => {
    scan.mockRejectedValue({ message: 'cancelled' })

    await expect(scanMeshInviteQr()).resolves.toBeNull()
  })

  it('preserves non-cancellation scanner failures', async () => {
    scan.mockRejectedValue(new Error('camera unavailable'))

    await expect(scanMeshInviteQr()).rejects.toThrow('camera unavailable')
  })
})
