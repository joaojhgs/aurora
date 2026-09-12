/**
 * Unified Aurora version helpers.
 *
 * Single source of truth: the repo-root VERSION file. Every app bundler
 * injects it at build time (Vite define for desktop/mobile, Next `env` for
 * hosted web, vitest define for tests). Dev builds carry a branch-derived
 * label like "1.0.0-dev.my-branch"; release builds carry the plain version.
 *
 * Precedence for user-facing display: when the connected Aurora server
 * reports its own version through the capability catalog, that server version
 * wins (it reflects what this client is actually talking to); otherwise the
 * build label is shown. All surfaces resolve from the same VERSION file, so
 * matching deployments always agree.
 */

declare const __AURORA_VERSION_LABEL__: string | undefined

/**
 * Last-resort version when no build-time injection ran (e.g. unbundled
 * consumers). Keep in sync with the repo-root VERSION file.
 */
export const AURORA_FALLBACK_VERSION = '1.0.0'

function readInjectedVersionLabel(): string | null {
  // Vite/Tauri define. `typeof` is safe when the identifier was never injected.
  if (typeof __AURORA_VERSION_LABEL__ === 'string' && __AURORA_VERSION_LABEL__.trim()) {
    return __AURORA_VERSION_LABEL__.trim()
  }
  try {
    // Direct `process.env.NEXT_PUBLIC_*` access so Next.js can inline it.
    const nextPublic = process.env.NEXT_PUBLIC_AURORA_VERSION_LABEL
    if (typeof nextPublic === 'string' && nextPublic.trim()) return nextPublic.trim()
  } catch {
    // `process` is absent in some browser bundles.
  }
  return null
}

/** Version of this UI build: injected label, or the last-resort fallback. */
export function auroraBuildVersionLabel(): string {
  return readInjectedVersionLabel() ?? AURORA_FALLBACK_VERSION
}

/**
 * Version label for the shell runtime chip. A non-empty server-reported
 * version takes precedence over the UI build label.
 */
export function auroraRuntimeVersionLabel(serverVersion?: string | null): string {
  const server = typeof serverVersion === 'string' ? serverVersion.trim() : ''
  return server || auroraBuildVersionLabel()
}
