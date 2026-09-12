#!/usr/bin/env node
/**
 * Unified Aurora monorepo version helpers for build configs.
 *
 * The repo-root VERSION file is the single source of truth for the version
 * shared by every surface (hosted web, desktop Tauri/Rust, mobile, and the
 * standalone Python server). App bundlers inject the label at build time so
 * the UI never hard-codes a version:
 *
 * - Production builds inject the plain base version (e.g. "1.0.0").
 * - Dev servers inject a branch-derived label (e.g. "1.0.0-dev.my-branch")
 *   so local builds are visibly distinguishable from releases.
 */

import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Base version from the repo-root VERSION file (single source of truth). */
export function auroraBaseVersion() {
  return readFileSync(resolve(repoRoot, 'VERSION'), 'utf8').trim()
}

function sanitizeBranch(branch) {
  return branch
    .trim()
    .toLowerCase()
    .replace(/[^0-9a-z-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
}

function auroraGitBranch() {
  const fromEnv =
    process.env.AURORA_GIT_BRANCH ||
    process.env.GITHUB_HEAD_REF ||
    process.env.GITHUB_REF_NAME ||
    process.env.VERCEL_GIT_COMMIT_REF ||
    ''
  if (fromEnv.trim()) return fromEnv
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim()
  } catch {
    return ''
  }
}

/**
 * Version label to inject into a UI build.
 *
 * @param {{ dev?: boolean }} options dev=true appends a branch-derived
 *   pre-release suffix; dev=false (or omitted) returns the base version.
 */
export function auroraVersionLabel({ dev = false } = {}) {
  const override = process.env.AURORA_VERSION_LABEL?.trim()
  if (override) return override
  const base = auroraBaseVersion()
  if (!dev) return base
  const branch = sanitizeBranch(auroraGitBranch())
  return branch && branch !== 'head' ? `${base}-dev.${branch}` : `${base}-dev`
}
