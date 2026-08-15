#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readlinkSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const explicitAppDir = readOption('--appdir')

if (explicitAppDir) {
  const appDir = resolve(explicitAppDir)
  const changed = normalizeDirIcon(appDir)
  console.log(`AppImage directory icon ${changed ? 'normalized' : 'already portable'}: ${appDir}`)
} else {
  normalizeBundleRoot()
}

function normalizeBundleRoot() {
  const bundleRoot = resolve(
    readOption('--root')
      ?? process.env.AURORA_APPIMAGE_BUNDLE_ROOT
      ?? join(packageRoot, 'src-tauri', 'target', 'release', 'bundle'),
  )
  if (!existsSync(bundleRoot)) {
    throw new Error(`AppImage bundle root does not exist: ${bundleRoot}`)
  }

  const images = walk(bundleRoot).filter((path) => path.endsWith('.AppImage'))
  for (const image of images) normalizeImage(image)
  console.log(`Portable AppImage metadata verified for ${images.length} artifact(s).`)
}

function normalizeImage(image) {
  const extractDir = mkdtempSync(join(tmpdir(), 'aurora-appimage-normalize-'))
  const output = `${image}.normalized-${process.pid}.tmp`
  try {
    execFileSync(image, ['--appimage-extract'], {
      cwd: extractDir,
      encoding: 'utf8',
      timeout: 120_000,
    })
    const appDir = join(extractDir, 'squashfs-root')
    if (!existsSync(appDir)) {
      throw new Error(`AppImage extraction did not create squashfs-root: ${image}`)
    }
    if (!normalizeDirIcon(appDir)) return

    const packager = resolve(
      process.env.AURORA_APPIMAGE_PACKAGER
        ?? join(homedir(), '.cache', 'tauri', 'linuxdeploy-plugin-appimage.AppImage'),
    )
    if (!existsSync(packager)) {
      throw new Error(`Tauri AppImage packager is unavailable: ${packager}`)
    }

    execFileSync(packager, ['--appimage-extract-and-run', `--appdir=${appDir}`], {
      env: {
        ...process.env,
        APPIMAGE_EXTRACT_AND_RUN: '1',
        ARCH: appImageArchitecture(),
        LDAI_OUTPUT: output,
      },
      stdio: 'inherit',
      timeout: 300_000,
    })
    if (!existsSync(output)) {
      throw new Error(`AppImage packager did not create the requested output: ${output}`)
    }
    chmodSync(output, lstatSync(image).mode & 0o777)
    renameSync(output, image)
  } finally {
    rmSync(output, { force: true })
    rmSync(extractDir, { recursive: true, force: true })
  }
}

function normalizeDirIcon(appDir) {
  const iconLink = join(appDir, '.DirIcon')
  if (!existsSync(iconLink) && !isSymlink(iconLink)) return false
  if (!isSymlink(iconLink)) {
    throw new Error(`AppImage .DirIcon must be a symbolic link: ${iconLink}`)
  }

  const target = readlinkSync(iconLink)
  if (!isAbsolute(target)) {
    assertContained(appDir, resolve(dirname(iconLink), target))
    return false
  }

  const portableTarget = basename(target)
  const packagedIcon = join(appDir, portableTarget)
  if (!existsSync(packagedIcon) || !lstatSync(packagedIcon).isFile()) {
    throw new Error(`Cannot normalize AppImage .DirIcon; packaged icon is missing: ${packagedIcon}`)
  }

  rmSync(iconLink)
  symlinkSync(portableTarget, iconLink)
  assertContained(appDir, resolve(dirname(iconLink), portableTarget))
  return true
}

function assertContained(root, target) {
  const rel = relative(resolve(root), target)
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return
  throw new Error(`AppImage .DirIcon escapes the extracted application root: ${target}`)
}

function isSymlink(path) {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

function walk(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name)
    return entry.isDirectory() ? walk(path) : [path]
  })
}

function appImageArchitecture() {
  if (process.arch === 'x64') return 'x86_64'
  if (process.arch === 'arm64') return 'aarch64'
  return process.arch
}

function readOption(name) {
  const index = args.indexOf(name)
  return index === -1 ? null : args[index + 1]
}
