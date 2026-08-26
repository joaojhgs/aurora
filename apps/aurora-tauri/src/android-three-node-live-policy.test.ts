import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const workspaceRoot = resolve(process.cwd(), '../..')
const runner = readFileSync(resolve(process.cwd(), 'scripts/run-android-three-node-live.mjs'), 'utf8')
const liveSpec = readFileSync(
  resolve(workspaceRoot, 'tests/e2e/android_three_node/android-three-node-main-live.spec.ts'),
  'utf8',
)

describe('Android full-stack three-node acceptance policy', () => {
  it('attaches to a caller-owned full Python stack and never starts the synthetic interop gateway', () => {
    expect(runner).toContain('AURORA_THREE_NODE_GATEWAY_URL')
    expect(runner).toContain('AURORA_THREE_NODE_ENV_FILE')
    expect(runner).not.toContain('webrtc_interop_gateway.py')
    expect(runner).not.toContain('main.py')
  })

  it('preserves Android state and proves native RTT plus simultaneous peer visibility', () => {
    expect(liveSpec).toContain("'aurora_thin_profile_get'")
    expect(liveSpec).not.toContain("'aurora_thin_profile_set'")
    expect(liveSpec).not.toMatch(/pm clear|uninstall/u)
    expect(liveSpec).toContain("'aurora_mesh_session_snapshot'")
    expect(liveSpec).toContain("'aurora_native_webrtc_measure_rtt'")
    expect(liveSpec).toContain('completeBackgroundWakeTurn')
    expect(liveSpec).toContain("'aurora_local_data_inspect_identity'")
    expect(liveSpec).toContain('backgroundVoicePersistedRecordDelta')
    expect(liveSpec).toContain('simultaneous Android and self-hosted UI sessions')
    expect(liveSpec).toContain('Android roster visibility for the self-hosted UI node')
  })
})
