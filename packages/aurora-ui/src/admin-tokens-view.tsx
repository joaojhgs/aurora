"use client";

import { useEffect, useState } from "react";
import {
  AUTH_METHODS,
  AuroraError,
  summarizeCapabilities,
  type AuroraClient,
  type AvailabilityState,
  type CapabilitySummary,
  type JsonObject,
  type TokenResponse,
} from "@aurora/client";
import { ToneBadge, type BadgeTone } from "./status-badges";
import { ConfirmDialog } from "./shared-components";
import { Card, DataTable, type DataColumn } from "./primitives";

export type AdminTokensLoadState =
  | "loading"
  | "ready"
  | "empty"
  | "degraded"
  | "denied"
  | "service-unavailable"
  | "error";

export type AdminTokenStatus = "active" | "expiring" | "expired";

export interface AdminTokenAction {
  title: string;
  description: string;
  methodId: typeof AUTH_METHODS.revokeToken;
  payload: JsonObject;
  affectedResources: string[];
  severity: "critical";
  reason: string;
  requiresAdminAction: true;
}

export interface AdminTokenRow {
  id: string;
  prefix: string;
  userId: string | null;
  owner: string;
  deviceId: string | null;
  scopes: string[];
  createdAt: string | null;
  expiresAt: string | null;
  lastUsedAt: string | null;
  status: AdminTokenStatus;
  listState: AvailabilityState;
  listReason: string;
  revokeState: AvailabilityState;
  revokeReason: string;
  revokeAction: AdminTokenAction | null;
  rotateAction: AdminTokenAction | null;
}

export interface AdminTokenOneTimeReveal {
  tokenId: string;
  prefix: string;
  secret: string;
  expiresAt: string | null;
}

export interface AdminTokensSnapshot {
  loadState: AdminTokensLoadState;
  tokens: AdminTokenRow[];
  listState: AvailabilityState;
  listReason: string;
  revokeState: AvailabilityState;
  revokeReason: string;
  createState: AvailabilityState;
  createReason: string;
  secretsRedacted: boolean;
  warnings: string[];
  error: string | null;
  evidenceSource: string;
  oneTimeReveal: AdminTokenOneTimeReveal | null;
}

export interface AdminTokensResourceProps {
  client: AuroraClient;
  onPreviewAdminAction?: ((action: AdminTokenAction) => void) | undefined;
}

export interface AdminTokensViewProps {
  snapshot: AdminTokensSnapshot;
  onPreviewAdminAction?: ((action: AdminTokenAction) => void) | undefined;
}

const loadingSnapshot: AdminTokensSnapshot = {
  loadState: "loading",
  tokens: [],
  listState: "pending",
  listReason:
    "Loading Auth.ListTokens and token capability status through Aurora.",
  revokeState: "pending",
  revokeReason:
    "Loading Auth.RevokeToken capability status through Aurora.",
  createState: "unsupported",
  createReason:
    "Token creation is not ready in this Aurora version.",
  secretsRedacted: true,
  warnings: [],
  error: null,
  evidenceSource: "pending Aurora service calls",
  oneTimeReveal: null,
};

export function AdminTokensResource({
  client,
  onPreviewAdminAction,
}: AdminTokensResourceProps) {
  const [snapshot, setSnapshot] =
    useState<AdminTokensSnapshot>(loadingSnapshot);

  useEffect(() => {
    let cancelled = false;
    setSnapshot(loadingSnapshot);
    void buildAdminTokensSnapshot(client).then((next) => {
      if (!cancelled) setSnapshot(next);
    });
    return () => {
      cancelled = true;
    };
  }, [client]);

  return (
    <AdminTokensView
      snapshot={snapshot}
      onPreviewAdminAction={onPreviewAdminAction}
    />
  );
}

