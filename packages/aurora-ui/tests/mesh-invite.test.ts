import { describe, expect, it, vi } from 'vitest'
import {
  decodeMeshInvite,
  encodeMeshInviteToken,
  encodeMeshInviteUrl,
  extractMeshInviteToken,
  meshInviteSummary,
  MESH_INVITE_KIND,
} from '../src/mesh-invite'
import { commitMeshConfigChangeSet, meshInviteConfigChanges } from '../src/mesh-peers-view'
import type { AuroraClient } from '@aurora/client'
import type { JsonObject } from '@aurora/client'

const invite: JsonObject = {
  kind: MESH_INVITE_KIND,
  version: 1,
  generated_at: '2026-07-09T12:00:00Z',
  node: { peer_id: 'peer-studio', node_name: 'Studio Node — café edition' },
  mesh: { enabled: true, version_policy: 'compatible', peer_selection: 'lowest_latency' },
  signaling: {
    provider: 'mqtt',
    app_id: 'aurora',
    room: 'aurora-studio-room',
    room_password: 'secret-room-key',
    encrypt_signaling: true,
    mqtt_brokers: ['wss://broker.emqx.io:8084/mqtt'],
    mqtt_topic_root: 'aurora',
  },
  webrtc: { enabled: true, app_layer_e2ee: true, stun_servers: ['stun:stun.l.google.com:19302'], turn_servers: [] },
}

describe('mesh invite codec', () => {
  it('round-trips an invite through the aurora:// URL with unicode intact', () => {
    const url = encodeMeshInviteUrl(invite)
    expect(url.startsWith('aurora://mesh/invite?i=amv1.')).toBe(true)
    expect(decodeMeshInvite(url)).toEqual(invite)
  })

  it('decodes bare tokens, URL-encoded links, and tokens embedded in surrounding text', () => {
    const token = encodeMeshInviteToken(invite)
    expect(decodeMeshInvite(token)).toEqual(invite)
    expect(decodeMeshInvite(`https://redirect.example/open?target=${encodeURIComponent(encodeMeshInviteUrl(invite))}`)).toEqual(invite)
    expect(decodeMeshInvite(`Join my mesh! ${token} — see you there`)).toEqual(invite)
  })

  it('accepts legacy raw JSON payloads and rejects everything else', () => {
    expect(decodeMeshInvite(JSON.stringify(invite))).toEqual(invite)
    expect(decodeMeshInvite(JSON.stringify({ kind: 'other' }))).toBeNull()
    expect(decodeMeshInvite('not an invite')).toBeNull()
    expect(decodeMeshInvite('amv1.%%%')).toBeNull()
    expect(extractMeshInviteToken('nothing here')).toBeNull()
  })

  it('summarizes the invite for the join preview', () => {
    const summary = meshInviteSummary(invite)
    expect(summary.nodeName).toBe('Studio Node — café edition')
    expect(summary.room).toBe('aurora-studio-room')
    expect(summary.brokerCount).toBe(1)
    expect(summary.includesPassword).toBe(true)
    expect(summary.pairingCode).toBeNull()
  })

  it('applies credentials before enabling direct device connections without duplicate keys', () => {
    const changes = meshInviteConfigChanges(invite)
    const byKey = Object.fromEntries(changes.map((change) => [change.key_path, change.value]))
    expect(byKey['services.gateway.mesh_network.enabled']).toBe(true)
    expect(byKey['services.gateway.webrtc.enabled']).toBe(true)
    expect(byKey['services.gateway.webrtc.app_id']).toBe('aurora')
    expect(byKey['services.gateway.webrtc.room']).toBe('aurora-studio-room')
    expect(byKey['services.gateway.webrtc.password']).toBe('secret-room-key')
    expect(byKey['services.gateway.signaling_mqtt.brokers']).toEqual(['wss://broker.emqx.io:8084/mqtt'])
    expect(byKey).not.toHaveProperty('services.gateway.webrtc.turn_servers')

    const indexOf = (keyPath: string) => changes.findIndex((change) => change.key_path === keyPath)
    const webRtcEnabledIndex = indexOf('services.gateway.webrtc.enabled')
    const meshEnabledIndex = indexOf('services.gateway.mesh_network.enabled')
    for (const credential of [
      'services.gateway.webrtc.app_id',
      'services.gateway.webrtc.room',
      'services.gateway.webrtc.password',
    ]) {
      expect(indexOf(credential), `${credential} must be applied before WebRTC starts`).toBeGreaterThanOrEqual(0)
      expect(indexOf(credential), `${credential} must be applied before WebRTC starts`).toBeLessThan(webRtcEnabledIndex)
    }
    expect(meshEnabledIndex).toBeLessThan(webRtcEnabledIndex)
    expect(new Set(changes.map((change) => change.key_path)).size).toBe(changes.length)
  })

  it('previews once and commits mesh config as one atomic change set', async () => {
    const changes = meshInviteConfigChanges(invite)
    const previewDiff = vi.fn(async () => ({
      ok: true as const,
      data: {
        valid: true,
        diffs: [],
        errors: [],
        secrets_redacted: true,
        base_revision: 12,
        preview_token: 'mesh-preview-12',
        changed_paths: changes.map((change) => change.key_path),
      },
    }))
    const previewReloadImpact = vi.fn(async () => ({ ok: true as const, data: { impacted_services: [] } }))
    const commitChangeSet = vi.fn(async (_input: unknown) => ({
      data: {
        success: true,
        revision: 13,
        changed_paths: changes.map((change) => change.key_path),
        error: null,
        error_code: null,
      },
    }))
    const client = { config: { previewDiff, previewReloadImpact, commitChangeSet } } as unknown as AuroraClient

    await expect(commitMeshConfigChangeSet(client, changes, 'Join mesh from invite for Studio', 'Invite invalid')).resolves.toEqual(
      changes.map((change) => change.key_path),
    )
    expect(previewDiff).toHaveBeenCalledTimes(1)
    expect(previewReloadImpact).toHaveBeenCalledWith({ changes })
    expect(commitChangeSet).toHaveBeenCalledTimes(1)
    expect(commitChangeSet.mock.calls[0]?.[0]).toEqual({
      request: { changes, base_revision: 12, preview_token: 'mesh-preview-12' },
      reason: 'Join mesh from invite for Studio',
      reauthConfirmed: true,
    })
  })
})
