import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const repoRoot = resolve(__dirname, '../../..');
const servicePath = resolve(
  repoRoot,
  'apps/aurora-tauri/src-tauri/android/aurora-native-plugin/src/main/java/dev/aurora/tauri/nativeplugin/AuroraRuntimeForegroundService.kt',
);
const rustBridgePath = resolve(repoRoot, 'apps/aurora-tauri/src-tauri/src/android_audio.rs');
const rustSessionPath = resolve(repoRoot, 'rust/crates/aurora-voice-native/src/android_session.rs');

function readSource(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('Android native assistant mesh route', () => {
  it('derives assistant mode and preferred peer from the persisted runtime profile', () => {
    const source = readSource(servicePath);

    expect(source).toContain('activeVoiceRouteProfile(context)');
    expect(source).toContain('home?.optString("mode")');
    expect(source).toContain('profile.optString("mode")');
    expect(source).toContain('mode !in setOf("http-only", "webrtc-preferred", "webrtc-only")');
    expect(source).toContain('home?.optString("homePeerId")');
    expect(source).toContain('optString("expectedStablePeerId")');
    expect(source).toContain('if (mode == "webrtc-only" && peerId == null) return null');
    expect(source).not.toMatch(/System\.getenv|BuildConfig\.[A-Z_]*ASSISTANT|AURORA_.*ASSISTANT/);
  });

  it('passes assistant routing hints through JNI for both native session constructors', () => {
    const kotlin = readSource(servicePath);
    const rustBridge = readSource(rustBridgePath);
    const rustSession = readSource(rustSessionPath);

    expect(kotlin).toContain('nativeConfig.assistantRouteMode');
    expect(kotlin).toContain('nativeConfig.preferredStablePeerId');
    expect(kotlin).toContain('assistantRouteMode: String');
    expect(kotlin).toContain('preferredStablePeerId: String');
    expect(rustBridge).toContain('assistant_route_mode: JString');
    expect(rustBridge).toContain('preferred_stable_peer_id: JString');
    expect(rustBridge).toContain('AndroidAssistantRouteMode::parse(&assistant_route_mode)');
    expect(rustBridge).toContain('.with_assistant_route(assistant_route_mode, preferred_stable_peer_id)');
    expect(rustBridge).toContain('optional_gateway_from_jni');
    expect(rustSession).toContain('pub fn with_assistant_route(');
  });

  it('keeps pure WebRTC voice local for microphone audio and routes assistant text over native mesh', () => {
    const kotlin = readSource(servicePath);
    const rust = readSource(rustSessionPath);

    expect(kotlin).toContain('routeProfile.mode == "webrtc-only"');
    expect(kotlin).toContain('gateway = ""');
    const createSession = kotlin.slice(
      kotlin.indexOf('private fun createNativeVoiceSession('),
      kotlin.indexOf('private fun attachNativeVoiceSession('),
    );
    expect(createSession).toContain('if (sttModelId != null && ttsVoiceId != null && sttReady && ttsReady');
    expect(createSession).toMatch(/if \(sttModelId[\s\S]*return AuroraNativeVoiceSessionBridge\([\s\S]*return null/);
    expect(createSession).not.toContain('nativeConfig.assistantRouteMode in setOf');
    expect(rust).toContain('AndroidAssistantRouteMode::WebRtcOnly');
  });

  it('starts local speech without any assistant connection route', () => {
    const kotlin = readSource(servicePath);
    const rust = readSource(rustSessionPath);

    expect(kotlin).toContain('assistantRouteMode = "local-only"');
    expect(rust).toContain('AndroidAssistantRouteMode::LocalOnly');
    expect(rust).toContain('AndroidAssistantTransport::Unavailable');
  });

  it('keeps assistant starts on the existing foreground service action', () => {
    const source = readSource(servicePath);

    expect(source).toContain('intent?.action == ACTION_START_ASSISTANT');
    expect(source).toContain('AuroraRuntimeForegroundLedger.acquireOnce(AuroraRuntimeForegroundReason.VOICE)');
    expect(source).toContain('enterForeground("Preparing voice');
  });
});