export async function buildAdminTokensSnapshot(
  client: AuroraClient,
): Promise<AdminTokensSnapshot> {
  const [tokensResult, catalogResult] = await Promise.allSettled([
    client.authApi.listTokens(),
    client.capabilities.listCatalog({
      include_unavailable: true,
      include_internal: true,
      include_schemas: true,
    }),
  ]);

  const tokensResponse = responseDataOrNull(tokensResult);
  const catalog = valueOrNull(catalogResult);
  const summaries = catalog ? summarizeCapabilities(catalog) : [];
  const failures = [
    failureMessage("tokens", tokensResult),
    failureMessage("capability catalog", catalogResult),
  ].filter((message): message is string => Boolean(message));
  const denied = [tokensResult, catalogResult].some(isDeniedFailure);

  if (!tokensResponse && !catalog) {
    const unavailableMessage = "Aurora token resources are unavailable.";
    return {
      ...loadingSnapshot,
      loadState: denied ? "denied" : "service-unavailable",
      listState: denied ? "denied" : "unsupported",
      revokeState: "unsupported",
      error:
        failures.length > 0
          ? `${unavailableMessage} ${failures.join(" ")}`
          : unavailableMessage,
      warnings: failures,
      evidenceSource: "Aurora request error",
    };
  }

  const listCapability = capabilityFor(AUTH_METHODS.listTokens, summaries);
  const revokeCapability = capabilityFor(AUTH_METHODS.revokeToken, summaries);
  const listState =
    listCapability?.availability ??
    (tokensResponse ? "available-local" : denied ? "denied" : "unsupported");
  const revokeState = revokeCapability?.availability ?? "unsupported";
  const tokens = (tokensResponse?.tokens ?? []).map((token) =>
    tokenRow(token, listCapability, revokeCapability),
  );
  const loadState: AdminTokensLoadState = denied
    ? "denied"
    : failures.length > 0
      ? "degraded"
      : tokens.length === 0
        ? "empty"
        : "ready";

  return {
    loadState,
    tokens,
    listState,
    listReason: listCapability
      ? capabilityReason(listCapability)
      : tokensResponse
        ? "Aurora returned protected token details."
        : "Token listing is not ready yet.",
    revokeState,
    revokeReason: revokeCapability
      ? capabilityReason(revokeCapability)
      : "Token revocation is not ready yet.",
    createState: "unsupported",
    createReason:
      "Token creation is not ready in this Aurora version.",
    secretsRedacted: catalog?.secrets_redacted ?? true,
    warnings: failures,
    error: failures[0] ?? null,
    evidenceSource:
      client.transport.kind === "mock"
        ? "Local preview"
        : "Aurora service response",
    oneTimeReveal: null,
  };
}

export function dismissOneTimeTokenReveal(snapshot: AdminTokensSnapshot): AdminTokensSnapshot {
  return { ...snapshot, oneTimeReveal: null };
}

export function AdminTokensView({
  snapshot,
  onPreviewAdminAction,
}: AdminTokensViewProps) {
  const [pendingAction, setPendingAction] = useState<AdminTokenAction | null>(null);

  return (
    <div className="flex h-full flex-col" aria-labelledby="admin-tokens-title">
      <div className="border-b border-border px-6 py-5">
        <h1 id="admin-tokens-title" className="text-xl font-semibold tracking-tight">Tokens</h1>
        <p className="mt-1 text-sm text-muted-foreground">API tokens issued to principals, with their granted scopes.</p>
      </div>
      <div className="px-6 py-5">
        <TokensTable
          tokens={snapshot.tokens}
          onPreviewAdminAction={(action) => setPendingAction(action)}
        />
      </div>

      <ConfirmDialog
        open={pendingAction !== null}
        title={pendingAction?.title ?? ''}
        description={pendingAction?.description ?? ''}
        confirmLabel="Revoke"
        destructive
        onCancel={() => setPendingAction(null)}
        onConfirm={() => {
          if (pendingAction) onPreviewAdminAction?.(pendingAction);
          setPendingAction(null);
        }}
      />
    </div>
  );
}

