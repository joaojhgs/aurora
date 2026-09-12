#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), "../../..");
const requiredFiles = [
  "packages/aurora-ui/src/local-speech/wakeword/openwakeword-mel.ts",
  "packages/aurora-ui/src/local-speech/wakeword/openwakeword-embedding.ts",
  "packages/aurora-ui/src/local-speech/wakeword/openwakeword-window.ts",
  "packages/aurora-ui/src/local-speech/wakeword/openwakeword-classifier.ts",
];
const packagePaths = ["package.json", "packages/aurora-ui/package.json", "apps/aurora-tauri/package.json", "apps/aurora-web/package.json"];
const missingFiles = requiredFiles.filter((path) => !existsSync(join(repoRoot, path)));
const dependencyHits = [];
for (const path of packagePaths) {
  const abs = join(repoRoot, path);
  if (!existsSync(abs)) continue;
  const manifest = JSON.parse(readFileSync(abs, "utf8"));
  const deps = { ...(manifest.dependencies ?? {}), ...(manifest.devDependencies ?? {}) };
  for (const name of Object.keys(deps)) {
    if (["onnxruntime-web", "openwakeword", "livekit-wakeword"].includes(name)) {
      dependencyHits.push({ package: path, dependency: name, version: deps[name] });
    }
  }
}
const payload = {
  schema_version: 1,
  decision: {
    typescript_trained_pack_import:
      missingFiles.length === 0 && dependencyHits.some((hit) => hit.dependency === "onnxruntime-web")
        ? "candidate_present"
        : "absent",
    reason: "The complete browser-side OpenWakeWord mel, embedding, window, and classifier frontend is required before import can be advertised.",
  },
  missing_files: missingFiles,
  dependency_hits: dependencyHits,
  remote_continuous_wake_audio: "rejected",
};
const out = join(repoRoot, ".artifacts/pockettts/w0-kws/reports/browser-frontend-absence.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`);
console.log(out);
process.exit(0);
