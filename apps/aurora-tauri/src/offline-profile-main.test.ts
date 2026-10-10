import { describe, expect, it, vi } from "vitest";
import { isRuntimeProfileConfigured } from "@aurora/ui";
import {
  createAuroraTauriRuntime,
  createMemoryRuntimeProfileStore,
} from "./aurora-client";

describe("on-device profile main flow", () => {
  it("creates and reloads an active mobile profile without an invite", async () => {
    const userAgent = vi.spyOn(window.navigator, "userAgent", "get")
      .mockReturnValue("Mozilla/5.0 (Linux; Android 14; Aurora Tauri WebView)");
    const originalTauri = Object.getOwnPropertyDescriptor(window, "__TAURI__");
    Object.defineProperty(window, "__TAURI__", { value: {}, configurable: true });
    const store = createMemoryRuntimeProfileStore({
      version: 2,
      activeProfileId: null,
      profiles: [],
    });
    const runtime = createAuroraTauriRuntime({
      runtimeProfileStore: store,
      runtimeProfileDocument: await store.load(),
    });
    try {
      expect(runtime.thinProfileController?.createOfflineProfile).toBeTypeOf("function");
      await runtime.thinProfileController!.createOfflineProfile!();
      const saved = await store.load();
      expect(saved.profiles).toHaveLength(1);
      const profile = saved.profiles[0]!;
      expect(saved.activeProfileId).toBe(profile.id);
      expect(profile.localNode.stablePeerId).toMatch(/^aurora-local-/u);
      expect(profile.nodeMode).toBe("mesh-node");
      expect(profile.runtimeTier).toBe("lightweight-ts");
      expect(profile.localNode.enabledCapabilityPacks).toEqual(["local-inference"]);
      expect(profile.homeConnection).toBeUndefined();
      expect(profile.localNode.meshMembership).toBeUndefined();
      expect(isRuntimeProfileConfigured(profile)).toBe(true);
      expect(runtime.thinProfileController!.runtimeDocument).toEqual(saved);
    } finally {
      await runtime.dispose();
      userAgent.mockRestore();
      if (originalTauri) Object.defineProperty(window, "__TAURI__", originalTauri);
      else delete (window as typeof window & { __TAURI__?: unknown }).__TAURI__;
    }
  });
});
