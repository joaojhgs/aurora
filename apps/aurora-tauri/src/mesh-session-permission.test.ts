import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function repoText(path: string): string {
  return readFileSync(resolve(repoRoot, path), "utf8").replace(/\r\n?/g, "\n");
}

describe("mesh session permissions", () => {
  it("permits every mesh-session command invoked by the webview link", () => {
    const linkSource = repoText("apps/aurora-tauri/src/mesh-session-link.ts");
    const permissionSource = repoText(
      "apps/aurora-tauri/src-tauri/permissions/aurora-mesh-session.toml",
    );
    const invokedCommands = [
      ...new Set(
        Array.from(linkSource.matchAll(/"(aurora_mesh_session_[a-z_]+)"/g)).map(
          ([, command]) => command,
        ),
      ),
    ].sort();
    const allowedCommands = [
      ...new Set(
        Array.from(
          permissionSource.matchAll(/"(aurora_mesh_session_[a-z_]+)"/g),
        ).map(([, command]) => command),
      ),
    ].sort();

    expect(allowedCommands).toContain("aurora_mesh_session_finish_resume");
    for (const command of invokedCommands) {
      expect(allowedCommands).toContain(command);
    }
  });
});
