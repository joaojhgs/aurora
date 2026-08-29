import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { createTauriAssistantProviderClient } from "./tauri-assistant-provider";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("Tauri assistant provider boundary", () => {
  it("configures and reads status through narrow redacted commands", async () => {
    const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === "aurora_assistant_provider_configure") {
        expect(args).toEqual({
          request: {
            provider: "openai-compatible",
            endpoint: "https://llm.example/v1/chat/completions",
            model: "model-a",
            apiKey: "sk-secret",
          },
        });
      }
      return {
        configured: true,
        enabled: true,
        provider: "openai-compatible",
        endpoint: "https://llm.example/v1/chat/completions",
        model: "model-a",
        backend: "platform-keychain",
        persisted: true,
        secretsRedacted: true,
        redactedFields: ["apiKey"],
      };
    });
    const client = createTauriAssistantProviderClient({ commandAdapter: invoke });

    await expect(client.configure({
      provider: "openai-compatible",
      endpoint: "https://llm.example/v1/chat/completions",
      model: "model-a",
      apiKey: "sk-secret",
    })).resolves.toMatchObject({
      configured: true,
      secretsRedacted: true,
      redactedFields: ["apiKey"],
    });
    await expect(client.status()).resolves.toMatchObject({ enabled: true });

    expect(invoke.mock.calls.map(([command]) => command)).toEqual([
      "aurora_assistant_provider_configure",
      "aurora_assistant_provider_status",
    ]);
  });

  it("completes turns without sending provider secrets from WebView JavaScript", async () => {
    const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      expect(command).toBe("aurora_assistant_provider_complete");
      expect(JSON.stringify(args)).not.toContain("sk-secret");
      expect(args).toMatchObject({
        request: {
          maxToolCalls: 4,
          messages: [{ role: "user", content: "hello" }],
          tools: [],
        },
      });
      return { type: "message", content: "hello from native provider" };
    });
    const client = createTauriAssistantProviderClient({ commandAdapter: invoke });

    await expect(client.provider.complete({
      messages: [{ role: "user", content: "hello" }],
      tools: [],
      maxToolCalls: 4,
      signal: new AbortController().signal,
    })).resolves.toEqual({ type: "message", content: "hello from native provider" });
  });

  it("normalizes native tool calls returned from Rust", async () => {
    const invoke = vi.fn(async () => ({
      type: "tool_calls",
      content: "",
      toolCalls: [{
        id: "call-1",
        toolName: "global:native.get_device_status",
        providerToolName: "global_native_get_device_status_12345678",
        arguments: {},
        route: "local",
      }],
    }));
    const client = createTauriAssistantProviderClient({ commandAdapter: invoke });

    await expect(client.provider.complete({
      messages: [{ role: "user", content: "status" }],
      tools: [],
      maxToolCalls: 4,
      signal: new AbortController().signal,
    })).resolves.toMatchObject({
      type: "tool_calls",
      toolCalls: [{
        id: "call-1",
        toolName: "global:native.get_device_status",
        route: "local",
      }],
    });
  });

  it("rejects provider status from any backend other than the platform keychain", async () => {
    const client = createTauriAssistantProviderClient({
      commandAdapter: async () => ({
        configured: true,
        enabled: true,
        provider: "openai-compatible",
        endpoint: "https://llm.example/v1/chat/completions",
        model: "model-a",
        backend: "memory",
        persisted: false,
        secretsRedacted: true,
        redactedFields: ["apiKey"],
      }),
    });

    await expect(client.status()).rejects.toMatchObject({
      reasonCode: "provider_status_untrusted_backend",
    });
  });

  it("grants assistant provider commands without granting generic secure storage to thin", () => {
    const mainCapability = readFileSync(resolve(repoRoot, "apps/aurora-tauri/src-tauri/capabilities/aurora-main.json"), "utf8");
    const thinCapability = readFileSync(resolve(repoRoot, "apps/aurora-tauri/src-tauri/capabilities/aurora-thin.json"), "utf8");
    const permission = readFileSync(resolve(repoRoot, "apps/aurora-tauri/src-tauri/permissions/aurora-assistant-provider.toml"), "utf8");
    const genericPermission = readFileSync(resolve(repoRoot, "apps/aurora-tauri/src-tauri/permissions/aurora-secure-storage.toml"), "utf8");

    for (const command of [
      "aurora_assistant_provider_status",
      "aurora_assistant_provider_configure",
      "aurora_assistant_provider_complete",
    ]) {
      expect(permission).toContain(command);
      expect(genericPermission).not.toContain(command);
    }
    expect(mainCapability).toContain("aurora-assistant-provider");
    expect(thinCapability).toContain("aurora-assistant-provider");
    expect(thinCapability).not.toContain("aurora-secure-storage");
  });
});