function TokensTable({
  tokens,
  onPreviewAdminAction,
}: {
  tokens: AdminTokenRow[];
  onPreviewAdminAction?: ((action: AdminTokenAction) => void) | undefined;
}) {
  const columns: DataColumn<AdminTokenRow>[] = [
    {
      key: "token",
      header: "Token",
      mono: true,
      render: (token) => <code>{token.prefix}••••</code>,
    },
    {
      key: "principal",
      header: "Principal",
      render: (token) => <code>{token.owner}</code>,
    },
    {
      key: "scopes",
      header: "Scopes",
      render: (token) => (
        <span className="text-[11.5px] text-muted-foreground">
          {token.scopes.length > 0 ? token.scopes.join(", ") : "no scopes"}
        </span>
      ),
    },
    {
      key: "expires",
      header: "Expires",
      hideAt: "md",
      render: (token) => token.expiresAt ?? "No expiry",
    },
    {
      key: "status",
      header: "Status",
      render: (token) => <ToneBadge tone={tokenStatusTone(token.status)}>{token.status}</ToneBadge>,
    },
    {
      key: "action",
      header: "Action",
      align: "end",
      render: (token) => (
        token.status !== "expired" ? (
          <button
            className="cursor-pointer rounded-md bg-destructive/10 px-2.5 py-1 text-xs text-destructive hover:bg-destructive/20 disabled:cursor-not-allowed disabled:opacity-50"
            type="button"
            aria-label={`Revoke token ${token.prefix}`}
            title={token.revokeReason}
            disabled={!token.revokeAction}
            onClick={() => {
              if (token.revokeAction)
                onPreviewAdminAction?.(token.revokeAction);
            }}
          >
            Revoke
          </button>
        ) : null
      ),
    },
  ];

  return (
    <Card title="Tokens" flush>
      <DataTable
        columns={columns}
        rows={tokens}
        getRowKey={(token) => token.id}
        empty={<p className="text-sm text-muted-foreground">No tokens to show.</p>}
      />
    </Card>
  );
}

function tokenStatusTone(status: AdminTokenStatus): BadgeTone {
  if (status === "active") return "success";
  if (status === "expiring") return "warning";
  return "danger";
}


export function buildTokenRevokeAdminAction(
  token: Pick<AdminTokenRow, "id" | "prefix" | "userId" | "deviceId">,
  reason = "Revoke scoped API token",
): AdminTokenAction {
  return {
    title: `Revoke token ${token.prefix}`,
    description:
      "Aurora will revoke this token only after admin confirmation and audit logging.",
    methodId: AUTH_METHODS.revokeToken,
    payload: { token_id: token.id } as JsonObject,
    affectedResources: [
      `token:${token.id}`,
      token.userId ? `principal:${token.userId}` : "principal:not-bound",
      token.deviceId ? `device:${token.deviceId}` : "device:not-bound",
    ],
    severity: "critical",
    reason,
    requiresAdminAction: true,
  };
}

export function buildTokenRotateAdminAction(
  token: Pick<AdminTokenRow, "id" | "prefix" | "userId" | "deviceId">,
): AdminTokenAction {
  return {
    ...buildTokenRevokeAdminAction(
      token,
      "Rotate scoped API token by revoking the old credential before a one-time replacement reveal.",
    ),
    title: `Rotate token ${token.prefix}`,
    description:
      "Aurora will rotate this token only after admin confirmation. The replacement secret may be shown once and is then cleared from the view.",
    payload: { token_id: token.id, rotate: true } as JsonObject,
    affectedResources: [
      `token:${token.id}`,
      "token:replacement-one-time-reveal",
      token.userId ? `principal:${token.userId}` : "principal:not-bound",
      token.deviceId ? `device:${token.deviceId}` : "device:not-bound",
    ],
  };
}

