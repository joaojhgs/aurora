import { describe, expect, it, vi } from "vitest";
import type { LightweightProviderRequest } from "@aurora/client/lightweight-orchestrator";
import type { LocalInferenceInvoke } from "@aurora/client/local-inference";

import { createTauriLocalAssistantRouter } from "./tauri-local-inference";

describe("Tauri local assistant routing", () => {
  it("answers offline through the selected native model and session", async () => {
    const calls: Array<{ command: string; args: Record<string, unknown> | undefined }> = [];
    const invoke: LocalInferenceInvoke = async (command, args) => {
      calls.push({ command, args });
      if (command === "aurora_local_inference_model_status") {
        return envelope({ modelId: "chat-qwen3-0b8", state: "ready" });
      }
      if (command === "aurora_local_inference_session_create") {
        return envelope({ modelId: "chat-qwen3-0b8", sessionId: "offline-session", contextBytes: null });
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
        { command: "aurora_local_inference_session_create", args: { modelId: "chat-qwen3-0b8", sessionId: "offline-session" } },
      ]);
      expect(calls.find(({ command }) => command === "aurora_local_inference_complete")?.args).toMatchObject({
        sessionId: "offline-session",
        request: {
          modelId: "chat-qwen3-0b8",
          sessionId: "offline-session",
          messages: [{ role: "user", content: "Answer without a network connection." }],
        },
      });
    } finally {
      await router.close();
    }
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
