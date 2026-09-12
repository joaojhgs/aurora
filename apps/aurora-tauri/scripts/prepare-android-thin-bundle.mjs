#!/usr/bin/env node

process.env.AURORA_TAURI_ANDROID_CLIENT_CONFIG_PATH ??=
  process.env.AURORA_TAURI_ANDROID_THIN_CONFIG_PATH
process.env.AURORA_TAURI_ANDROID_CLIENT_REPORT_PATH ??=
  process.env.AURORA_TAURI_ANDROID_THIN_REPORT_PATH

await import('./prepare-android-client-bundle.mjs')
