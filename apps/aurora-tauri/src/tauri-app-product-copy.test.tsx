import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  getAuroraSurfaceProfile,
  loadingShellSnapshot,
} from "@aurora/ui";
import {
  androidBaselineLabel,
  assistantRoleProbeLabel,
  connectionModeLabel,
  iosInvocationLabel,
  localLightInferenceLabel,
  nativeFeatureLabel,
  peerConnectionStatusLabel,
  runtimeModeLabel,
  savedAccessLabel,
  tauriRouteRegistry,
  transportKindLabel,
} from "./tauri-app";

const forbiddenRenderedCopy =
  /\b(?:assertion|consumer|contract|debug|evidence|fallback|fixture|hybrid|implementation|indexeddb|manifest|migration|opfs|protocol|provider|route counts?|runtime tier|schema|sidecar|sqlite|tested|thin|transport state|webview)\b/i;

function expectProductCopy(...values: string[]) {
  for (const value of values) {
    expect(value).not.toMatch(forbiddenRenderedCopy);
  }
}

describe("Tauri application product copy", () => {
  it("maps hostile internal states through closed user-facing labels", () => {
    const values = [
      runtimeModeLabel("desktop-thin"),
      runtimeModeLabel("hostile-runtime-provider"),
      transportKindLabel("webrtc", "desktop-thin"),
      transportKindLabel("hostile-transport", "hostile-runtime"),
      nativeFeatureLabel({
        available: false,
        permission: "manifest.schema",
        capability: "provider.runtime",
        source: "WebView transport",
        reason: "SQLite migration failed",
      }),
      iosInvocationLabel({
        available: false,
        surface: "sidecar-runtime",
        supportedActions: [],
        siriReplacement: false,
        requiresBackendEvidence: true,
        secretsRedacted: true,
      }),
      localLightInferenceLabel({
        available: false,
        state: "fallback",
        feature: "provider-runtime",
        details: { source: "WebView transport" },
        evidenceSource: "manifest fixture",
        secretsRedacted: true,
      } as never),
      androidBaselineLabel({
        available: false,
        state: "fallback",
        feature: "provider-runtime",
        assistantRole: {
          probeImplemented: true,
          roleHeld: false,
          reason: "schema migration debug",
        },
        fallbackEntrypoints: {},
        evidenceSource: "manifest fixture",
        platform: "WebView",
        secretsRedacted: true,
      }),
      assistantRoleProbeLabel({
        available: false,
        state: "hostile-provider-state",
        feature: "provider-runtime",
        assistantRole: {
          probeImplemented: true,
          roleHeld: false,
          reason: "schema migration debug",
        },
        fallbackEntrypoints: {},
        evidenceSource: "manifest fixture",
        platform: "WebView",
        secretsRedacted: true,
      }),
      connectionModeLabel("hostile-transport"),
      peerConnectionStatusLabel("hostile-protocol-state"),
      savedAccessLabel(undefined),
    ];

    expect(values).toEqual([
      "Connected to another Aurora device",
      "Aurora setup unavailable",
      "Direct device connection",
      "Connection unavailable",
      "Permission needed",
      "Not available; Aurora does not replace the system assistant",
      "Available through a connected Aurora device",
      "Available through a connected Aurora device",
      "Not available",
      "Not configured",
      "Checking",
      "No saved access",
    ]);
    expectProductCopy(...values);
  });

  it("renders native device controls without echoing command or diagnostic metadata", () => {
    const hostileFeature = {
      available: false,
      permission: "manifest.schema.permission",
      capability: "provider.runtime.capability",
      source: "WebView transport",
      reason: "SQLite migration failed in sidecar debug mode",
    };
    const nativeContext = {
      runtimeMode: "desktop-local",
      localMode: true,
      sidecar: {
        running: false,
        mode: "sidecar",
        gatewayUrl: "https://secret.example/internal",
        lastError: "SQLite migration failed in sidecar debug mode",
        details: { provider: "local:Orchestrator" },
      },
      surfaceProfile: getAuroraSurfaceProfile({
        runtimeMode: "desktop-local",
        transportKind: "tauri",
        nativePlatform: "linux",
      }),
      thinConnectionMode: "webrtc-only",
      saveThinProfile: async () => undefined,
      selectThinProfile: async () => undefined,
      nativePermissions: {
        platform: "WebView",
        permissions: { "manifest.schema.permission": false },
        capabilities: { "provider.runtime.capability": false },
        deniedByDefault: [
          "sidecar.debug.permission",
          "sqlite.migration.permission",
        ],
        privacyClasses: ["raw-audio"],
        evidenceSource: "contract fixture",
        secretsRedacted: true,
      },
      nativeFeatures: {
        tray: hostileFeature,
        notifications: hostileFeature,
        dialogs: hostileFeature,
        audio: hostileFeature,
      },
      iosInvocationStatus: null,
      iosLocalLightStatus: null,
      androidBaseline: null,
      androidForeground: null,
      androidMediaPolicy: null,
    };
    const snapshot = {
      ...loadingShellSnapshot,
      loadState: "ready" as const,
      nativePlatform: "linux",
      nativeAvailable: true,
    };

    const markup = renderToStaticMarkup(
      tauriRouteRegistry.native({
        snapshot,
        nativeContext,
      } as never),
    );

    expect(markup).toContain("Device controls");
    expect(markup).toContain("2 permissions need review");
    expect(markup).toContain("Aurora on this computer");
    expect(markup).toContain("Needs attention");
    expect(markup).not.toContain("manifest.schema.permission");
    expect(markup).not.toContain("provider.runtime.capability");
    expect(markup).not.toContain("local:Orchestrator");
    expect(markup).not.toContain("secret.example");
    expectProductCopy(markup);
  });
});
