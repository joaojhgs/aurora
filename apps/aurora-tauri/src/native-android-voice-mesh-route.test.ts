import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const repoRoot = resolve(__dirname, '../../..');
const servicePath = resolve(
  repoRoot,
  'apps/aurora-tauri/src-tauri/android/aurora-native-plugin/src/main/java/dev/aurora/tauri/nativeplugin/AuroraRuntimeForegroundService.kt',
);
const rustBridgePath = resolve(repoRoot, 'apps/aurora-tauri/src-tauri/src/android_audio.rs');

function readSource(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('Android native assistant mesh route', () => {
  it('derives assistant mode and preferred peer from the persisted runtime profile', () => {
    const source = readSource(servicePath);

    expect(source).toContain('activeVoiceRouteProfile(context)');
    expect(source).toContain('home?.optString("mode")');
    expect(source).toContain('profile.optString("mode")');
    expect(source).toContain('mode !in setOf("http-only", "webrtc-preferred")');
    expect(source).toContain('home?.optString("homePeerId")');
    expect(source).toContain('optString("expectedStablePeerId")');
    expect(source).not.toMatch(/System\.getenv|BuildConfig\.[A-Z_]*ASSISTANT|AURORA_.*ASSISTANT/);
  });

  it('passes assistant routing hints through JNI for both native session constructors', () => {
    const kotlin = readSource(servicePath);
    const rust = readSource(rustBridgePath);

    expect(kotlin).toContain('nativeConfig.assistantRouteMode');
    expect(kotlin).toContain('nativeConfig.preferredStablePeerId');
    expect(kotlin).toContain('assistantRouteMode: String');
    expect(kotlin).toContain('preferredStablePeerId: String');
    expect(rust).toContain('assistant_route_mode: JString');
    expect(rust).toContain('preferred_stable_peer_id: JString');
    expect(rust).toContain('AndroidAssistantRouteMode::parse(&assistant_route_mode)');
    expect(rust).toContain('.with_assistant_route(assistant_route_mode, preferred_stable_peer_id)');
  });

  it('keeps assistant starts on the existing foreground service action', () => {
    const source = readSource(servicePath);

    expect(source).toContain('intent?.action == ACTION_START_ASSISTANT');
    expect(source).toContain('AuroraRuntimeForegroundLedger.acquireOnce(AuroraRuntimeForegroundReason.VOICE)');
    expect(source).toContain('enterForeground("Starting microphone');
  });
});
