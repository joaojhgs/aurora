import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  AuroraClient as Aurora,
  MockAuroraTransport,
  type AuditLogRequest,
} from "@aurora/client";
import {
  AdminAuditView,
  buildAdminAuditSnapshot,
  buildAuditExport,
} from "../src/index";

describe("AdminAuditView", () => {
  it("filters audit rows by actor, action, resource, and time while showing selected correlation detail", async () => {
    let backendRequest: AuditLogRequest | undefined;
    const transport = MockAuroraTransport.empty();
    transport.register("Auth.AuditLog", (request) => {
      backendRequest = request.payload as AuditLogRequest;
      return auditFixture();
    });

    const snapshot = await buildAdminAuditSnapshot(
      new Aurora({ transport }),
      {
        actor: "principal-admin",
        action: "Gateway.GetSupportBundle",
        resource: "support-bundle",
        createdAfter: "2026-06-01T00:00",
        createdBefore: "2026-06-02T00:00",
      },
    );
    const markup = renderToStaticMarkup(<AdminAuditView snapshot={snapshot} />);

    expect(backendRequest).toEqual(
      expect.objectContaining({
        principal_id: "principal-admin",
        action: "Gateway.GetSupportBundle",
      }),
    );
    expect(snapshot.rows).toHaveLength(1);
    expect(snapshot.rows[0]?.correlationId).toBe("corr-admin-001");
    expect(snapshot.warnings.join(" ")).toContain("Resource is filtered");
    expect(snapshot.warnings.join(" ")).toContain("Time range is filtered");
    expect(markup).toContain("Search actor, action, resource, and time");
    expect(markup).toContain("Selected detail");
    expect(markup).toContain("Correlation ID");
    expect(markup).toContain("corr-admin-001");
    expect(markup).not.toContain("corr-admin-002");
  });

  it("exports only redacted audit status and strips secret payload token and raw values", async () => {
    const transport = MockAuroraTransport.empty();
    transport.register("Auth.AuditLog", () => auditFixture());
    const snapshot = await buildAdminAuditSnapshot(
      new Aurora({ transport }),
    );
    const exportJson = JSON.stringify(buildAuditExport(snapshot.rows));
    const renderedJson = JSON.stringify(
      snapshot.rows.map((row) => row.redactedPreview),
    );

    expect(snapshot.rows).toHaveLength(3);
    expect(exportJson).toContain("sha256:safe-payload");
    expect(exportJson).toContain("payload:redacted");
    expect(exportJson).toContain("token:redacted");
    expect(exportJson).toContain("raw:redacted");
    expect(exportJson).not.toContain("secret-token-value");
    expect(exportJson).not.toContain("super-secret-value");
    expect(exportJson).not.toContain("raw-payload-value");
    expect(exportJson).not.toContain("raw-audio-bytes");
    expect(exportJson).not.toContain("Bearer live-token-value");
    expect(renderedJson).not.toContain("secret-token-value");
    expect(renderedJson).not.toContain("raw-payload-value");
  });
});

function auditFixture() {
  return {
    total: 3,
    events: [
      {
        id: "audit-1",
        event: "admin_action.confirmed",
        principal_id: "principal-admin",
        action: "Gateway.GetSupportBundle",
        route: "Gateway.GetSupportBundle",
        correlation_id: "corr-admin-001",
        peer_id: "peer-local",
        provider_id: "provider-local",
        tool_id: "support-bundle",
        created_at: "2026-06-01T10:00:00Z",
        details: JSON.stringify({
          resource: "support-bundle",
          audit_receipt: "receipt-admin-001",
          payload_hash: "sha256:safe-payload",
          payload: "raw-payload-value",
          token: "secret-token-value",
          raw: "raw-audio-bytes",
          authorization: "Bearer live-token-value",
          nested: {
            secret: "super-secret-value",
            payload: "nested-raw-payload-value",
          },
          support_bundle_correlation_ids: ["bundle-corr-001"],
          secrets_redacted: true,
        }),
      },
      {
        id: "audit-2",
        event: "tooling.execute.completed",
        principal_id: "principal-admin",
        action: "Tooling.ExecuteTool",
        route: "Tooling.ExecuteTool",
        correlation_id: "corr-admin-002",
        tool_id: "tool-shell",
        created_at: "2026-06-03T10:00:00Z",
        details: JSON.stringify({
          audit_receipt: "receipt-admin-002",
          payload_hash: "sha256:tool",
        }),
      },
      {
        id: "audit-3",
        event: "admin_action.denied",
        principal_id: "principal-guest",
        action: "Gateway.GetSupportBundle",
        route: "Gateway.GetSupportBundle",
        correlation_id: "corr-guest-001",
        tool_id: "support-bundle",
        created_at: "2026-06-01T12:00:00Z",
        details: JSON.stringify({
          audit_receipt: "receipt-guest-001",
          denial_reason: "permission_denied",
        }),
      },
    ],
  };
}
