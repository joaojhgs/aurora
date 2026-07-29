#!/usr/bin/env node

process.env.AURORA_TAURI_CLIENT_CONFIG_PATH ??=
  process.env.AURORA_TAURI_THIN_CONFIG_PATH
process.env.AURORA_TAURI_CLIENT_PROOF_REPORT_PATH ??=
  process.env.AURORA_TAURI_THIN_PROOF_REPORT_PATH

await import('./assert-client-bundle-clean.mjs')
