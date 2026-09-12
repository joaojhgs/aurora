"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  AUTH_METHODS,
  AuroraError,
  summarizeCapabilities,
  type AuroraClient,
  type AuthTokenCreateRequest,
  type AuthTokenCreateResponse,
  type AvailabilityState,
  type CapabilitySummary,
  type JsonObject,
  type TokenResponse,
} from "@aurora/client";
import { ToneBadge, type BadgeTone } from "./status-badges";
import { ConfirmDialog } from "./shared-components";
import { Card, DataTable, type DataColumn } from "./primitives";
import { adminCapabilityReason, adminModuleLabel, productAdminErrorCopy, sanitizeAdminText } from "./admin-product-copy";

export type AdminTokensLoadState =
  | "loading"
  | "ready"
  | "empty"
  | "degraded"
  | "denied"
  | "service-unavailable"
  | "error";

export type AdminTokenStatus = "active" | "expiring" | "expired";
export type AdminTokenMutationState = "idle" | "optimistic" | "rollback-error";

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
  updateState?: AvailabilityState;
  updateReason?: string;
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
  onCreateToken?: ((payload: AuthTokenCreateRequest) => void) | undefined;
  onUpdateScopes?: ((token: AdminTokenRow, scopes: string[]) => void) | undefined;
  onDismissOneTimeReveal?: (() => void) | undefined;
  adminReason?: string;
  reauthConfirmed?: boolean;
  mutationState?: AdminTokenMutationState;
  mutationError?: string | null;
  busyAction?: string | null;
  onAdminReasonChange?: ((value: string) => void) | undefined;
  onReauthConfirmedChange?: ((value: boolean) => void) | undefined;
}

const loadingSnapshot: AdminTokensSnapshot = {
  loadState: "loading",
  tokens: [],
  listState: "pending",
  listReason:
    "Loading tokens through Aurora.",
  revokeState: "pending",
  revokeReason:
    "Loading token revocation status through Aurora.",
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
  const [adminReason, setAdminReason] = useState("Manage scoped API credentials");
  const [reauthConfirmed, setReauthConfirmed] = useState(false);
  const [mutationState, setMutationState] =
    useState<AdminTokenMutationState>("idle");
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const loadTokens = useCallback(
    async (oneTimeReveal?: AdminTokenOneTimeReveal | null) => {
      const next = await buildAdminTokensSnapshot(client);
      setSnapshot((current) => ({
        ...next,
        oneTimeReveal:
          oneTimeReveal === undefined ? current.oneTimeReveal : oneTimeReveal,
      }));
    },
    [client],
  );

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

  const createToken = useCallback(
    async (payload: AuthTokenCreateRequest) => {
      setBusyAction("create");
      setMutationState("optimistic");
      setMutationError(null);
      try {
        const result = await client.tokens.create(payload, {
          reason: adminReason.trim() || "Create scoped API token",
          reauthConfirmed,
        });
        await loadTokens(tokenReveal(result.data));
        setMutationState("idle");
      } catch (error) {
        setMutationState("rollback-error");
        setMutationError(productAdminErrorCopy(error, "Token creation failed. Try again."));
      } finally {
        setBusyAction(null);
      }
    },
    [adminReason, client.tokens, loadTokens, reauthConfirmed],
  );

  const updateScopes = useCallback(
    async (token: AdminTokenRow, scopes: string[]) => {
      setBusyAction(`scopes:${token.id}`);
      setMutationState("optimistic");
      setMutationError(null);
      setSnapshot((current) => ({
        ...current,
        tokens: current.tokens.map((candidate) =>
          candidate.id === token.id ? { ...candidate, scopes } : candidate,
        ),
      }));
      try {
        const result = await client.tokens.updateScopes(
          { token_id: token.id, scopes },
          {
            reason:
              adminReason.trim() || `Update token scopes for ${token.prefix}`,
            reauthConfirmed,
          },
        );
        if (!result.data.success) throw new Error("Aurora rejected the token scope update.");
        await loadTokens();
        setMutationState("idle");
      } catch (error) {
        await loadTokens();
        setMutationState("rollback-error");
        setMutationError(productAdminErrorCopy(error, "Token scopes could not be updated. Try again."));
      } finally {
        setBusyAction(null);
      }
    },
    [adminReason, client.tokens, loadTokens, reauthConfirmed],
  );

  const runAdminAction = useCallback(
    async (action: AdminTokenAction) => {
      onPreviewAdminAction?.(action);
      if (onPreviewAdminAction) return;
      if (action.methodId !== AUTH_METHODS.revokeToken) return;
      const tokenId = String(action.payload.token_id ?? "");
      if (!tokenId) return;

      setBusyAction(`revoke:${tokenId}`);
      setMutationState("optimistic");
      setMutationError(null);
      setSnapshot((current) => ({
        ...current,
        tokens: current.tokens.filter((token) => token.id !== tokenId),
      }));
      try {
        const result = await client.tokens.revoke(
          { token_id: tokenId },
          {
            reason: adminReason.trim() || action.reason,
            reauthConfirmed,
          },
        );
        if (!result.data.success) throw new Error("Aurora rejected the token revocation.");
        await loadTokens();
        setMutationState("idle");
      } catch (error) {
        await loadTokens();
        setMutationState("rollback-error");
        setMutationError(productAdminErrorCopy(error, "Token could not be revoked. Try again."));
      } finally {
        setBusyAction(null);
      }
    },
    [adminReason, client.tokens, loadTokens, onPreviewAdminAction, reauthConfirmed],
  );

  return (
    <AdminTokensView
      snapshot={snapshot}
      onPreviewAdminAction={runAdminAction}
      onCreateToken={createToken}
      onUpdateScopes={updateScopes}
      onDismissOneTimeReveal={() =>
        setSnapshot((current) => dismissOneTimeTokenReveal(current))
      }
      adminReason={adminReason}
      reauthConfirmed={reauthConfirmed}
      mutationState={mutationState}
      mutationError={mutationError}
      busyAction={busyAction}
      onAdminReasonChange={setAdminReason}
      onReauthConfirmedChange={setReauthConfirmed}
    />
  );
}

