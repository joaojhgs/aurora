#!/usr/bin/env node

process.env.AURORA_TAURI_IOS_CLIENT_CONFIG_PATH ??=
  process.env.AURORA_TAURI_IOS_THIN_CONFIG_PATH
process.env.AURORA_TAURI_IOS_CLIENT_REPORT_PATH ??=
  process.env.AURORA_TAURI_IOS_THIN_REPORT_PATH

await import('./prepare-ios-client-bundle.mjs')
