import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  AppShell,
  getAuroraSurfaceProfile,
  getAuroraNavItem,
  loadingShellSnapshot,
  navItemSnapshot,
  type RouteAvailability,
} from "@aurora/ui";
import { findForbiddenProductionCopyTerms } from "../../../packages/aurora-ui/src/product-copy-forbidden-terms";
import { createAuroraTauriRuntime } from "./aurora-client";
import {
  MissingTauriRoute,
  TauriReadinessError,
  assertReadySidecar,
  androidBaselineLabel,
  assistantRoleProbeLabel,
  connectionModeLabel,
  iosInvocationLabel,
  localLightInferenceLabel,
  nativeFeatureLabel,
  peerConnectionStatusLabel,
  requestTauriNativeAccess,
  runtimeModeLabel,
  savedAccessLabel,
  tauriRouteRegistry,
  transportKindLabel,
  waitForGatewayReadiness,
} from "./tauri-app";

function expectProductCopy(...values: string[]) {
  for (const value of values) {
    const matches = findForbiddenProductionCopyTerms(value).map(
      (term) => term.id,
    );
    expect(matches, value).toEqual([]);
  }
}

describe("Tauri application product copy", () => {
  it("routes Android device access through native commands only for supported choices", async () => {
    const requestAssistantRole = vi.fn(async () => null);
    const requestPermission = vi.fn(async (_permission: string) => null);
    const port = {
      requestAndroidAssistantRole: requestAssistantRole,
      requestAndroidPermission: requestPermission,
    };

    await requestTauriNativeAccess(port, "android.assistantRole");
    await requestTauriNativeAccess(port, "aurora.android.microphone");
    await requestTauriNativeAccess(port, "aurora.android.notifications");
    await requestTauriNativeAccess(port, "aurora.android.voiceForegroundService");

    expect(requestAssistantRole).toHaveBeenCalledTimes(1);
    expect(requestPermission.mock.calls.map(([permission]) => permission)).toEqual([
      "aurora.android.microphone",
      "aurora.android.notifications",
      "aurora.android.voiceForegroundService",
    ]);
    await expect(requestTauriNativeAccess(port, "android.unsupported"))
      .rejects.toMatchObject({ code: "unsupported_feature" });
  });

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
        available: true,
        state: "pending_native_target",
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
      "Needs attention; Aurora does not replace the system assistant",
      "Available through a connected Aurora device",
      "Available through a connected Aurora device",
      "Not available",
      "Not configured",
      "Checking",
      "No saved access",
    ]);
    expectProductCopy(...values);
  });

  it("keeps Android assistant role labels truthful for unavailable request paths", () => {
    const baseStatus = {
      available: true,
      state: "available",
      feature: "android-assistant-role",
      fallbackEntrypoints: {},
      evidenceSource: "android-rolemanager-package-manager",
      platform: "android",
      secretsRedacted: true,
    };
    const values = [
      assistantRoleProbeLabel({
        ...baseStatus,
        assistantRole: {
          probeImplemented: true,
          roleHeld: false,
          roleAvailable: false,
          requestable: false,
          packageQualified: false,
          denied: true,
          oemUnavailable: false,
          reason: "request_denied",
        },
      }),
      assistantRoleProbeLabel({
        ...baseStatus,
        assistantRole: {
          probeImplemented: true,
          roleHeld: false,
          roleAvailable: false,
          requestable: false,
          packageQualified: false,
          denied: false,
          oemUnavailable: true,
          reason: "oem_unavailable",
        },
      }),
      assistantRoleProbeLabel({
        ...baseStatus,
        assistantRole: {
          probeImplemented: true,
          roleHeld: false,
          roleAvailable: false,
          requestable: false,
          packageQualified: false,
          denied: false,
          oemUnavailable: false,
          reason: "package_not_qualified",
        },
      }),
    ];

    expect(values).toEqual(["Permission needed", "Not available", "Not available"]);
    expectProductCopy(...values);
  });

  it("renders hostile Tauri route states without echoing command or diagnostic metadata", () => {
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
      nativePermissions: [
        {
          name: "sidecar.debug.permission",
          granted: false,
          nativeState: "manifest.schema.denied",
        },
      ],
      nativeCapabilities: [
        {
          name: "provider.runtime.capability",
          enabled: false,
          nativeState: "sqlite.migration.failed",
        },
      ],
    };
    const client = createAuroraTauriRuntime().client;
    const route = routeFor("assistant");

    const routeMarkups = [
      tauriRouteRegistry.assistant({
        route,
        snapshot,
        nativeContext,
        client,
        shutdown: async () => undefined,
        assistantNativePermissions: snapshot.nativePermissions,
        assistantNativeCapabilities: snapshot.nativeCapabilities,
      } as never),
      tauriRouteRegistry.settings({
        route: routeFor("settings"),
        snapshot,
        nativeContext,
        client,
        shutdown: async () => undefined,
        assistantNativePermissions: [],
        assistantNativeCapabilities: [],
      } as never),
      tauriRouteRegistry.diagnostics({
        route: routeFor("diagnostics"),
        snapshot,
        nativeContext,
        client,
        shutdown: async () => undefined,
        assistantNativePermissions: [],
        assistantNativeCapabilities: [],
      } as never),
      tauriRouteRegistry.admin({
        route: routeFor("admin"),
        snapshot,
        nativeContext,
        client,
        shutdown: async () => undefined,
        assistantNativePermissions: [],
        assistantNativeCapabilities: [],
      } as never),
      <MissingTauriRoute route={hostileRoute()} />,
      tauriRouteRegistry.native({
        snapshot,
        nativeContext,
        route: routeFor("native"),
        client,
        shutdown: async () => undefined,
        assistantNativePermissions: [],
        assistantNativeCapabilities: [],
      } as never),
    ].map((element) => renderToStaticMarkup(element));

    const rendered = routeMarkups.map(renderedUserCopy).join(" ");

    expect(rendered).toContain("Device controls");
    expect(rendered).toContain("2 permissions need review");
    expect(rendered).toContain("Aurora on this computer");
    expect(rendered).toContain("Needs attention");
    for (const leaked of [
      "manifest.schema.permission",
      "provider.runtime.capability",
      "local:Orchestrator",
      "secret.example",
      "SQLite migration failed",
      "WebView transport",
      "sidecar debug",
      "Runtime protocol migration",
    ]) {
      expect(rendered).not.toContain(leaked);
    }
    expectProductCopy(rendered);
  });

  it("renders mobile tab state labels without raw availability states", () => {
    const routes = [
      { ...routeFor("assistant"), state: "available-remote" as const },
      { ...routeFor("mesh"), state: "unsupported" as const },
      { ...routeFor("settings"), state: "degraded" as const },
    ];
    const markup = renderToStaticMarkup(
      <AppShell
        snapshot={{
          ...loadingShellSnapshot,
          loadState: "ready",
          routes,
        }}
        currentPath="/mesh"
        runtimeMode="mobile-native"
      >
        <main>Mobile shell</main>
      </AppShell>,
    );
    const rendered = renderedUserCopy(markup);

    expect(rendered).toContain("Assistant tab, available");
    expect(rendered).toContain("Mesh tab, not available");
    expect(rendered).toContain("Settings tab, needs attention");
    expect(rendered).not.toContain("mobile tab: unsupported");
    expect(rendered).not.toContain("mobile tab: degraded");
    expectProductCopy(rendered);
  });

  it("preserves redacted startup diagnostics outside rendered error copy", async () => {
    const sidecar = {
      running: false,
      mode: "sidecar",
      gatewayUrl: "http://127.0.0.1:8000",
      lastError:
        "SQLite migration failed in sidecar debug mode for token=secret-token at https://secret.example/path",
      details: {
        room_password: "super-secret",
        provider: "local:Orchestrator",
      },
    };

    expect(() => assertReadySidecar(sidecar)).toThrow(TauriReadinessError);
    try {
      assertReadySidecar(sidecar);
    } catch (error) {
      expect(error).toBeInstanceOf(TauriReadinessError);
      const readiness = error as TauriReadinessError;
      expect(readiness.message).toBe(
        "Aurora on this computer could not start. Restart Aurora and try again.",
      );
      expect(readiness.diagnosticCause.code).toBe(
        "AURORA_TAURI_SIDECAR_NOT_READY",
      );
      expect(readiness.diagnosticCause.sidecar.lastError).toContain(
        "SQLite migration failed in sidecar debug mode",
      );
      expect(readiness.diagnosticCause.sidecar.lastError).not.toContain(
        "secret.example",
      );
      expect(readiness.diagnosticCause.sidecar.details).toContain(
        "room_password",
      );
      expect(readiness.diagnosticCause.sidecar.details).not.toContain(
        "super-secret",
      );
      expectProductCopy(readiness.message);
    }
  });

  it("preserves the last Gateway readiness probe in non-rendered diagnostics", async () => {
    vi.useFakeTimers();
    try {
      const lastProbeError = new Error(
        "Gateway WebRTC transport probe failed at http://127.0.0.1:8000/api/health with bearer=secret-token",
      );
      const runtime = {
        client: {
          request: async () => {
            throw lastProbeError;
          },
          registry: {
            getRegistry: async () => ({}),
            listServices: async () => ({ services: [] }),
          },
          memory: {
            listSessions: async () => ({ ok: true, sessions: [] }),
          },
        },
        sidecarStatus: async () => ({
          running: true,
          mode: "threads",
          gatewayUrl: "http://127.0.0.1:8000",
          lastError: null,
          details: { healthPath: "/api/health" },
        }),
      };
      const readiness = waitForGatewayReadiness(
        runtime as never,
        {
          running: true,
          mode: "threads",
          gatewayUrl: "http://127.0.0.1:8000",
          lastError: null,
          details: { healthPath: "/api/health" },
        },
        () => undefined,
      );
      const captured = readiness.catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(90_000);
      const error = await captured;
      expect(error).toMatchObject({
        code: "AURORA_TAURI_GATEWAY_NOT_READY",
        message:
          "Aurora on this computer did not finish starting. Restart Aurora and try again.",
      });
      expect(error).toBeInstanceOf(TauriReadinessError);
      const diagnostic = (error as TauriReadinessError).diagnosticCause;
      expect(diagnostic.gateway?.lastProbeError).toContain(
        "Gateway WebRTC transport probe failed",
      );
      expect(diagnostic.gateway?.lastProbeError).not.toContain("secret-token");
      expect(diagnostic.gateway?.lastProbeError).not.toContain(
        "127.0.0.1:8000",
      );
      expectProductCopy((error as Error).message);
    } finally {
      vi.useRealTimers();
    }
  });
});

