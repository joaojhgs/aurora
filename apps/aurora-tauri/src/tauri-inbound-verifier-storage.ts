import type { InboundVerifierSecretStoragePort } from "@aurora/client/webrtc";

export type TauriInboundVerifierInvoke = (
  command: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;

export interface TauriInboundVerifierSecretStorageOptions {
  invoke: TauriInboundVerifierInvoke;
}

export class TauriInboundVerifierSecretStorage implements InboundVerifierSecretStoragePort {
  private readonly invokeCommand: TauriInboundVerifierInvoke;

  constructor(options: TauriInboundVerifierSecretStorageOptions) {
    this.invokeCommand = options.invoke;
  }

  async getOpaqueSecret(key: string): Promise<string | undefined> {
    const result = await this.invokeCommand("aurora_inbound_verifier_get", {
      request: { key },
    });
    return parseGetResult(result).value;
  }

  async setOpaqueSecret(key: string, value: string): Promise<void> {
    const result = await this.invokeCommand("aurora_inbound_verifier_set", {
      request: { key, value },
    });
    if (!isOkWriteResult(result)) {
      throw new Error("Inbound verifier storage write failed");
    }
  }

  async deleteOpaqueSecret(key: string): Promise<void> {
    const result = await this.invokeCommand("aurora_inbound_verifier_delete", {
      request: { key },
    });
    if (!isOkWriteResult(result)) {
      throw new Error("Inbound verifier storage delete failed");
    }
  }
}

export function createTauriInboundVerifierSecretStorage(
  options: TauriInboundVerifierSecretStorageOptions,
): InboundVerifierSecretStoragePort {
  return new TauriInboundVerifierSecretStorage(options);
}

function parseGetResult(value: unknown): { value?: string | undefined } {
  if (!value || typeof value !== "object") {
    throw new Error("Inbound verifier storage read returned an invalid response");
  }
  const record = value as { found?: unknown; value?: unknown };
  if (record.found === false || record.value === null || record.value === undefined) {
    return {};
  }
  if (typeof record.value !== "string") {
    throw new Error("Inbound verifier storage read returned an invalid value");
  }
  return { value: record.value };
}

function isOkWriteResult(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  return (value as { ok?: unknown }).ok === true;
}
