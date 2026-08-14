import { test, expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'

const runSmoke = process.env.AURORA_VOICE_WEB_SHERPA_BROWSER_SMOKE === '1'

test.describe('Sherpa browser worker smoke', () => {
  test.skip(!runSmoke, 'Set AURORA_VOICE_WEB_SHERPA_BROWSER_SMOKE=1 with neutral no-.data Sherpa browser assets to run.')

  test('accepts only neutral engine assets before browser execution', async ({ page }) => {
    const jsPath = requiredEnv('AURORA_VOICE_WEB_SHERPA_BROWSER_ENGINE_JS')
    const wasmPath = requiredEnv('AURORA_VOICE_WEB_SHERPA_BROWSER_ENGINE_WASM')
    expect(jsPath.endsWith('.data')).toBe(false)
    expect(wasmPath.endsWith('.data')).toBe(false)

    const source = new TextDecoder().decode(await readFile(jsPath))
    expect(source).not.toMatch(/\.data(?:["'`)\s?&]|$)/i)
    expect(source).not.toMatch(/remote_package_size|getPreloadedPackage|expectedDataFileDownloads|FS_createPreloadedFile|loadPackage|PACKAGE_NAME/i)

    const browserResult = await page.evaluate(async ({ jsBytes, wasmBytes }) => {
      const jsUrl = URL.createObjectURL(new Blob([jsBytes], { type: 'text/javascript' }))
      const wasmUrl = URL.createObjectURL(new Blob([wasmBytes], { type: 'application/wasm' }))
      try {
        const jsResponse = await fetch(jsUrl)
        const wasmResponse = await fetch(wasmUrl)
        return {
          jsOk: jsResponse.ok,
          wasmOk: wasmResponse.ok,
          jsTextHasData: (await jsResponse.text()).includes('.data'),
          wasmBytes: (await wasmResponse.arrayBuffer()).byteLength
        }
      } finally {
        URL.revokeObjectURL(jsUrl)
        URL.revokeObjectURL(wasmUrl)
      }
    }, {
      jsBytes: await readFile(jsPath),
      wasmBytes: await readFile(wasmPath)
    })

    expect(browserResult).toEqual({
      jsOk: true,
      wasmOk: true,
      jsTextHasData: false,
      wasmBytes: expect.any(Number)
    })
    expect(browserResult.wasmBytes).toBeGreaterThan(0)
  })
})

function requiredEnv(key: string): string {
  const value = process.env[key]
  if (value === undefined || value === '') throw new Error(`${key} is required`)
  return value
}
