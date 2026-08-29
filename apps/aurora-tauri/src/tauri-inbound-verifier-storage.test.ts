import { describe, expect, it, vi } from "vitest";
import { inboundVerifierSecretKey } from "@aurora/client/webrtc";

import { createTauriInboundVerifierSecretStorage } from "./tauri-inbound-verifier-storage";

const verifierKey = inboundVerifierSecretKey({
  tokenId: "token-1",
  claimantPeerId: "claimant-peer",
  verifierPeerId: "desktop-peer",
  roomName: "mesh-room",
});

const verifierRecord = JSON.stringify({
  version: 1,
  tokenId: "token-1",
  claimantPeerId: "claimant-peer",
  verifierPeerId: "desktop-peer",
  roomName: "mesh-room",
  tokenHashHex: "a".repeat(64),
  createdAtMs: 1,
  credentialRevision: 1,
});

describe("Tauri inbound verifier secret storage", () => {
  it("uses the dedicated command family and exact SDK key shape", async () => {
    const invoke = vi.fn(async (command: string) => {
      if (command === "aurora_inbound_verifier_get") {
        return { found: true, value: verifierRecord, secretsRedacted: true };
      }
      return { ok: true, secretsRedacted: true };
    });
    const storage = createTauriInboundVerifierSecretStorage({ invoke });

    await expect(storage.setOpaqueSecret(verifierKey, verifierRecord)).resolves.toBeUndefined();
    await expect(storage.getOpaqueSecret(verifierKey)).resolves.toBe(verifierRecord);
    await expect(storage.deleteOpaqueSecret(verifierKey)).resolves.toBeUndefined();

    expect(invoke).toHaveBeenNthCalledWith(1, "aurora_inbound_verifier_set", {
      request: { key: verifierKey, value: verifierRecord },
    });
    expect(invoke).toHaveBeenNthCalledWith(2, "aurora_inbound_verifier_get", {
      request: { key: verifierKey },
    });
    expect(invoke).toHaveBeenNthCalledWith(3, "aurora_inbound_verifier_delete", {
      request: { key: verifierKey },
    });
    expect(verifierKey).toMatch(/^aurora\.peer-host\.inbound-verifier\.v1:/);
  });

  it("maps missing records to undefined without treating delete as failure", async () => {
    const invoke = vi.fn(async (command: string) => {
      if (command === "aurora_inbound_verifier_get") {
        return { found: false, value: null, secretsRedacted: true };
      }
      return { ok: true, secretsRedacted: true };
    });
    const storage = createTauriInboundVerifierSecretStorage({ invoke });

    await expect(storage.getOpaqueSecret(verifierKey)).resolves.toBeUndefined();
    await expect(storage.deleteOpaqueSecret(verifierKey)).resolves.toBeUndefined();
  });

  it("propagates unavailable backend and malformed command responses", async () => {
    const unavailable = createTauriInboundVerifierSecretStorage({
      invoke: vi.fn(async () => {
        throw new Error("unsupported_feature");
      }),
    });
    await expect(unavailable.getOpaqueSecret(verifierKey)).rejects.toThrow("unsupported_feature");

    const malformed = createTauriInboundVerifierSecretStorage({
      invoke: vi.fn(async () => ({ ok: false, secretsRedacted: true })),
    });
    await expect(malformed.setOpaqueSecret(verifierKey, verifierRecord)).rejects.toThrow(
      "Inbound verifier storage write failed",
    );
  });
});
