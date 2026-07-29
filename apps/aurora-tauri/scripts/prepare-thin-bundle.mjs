#!/usr/bin/env node

process.env.AURORA_TAURI_CLIENT_CONFIG_PATH ??=
  process.env.AURORA_TAURI_THIN_CONFIG_PATH
process.env.AURORA_TAURI_CLIENT_REPORT_PATH ??=
  process.env.AURORA_TAURI_THIN_REPORT_PATH

await import('./prepare-client-bundle.mjs')
