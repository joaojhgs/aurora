import { describe, expect, it, vi } from "vitest";
import type { LightweightProviderRequest } from "@aurora/client/lightweight-orchestrator";
import type { LocalInferenceInvoke } from "@aurora/client/local-inference";
import type { ToolingProjectionToolInfo } from "@aurora/client";

import { createTauriLocalAssistantRouter } from "./tauri-local-inference";

describe("Tauri local assistant routing", () => {
  it.each([
    { modelId: "chat-qwen3-0b8", engine: "llamacpp", surface: "desktop" },
    { modelId: "chat-qwen3-06b-cactus", engine: "cactus", surface: "ios" },
  ])("answers offline through the discovered $engine model and session", async ({ modelId, engine, surface }) => {
    const calls: Array<{ command: string; args: Record<string, unknown> | undefined }> = [];
    const invoke: LocalInferenceInvoke = async (command, args) => {
      calls.push({ command, args });
      if (command === "aurora_local_inference_engines") {
        return envelope([{ engine, surface, version: "native-build", accelerators: ["cpu"], maxConcurrentModels: 1 }]);
      }
      if (command === "aurora_local_inference_catalog") return envelope([]);
      if (command === "aurora_local_inference_model_status") {
        return envelope({ modelId, state: "ready" });
      }
      if (command === "aurora_local_inference_session_create") {
        return envelope({ modelId, sessionId: "offline-session", contextBytes: null });
      }
      if (command === "aurora_local_inference_complete") {
        return envelope({ type: "message", content: "The on-device answer is ready." });
      }
      if (command === "aurora_local_inference_session_destroy") return envelope(null);
      throw new Error(`Unexpected local inference command: ${command}`);
    };
    const peerProvider = { complete: vi.fn() };
    const router = createTauriLocalAssistantRouter({
      invoke,
      peerProvider,
      peerReady: () => false,
      enabled: true,
      sessionId: "offline-session",
    });

    try {
      await expect(router.provider.complete(request())).resolves.toEqual({
        type: "message",
        content: "The on-device answer is ready.",
      });
      expect(peerProvider.complete).not.toHaveBeenCalled();
      expect(calls.filter(({ command }) => command === "aurora_local_inference_session_create")).toEqual([
        { command: "aurora_local_inference_session_create", args: { modelId, sessionId: "offline-session" } },
      ]);
      expect(calls.find(({ command }) => command === "aurora_local_inference_complete")?.args).toMatchObject({
        sessionId: "offline-session",
        request: {
          modelId,
          sessionId: "offline-session",
          messages: [{ role: "user", content: "Answer without a network connection." }],
        },
      });
    } finally {
      await router.close();
    }
  });

  it("finishes a discovered Android action before switching the owned session to chat", async () => {
    const sessions: string[] = [];
    const completedModels: string[] = [];
    let actionProposed = false;
    const invoke: LocalInferenceInvoke = async (command, args) => {
      if (command === "aurora_local_inference_engines") {
        return envelope([{ engine: "needle2", surface: "android", version: "2.0.1", accelerators: ["cpu"], maxConcurrentModels: 1 }]);
      }
      if (command === "aurora_local_inference_catalog") {
        return envelope([{ modelId: "actions-needle2", displayLabel: "Device actions", bytes: 13737807, capabilities: { chat: false, tools: true } }]);
      }
      if (command === "aurora_local_inference_model_status") return envelope({ modelId: args?.modelId, state: "ready" });
      if (command === "aurora_local_inference_session_create") {
        sessions.push(`create:${args?.modelId}`);
        return envelope({ modelId: args?.modelId, sessionId: "offline-session", contextBytes: null });
      }
      if (command === "aurora_local_inference_session_destroy") {
        sessions.push("destroy");
        return envelope(null);
      }
      if (command === "aurora_local_inference_complete") {
        const native = args?.request as { modelId: string; tools?: Array<{ function: { name: string } }> };
        completedModels.push(native.modelId);
        if (native.modelId === "actions-needle2" && !actionProposed) {
          actionProposed = true;
          return envelope({ type: "tool_calls", content: "", toolCalls: [{ name: native.tools?.[0]?.function.name, arguments: { value: "note" } }] });
        }
        return envelope({ type: "message", content: native.modelId === "actions-needle2" ? "" : "An offline answer." });
      }
      throw new Error(`Unexpected local inference command: ${command}`);
    };
    const router = createTauriLocalAssistantRouter({ invoke, peerProvider: { complete: vi.fn() }, peerReady: () => false, enabled: true, sessionId: "offline-session" });
    try {
      const first = { ...request(), tools: [localTool()], turnSignal: new AbortController().signal };
      const proposed = await router.provider.complete(first);
      expect(proposed.type).toBe("tool_calls");
      if (proposed.type !== "tool_calls") throw new Error("Expected the local action proposal");
      const action = proposed.toolCalls[0]!;
      expect(action.route).toBe("local");
      const final = await router.provider.complete({
        ...first,
        messages: [...first.messages, { role: "assistant", content: "", toolCalls: proposed.toolCalls }, { role: "tool", toolCallId: action.id, name: action.providerToolName, content: JSON.stringify({ ok: true, data: { saved: true } }) }],
      });
      expect(final).toEqual({ type: "message", content: "Done — 1 action completed." });
      await expect(router.provider.complete({ ...request(), turnSignal: new AbortController().signal })).resolves.toEqual({ type: "message", content: "An offline answer." });
      expect(completedModels).toEqual(["actions-needle2", "actions-needle2", "chat-qwen3-0b8"]);
      expect(sessions).toEqual(["create:actions-needle2", "destroy", "create:chat-qwen3-0b8"]);
    } finally { await router.close(); }
  });

  it("uses the ready peer for the turn without invoking local inference", async () => {
    const invoke = vi.fn<LocalInferenceInvoke>(async () => {
      throw new Error("Local inference must not be invoked when the peer was selected.");
    });
    const peerProvider = {
      complete: vi.fn(async () => ({ type: "message" as const, content: "The approved peer answered." })),
    };
    const router = createTauriLocalAssistantRouter({
      invoke,
      peerProvider,
      peerReady: () => true,
      enabled: true,
      sessionId: "offline-session",
    });

    await expect(router.provider.complete(request())).resolves.toEqual({
      type: "message",
      content: "The approved peer answered.",
    });
    expect(peerProvider.complete).toHaveBeenCalledOnce();
    expect(invoke).not.toHaveBeenCalled();
    await router.close();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("keeps the chosen device through the tool result and final reply", async () => {
    let peerReady = true;
    const invoke = vi.fn<LocalInferenceInvoke>(async () => {
      throw new Error("A started peer turn must not replay on this device.");
    });
    const peerProvider = {
      complete: vi.fn()
        .mockResolvedValueOnce({ type: "tool_calls", toolCalls: [{ id: "call-1", toolName: "notes.create", arguments: {}, route: "remote" }] })
        .mockResolvedValueOnce({ type: "message", content: "Your note is saved." }),
    };
    const router = createTauriLocalAssistantRouter({ invoke, peerProvider, peerReady: () => peerReady, enabled: true });
    const turnSignal = new AbortController().signal;
    await router.provider.complete({ ...request(), turnSignal });
    peerReady = false;
    await expect(router.provider.complete({
      ...request(),
      turnSignal,
      messages: [{ role: "tool", toolCallId: "call-1", content: "Saved" }],
    })).resolves.toEqual({ type: "message", content: "Your note is saved." });
    expect(peerProvider.complete).toHaveBeenCalledTimes(2);
    expect(invoke).not.toHaveBeenCalled();
    await router.close();
  });
});

function request(): LightweightProviderRequest {
  return {
    messages: [{ role: "user", content: "Answer without a network connection." }],
    tools: [],
    maxToolCalls: 4,
    modelId: null,
    providerId: null,
    signal: new AbortController().signal,
  };
}

function envelope(data: unknown): { ok: true; data: unknown } {
  return { ok: true, data };
}

function localTool(): ToolingProjectionToolInfo {
  const schema = { type: "object", properties: { value: { type: "string" } } };
  return {
    name: "notes.create", local_name: "notes.create", global_tool_id: "aurora-tool:v1:local:notes.create",
    tool_id_scheme: "aurora-tool", tool_id_version: 1, tool_contract_id: "contract.notes.create",
    share_group_id: "group.notes", share_group_label: "Notes", legacy_global_tool_ids: [], exportable: true,
    provider_peer_id: "node-local", provider_service_instance_id: "local:Tooling", provider_label: null,
    provider_granted_permissions: null, provider_available: true, namespace: "node-local", display_name: "Create note",
    aliases: [], description: "Create a note on this device", args_schema: schema, schema, argument_visibility: {},
    source_type: "local", source: "core", source_id: "notes", trust_tier: "trusted", capability_class: "utility",
    resource_scope: [], execution_location: "local", safety_class: "safe", risk_class: "safe", data_egress: false,
    mutating: true, external: false, admin: false, privacy_hints: [], required_permissions: ["Tooling.ExecuteTool"],
    confirmation_required: true, rate_limit_hints: null,
    provenance: { provider_peer_id: "node-local", provider_service_instance_id: "local:Tooling", provider_kind: "local", source: "core", advertised_name: "notes.create" },
  };
}