function routeFor(id: string): RouteAvailability {
  const item = getAuroraNavItem(id);
  if (!item) throw new Error(`Missing test route ${id}`);
  return {
    item: navItemSnapshot(item),
    state: "available-local",
    explanation: "Available on this device.",
    providerLabel: "This device",
    blockers: [],
    repairActions: [],
    candidateProviders: [],
    evidenceSources: [],
    selectorRequired: false,
    approvalRequired: false,
    routeable: true,
    disabled: false,
    requiresAdminAction: item.adminGated ?? false,
  };
}

function hostileRoute(): RouteAvailability {
  return {
    ...routeFor("native"),
    item: {
      ...routeFor("native").item,
      label: "Runtime protocol migration",
    },
    explanation: "sidecar manifest provider route failed",
    providerLabel: "WebView transport",
    evidenceSources: ["SQLite migration fixture"],
  };
}

function renderedUserCopy(markup: string): string {
  const attributes = Array.from(
    markup.matchAll(
      /\s(?:aria-label|title|placeholder|alt|disabledreason)=["']([^"']*)["']/giu,
    ),
    (match) => match[1] ?? "",
  );
  const text = markup
    .replace(/<script[\s\S]*?<\/script>/giu, " ")
    .replace(/<style[\s\S]*?<\/style>/giu, " ")
    .replace(/<[^>]+>/gu, " ");
  return decodeHtml([text, ...attributes].join(" "))
    .replace(/\s+/gu, " ")
    .trim();
}

function decodeHtml(value: string): string {
  return value
    .replace(/&nbsp;/gu, " ")
    .replace(/&amp;/gu, "&")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&#x27;|&apos;|&#39;/gu, "'")
    .replace(/\s+/gu, " ");
}