function tokenRow(
  token: TokenResponse,
  listCapability: CapabilitySummary | undefined,
  revokeCapability: CapabilitySummary | undefined,
): AdminTokenRow {
  const revokeAvailable = Boolean(
    revokeCapability &&
    ["available-local", "available-remote", "degraded"].includes(
      revokeCapability.availability,
    ),
  );
  const extended = token as TokenResponse & {
    last_used_at?: string | null;
    last_used?: string | null;
    owner?: string | null;
  };
  const baseActionInput = {
    id: token.id,
    prefix: token.prefix,
    userId: token.user_id ?? null,
    deviceId: token.device_id ?? null,
  };
  return {
    id: token.id,
    prefix: token.prefix,
    userId: token.user_id ?? null,
    owner: extended.owner ?? token.user_id ?? token.device_id ?? "not bound",
    deviceId: token.device_id ?? null,
    scopes: token.scopes,
    createdAt: token.created_at ?? null,
    expiresAt: token.expires_at ?? null,
    lastUsedAt: extended.last_used_at ?? extended.last_used ?? null,
    status: tokenStatus(token.expires_at ?? null),
    listState: listCapability?.availability ?? "available-local",
    listReason: listCapability
      ? capabilityReason(listCapability)
      : "Aurora returned this protected token.",
    revokeState: revokeCapability?.availability ?? "unsupported",
    revokeReason: revokeCapability
      ? capabilityReason(revokeCapability)
      : "Auth.RevokeToken is not advertised by the capability catalog.",
    revokeAction: revokeAvailable
      ? buildTokenRevokeAdminAction(baseActionInput)
      : null,
    rotateAction: revokeAvailable
      ? buildTokenRotateAdminAction(baseActionInput)
      : null,
  };
}

function tokenStatus(expiresAt: string | null): AdminTokenStatus {
  if (!expiresAt) return "active";
  const expires = Date.parse(expiresAt);
  if (Number.isNaN(expires)) return "active";
  const now = Date.now();
  if (expires <= now) return "expired";
  const days = (expires - now) / (1000 * 60 * 60 * 24);
  return days <= 30 ? "expiring" : "active";
}

function capabilityFor(
  methodId: string,
  summaries: CapabilitySummary[],
): CapabilitySummary | undefined {
  return summaries.find((summary) => summary.busTopic === methodId);
}

function capabilityReason(capability: CapabilitySummary): string {
  if (capability.routeBlockers.length > 0)
    return capability.routeBlockers.join(", ");
  if (capability.raw.policy.approval_required)
    return "Admin approval is required before this action can run.";
  if (capability.availability === "offline" || capability.availability === "stale")
    return "This device is offline";
  if (capability.availability === "denied" || capability.availability === "privacy-blocked")
    return "Permission is needed to use this feature";
  if (capability.availability === "unsupported")
    return "This Aurora version cannot use that feature yet";
  return "Ready";
}

function responseDataOrNull<T>(
  settled: PromiseSettledResult<{ ok: true; data: T } | { ok: false }>,
): T | null {
  return settled.status === "fulfilled" && settled.value.ok
    ? settled.value.data
    : null;
}

function valueOrNull<T>(settled: PromiseSettledResult<T>): T | null {
  return settled.status === "fulfilled" ? settled.value : null;
}

function failureMessage(
  label: string,
  settled: PromiseSettledResult<unknown>,
): string | null {
  if (settled.status === "rejected")
    return `${label}: ${errorMessage(settled.reason)}`;
  const value = settled.value as { ok?: boolean; error?: unknown };
  if (value && value.ok === false)
    return `${label}: ${errorMessage(value.error)}`;
  return null;
}

function isDeniedFailure(settled: PromiseSettledResult<unknown>): boolean {
  if (settled.status === "rejected") {
    const reason = settled.reason as Partial<AuroraError>;
    return reason.code === "auth" || reason.code === "permission";
  }
  const value = settled.value as { ok?: boolean; error?: Partial<AuroraError> };
  return (
    value?.ok === false &&
    (value.error?.code === "auth" || value.error?.code === "permission")
  );
}

function errorMessage(error: unknown): string {
  const maybe = error as Partial<AuroraError>;
  if (maybe.code === "auth" || maybe.code === "permission")
    return "Permission is needed to use this feature";
  if (maybe.code === "unsupported_feature" || maybe.code === "unavailable_service")
    return "This Aurora version cannot use that feature yet";
  if (maybe.code === "timeout" || maybe.code === "transport_loss")
    return "Connection lost. Reconnecting...";
  return "Aurora could not read this item";
}