export async function buildAdminTokensSnapshot(
  client: AuroraClient,
): Promise<AdminTokensSnapshot> {
  const [tokensResult, catalogResult] = await Promise.allSettled([
    client.tokens.list(),
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
      createState: "unsupported",
      error:
        failures.length > 0
          ? `${unavailableMessage} ${failures.join(" ")}`
          : unavailableMessage,
      warnings: failures,
      evidenceSource: "Aurora request error",
    };
  }

  const listCapability = capabilityFor(AUTH_METHODS.listTokens, summaries);
  const createCapability = capabilityFor(AUTH_METHODS.createToken, summaries);
  const updateCapability = capabilityFor(
    AUTH_METHODS.updateTokenScopes,
    summaries,
  );
  const revokeCapability = capabilityFor(AUTH_METHODS.revokeToken, summaries);
  const listState =
    listCapability?.availability ??
    (tokensResponse ? "available-local" : denied ? "denied" : "unsupported");
  const revokeState = revokeCapability?.availability ?? "unsupported";
  const tokens = (tokensResponse?.tokens ?? []).map((token) =>
    tokenRow(token, listCapability, updateCapability, revokeCapability),
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
    createState: createCapability?.availability ?? "unsupported",
    createReason: createCapability
      ? capabilityReason(createCapability)
      : "Token creation is not ready in this Aurora version.",
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
  onCreateToken,
  onUpdateScopes,
  onDismissOneTimeReveal,
  adminReason = "",
  reauthConfirmed = false,
  mutationState = "idle",
  mutationError = null,
  busyAction = null,
  onAdminReasonChange,
  onReauthConfirmedChange,
}: AdminTokensViewProps) {
  const [pendingAction, setPendingAction] = useState<AdminTokenAction | null>(null);

  return (
    <div className="flex h-full flex-col" aria-labelledby="admin-tokens-title">
      <div className="border-b border-border px-6 py-5">
        <h1 id="admin-tokens-title" className="text-xl font-semibold tracking-tight">Tokens</h1>
        <p className="mt-1 text-sm text-muted-foreground">API tokens issued to principals, with their granted scopes.</p>
      </div>
      <div className="flex flex-col gap-5 px-6 py-5">
        <TokenStatusMessage
          snapshot={snapshot}
          mutationState={mutationState}
          mutationError={mutationError}
        />

        {snapshot.oneTimeReveal ? (
          <Card
            title="Copy this token now"
            description="Aurora shows this secret once. It is removed from this page when you dismiss it."
          >
            <div className="flex flex-col gap-3">
              <code className="overflow-x-auto rounded-md border border-border bg-muted px-3 py-2 text-sm">
                {snapshot.oneTimeReveal.secret}
              </code>
              <p className="text-xs text-muted-foreground">
                Token {snapshot.oneTimeReveal.prefix}; expires {snapshot.oneTimeReveal.expiresAt ?? "never"}.
              </p>
              <div className="flex gap-2">
                <button
                  className="cursor-pointer rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
                  type="button"
                  onClick={() => void copyTokenSecret(snapshot.oneTimeReveal?.secret ?? "")}
                >
                  Copy token
                </button>
                <button
                  className="cursor-pointer rounded-md border border-border px-3 py-1.5 text-xs hover:bg-muted"
                  type="button"
                  onClick={onDismissOneTimeReveal}
                >
                  Dismiss secret
                </button>
              </div>
            </div>
          </Card>
        ) : null}

        <Card
          title="Protected token changes"
          description="Creating, changing, and revoking credentials requires a reason and recent administrator confirmation."
        >
          <div className="flex flex-col gap-4">
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
              <label className="flex flex-col gap-1.5 text-sm" htmlFor="admin-tokens-reason">
                <span className="font-medium">Reason</span>
                <input
                  id="admin-tokens-reason"
                  className="rounded-md border border-input bg-background px-3 py-2"
                  value={adminReason}
                  onChange={(event) => onAdminReasonChange?.(event.currentTarget.value)}
                />
              </label>
              <label className="flex items-center gap-2 pb-2 text-sm">
                <input
                  type="checkbox"
                  checked={reauthConfirmed}
                  onChange={(event) => onReauthConfirmedChange?.(event.currentTarget.checked)}
                />
                <span>I confirm my recent admin unlock.</span>
              </label>
            </div>
            <CreateTokenForm
              state={snapshot.createState}
              reason={snapshot.createReason}
              reauthConfirmed={reauthConfirmed}
              busy={busyAction !== null}
              onCreateToken={onCreateToken}
            />
          </div>
        </Card>

        <TokensTable
          tokens={snapshot.tokens}
          reauthConfirmed={reauthConfirmed}
          busyAction={busyAction}
          onUpdateScopes={onUpdateScopes}
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
  reauthConfirmed,
  busyAction,
  onUpdateScopes,
  onPreviewAdminAction,
}: {
  tokens: AdminTokenRow[];
  reauthConfirmed: boolean;
  busyAction: string | null;
  onUpdateScopes?: ((token: AdminTokenRow, scopes: string[]) => void) | undefined;
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
      render: (token) => <span>{sanitizeAdminText(token.owner)}</span>,
    },
    {
      key: "scopes",
      header: "Scopes",
      render: (token) => (
        <span className="text-[11.5px] text-muted-foreground">
          {token.scopes.length > 0 ? token.scopes.map(tokenScopeLabel).join(", ") : "no scopes"}
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
        <div className="flex items-center justify-end gap-2">
          <TokenScopeEditor
            token={token}
            reauthConfirmed={reauthConfirmed}
            busy={busyAction !== null}
            onUpdateScopes={onUpdateScopes}
          />
          {token.status !== "expired" ? (
            <button
              className="cursor-pointer rounded-md bg-destructive/10 px-2.5 py-1 text-xs text-destructive hover:bg-destructive/20 disabled:cursor-not-allowed disabled:opacity-50"
              type="button"
              aria-label={`Revoke token ${token.prefix}`}
              title={token.revokeReason}
              disabled={!reauthConfirmed || !token.revokeAction || busyAction !== null}
              onClick={() => {
                if (token.revokeAction)
                  onPreviewAdminAction?.(token.revokeAction);
              }}
            >
              {busyAction === `revoke:${token.id}` ? "Revoking…" : "Revoke"}
            </button>
          ) : null}
        </div>
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

function CreateTokenForm({
  state,
  reason,
  reauthConfirmed,
  busy,
  onCreateToken,
}: {
  state: AvailabilityState;
  reason: string;
  reauthConfirmed: boolean;
  busy: boolean;
  onCreateToken?: ((payload: AuthTokenCreateRequest) => void) | undefined;
}) {
  const [principalId, setPrincipalId] = useState("");
  const [deviceId, setDeviceId] = useState("");
  const [scopes, setTokenScopes] = useState("");
  const [expiresInDays, setExpiresInDays] = useState("30");
  const canCreate =
    isAvailable(state) &&
    reauthConfirmed &&
    principalId.trim().length > 0 &&
    parseScopes(scopes).length > 0 &&
    !busy &&
    Boolean(onCreateToken);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canCreate) return;
    const days = Number.parseInt(expiresInDays, 10);
    onCreateToken?.({
      principal_id: principalId.trim(),
      device_id: deviceId.trim() || null,
      scopes: parseScopes(scopes),
      ...(Number.isFinite(days) && days > 0 ? { expires_in_days: days } : {}),
    });
  }

  return (
    <form className="grid gap-3 lg:grid-cols-4" aria-label="Create API token" onSubmit={submit}>
      <label className="flex flex-col gap-1 text-xs">
        <span className="font-medium">Principal ID</span>
        <input
          className="rounded-md border border-input bg-background px-3 py-2 text-sm"
          value={principalId}
          onChange={(event) => setPrincipalId(event.currentTarget.value)}
          placeholder="principal-id"
          required
        />
      </label>
      <label className="flex flex-col gap-1 text-xs">
        <span className="font-medium">Device ID (optional)</span>
        <input
          className="rounded-md border border-input bg-background px-3 py-2 text-sm"
          value={deviceId}
          onChange={(event) => setDeviceId(event.currentTarget.value)}
          placeholder="device-id"
        />
      </label>
      <label className="flex flex-col gap-1 text-xs">
        <span className="font-medium">Scopes</span>
        <input
          className="rounded-md border border-input bg-background px-3 py-2 text-sm"
          value={scopes}
          onChange={(event) => setTokenScopes(event.currentTarget.value)}
          placeholder="Permission names, separated by commas"
          required
        />
      </label>
      <label className="flex flex-col gap-1 text-xs">
        <span className="font-medium">Expires in days</span>
        <input
          className="rounded-md border border-input bg-background px-3 py-2 text-sm"
          type="number"
          min={1}
          value={expiresInDays}
          onChange={(event) => setExpiresInDays(event.currentTarget.value)}
        />
      </label>
      <div className="flex items-center gap-3 lg:col-span-4">
        <button
          className="cursor-pointer rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
          type="submit"
          title={!isAvailable(state) ? reason : !reauthConfirmed ? "Confirm your recent admin unlock first." : undefined}
          disabled={!canCreate}
        >
          {busy ? "Saving…" : "Create token"}
        </button>
        <span className="text-xs text-muted-foreground">{reason}</span>
      </div>
    </form>
  );
}

function TokenScopeEditor({
  token,
  reauthConfirmed,
  busy,
  onUpdateScopes,
}: {
  token: AdminTokenRow;
  reauthConfirmed: boolean;
  busy: boolean;
  onUpdateScopes?: ((token: AdminTokenRow, scopes: string[]) => void) | undefined;
}) {
  const [editing, setEditing] = useState(false);
  const scopeValue = token.scopes.join(", ");
  const [value, setValue] = useState(scopeValue);
  const parsed = parseScopes(value);
  const available = isAvailable(token.updateState);

  useEffect(() => {
    if (!editing) setValue(scopeValue);
  }, [editing, scopeValue]);

  if (!editing) {
    return (
      <button
        className="cursor-pointer rounded-md border border-border px-2.5 py-1 text-xs hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
        type="button"
        title={!reauthConfirmed ? "Confirm your recent admin unlock first." : token.updateReason}
        disabled={!available || !reauthConfirmed || busy || !onUpdateScopes}
        onClick={() => setEditing(true)}
      >
        Edit scopes
      </button>
    );
  }

  return (
    <div className="flex items-center gap-1.5">
      <label className="sr-only" htmlFor={`token-scopes-${token.id}`}>Scopes for {token.prefix}</label>
      <input
        id={`token-scopes-${token.id}`}
        className="w-48 rounded-md border border-input bg-background px-2 py-1 text-xs"
        value={value}
        onChange={(event) => setValue(event.currentTarget.value)}
      />
      <button
        className="cursor-pointer rounded-md bg-primary px-2 py-1 text-xs text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50"
        type="button"
        disabled={parsed.length === 0 || busy}
        onClick={() => {
          onUpdateScopes?.(token, parsed);
          setEditing(false);
        }}
      >
        Save
      </button>
      <button
        className="cursor-pointer rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
        type="button"
        disabled={busy}
        onClick={() => {
          setValue(token.scopes.join(", "));
          setEditing(false);
        }}
      >
        Cancel
      </button>
    </div>
  );
}

function TokenStatusMessage({
  snapshot,
  mutationState,
  mutationError,
}: {
  snapshot: AdminTokensSnapshot;
  mutationState: AdminTokenMutationState;
  mutationError: string | null;
}) {
  const loadMessage: Partial<Record<AdminTokensLoadState, string>> = {
    loading: "Loading protected token records from Aurora…",
    degraded: "Token data is partially available. Some controls may be disabled.",
    denied: "Your current session cannot access token administration.",
    "service-unavailable": "Aurora token administration is currently unavailable.",
    error: "Aurora could not load token administration.",
  };
  const message =
    mutationError ??
    loadMessage[snapshot.loadState] ??
    snapshot.error ??
    (mutationState === "rollback-error"
      ? "The token change could not be applied; the previous data is still shown."
      : null);
  if (!message && mutationState === "idle") return null;

  return (
    <div
      className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm"
      role={mutationError ? "alert" : "status"}
    >
      {mutationState === "optimistic" ? "Applying token change…" : message}
    </div>
  );
}

function tokenScopeLabel(scope: string): string {
  if (scope === "*") return "All access";
  const [module, action] = scope.split(".");
  if (!module || !action) return sanitizeAdminText(scope);
  if (action === "manage") return `${adminModuleLabel(module)} management`;
  if (action === "use") return `${adminModuleLabel(module)} use`;
  return `${adminModuleLabel(module)} ${sanitizeAdminText(action)}`;
}

function parseScopes(value: string): string[] {
  return [...new Set(value.split(",").map((scope) => scope.trim()).filter(Boolean))];
}

async function copyTokenSecret(secret: string): Promise<void> {
  if (!secret || typeof navigator === "undefined" || !navigator.clipboard) return;
  try {
    await navigator.clipboard.writeText(secret);
  } catch {
    // Clipboard access can be denied by the browser; keep the visible one-time value available.
  }
}

function tokenReveal(response: AuthTokenCreateResponse): AdminTokenOneTimeReveal {
  return {
    tokenId: response.id,
    prefix: response.prefix,
    secret: response.token,
    expiresAt: response.expires_at,
  };
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
  updateCapability: CapabilitySummary | undefined,
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
      : "Token revocation is not ready yet.",
    updateState: updateCapability?.availability ?? "unsupported",
    updateReason: updateCapability
      ? capabilityReason(updateCapability)
      : "Token scope updates are not ready yet.",
    revokeAction: revokeAvailable
      ? buildTokenRevokeAdminAction(baseActionInput)
      : null,
    rotateAction: revokeAvailable
      ? buildTokenRotateAdminAction(baseActionInput)
      : null,
  };
}

function isAvailable(state: AvailabilityState | undefined): boolean {
  return Boolean(
    state && ["available-local", "available-remote", "degraded"].includes(state),
  );
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
  return adminCapabilityReason(capability);
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
    return `${label}: ${productAdminErrorCopy(settled.reason)}`;
  const value = settled.value as { ok?: boolean; error?: unknown };
  if (value && value.ok === false)
    return `${label}: ${productAdminErrorCopy(value.error)}`;
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
