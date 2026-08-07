import { describe, expect, it } from 'vitest'

import * as browserEntry from '../src/browser.js'
import * as rootEntry from '../src/index.js'

describe('@aurora/voice-web entrypoints', () => {
  it('keeps browser constructors on the explicit browser entrypoint', () => {
    expect(browserEntry).toHaveProperty('createAuroraBrowserVoiceRuntime')
    expect(browserEntry).toHaveProperty('BrowserAudioWorkletPcmSource')
    expect(browserEntry).toHaveProperty('AuroraBrowserModelStoreHost')
    expect(browserEntry).toHaveProperty('AuroraAcknowledgedWorkerHost')
  })

  it('keeps the root entrypoint free of browser and WASM constructors', () => {
    expect(rootEntry).not.toHaveProperty('createAuroraBrowserVoiceRuntime')
    expect(rootEntry).not.toHaveProperty('BrowserAudioWorkletPcmSource')
    expect(rootEntry).not.toHaveProperty('AuroraWasmVoiceBridge')
  })
})
