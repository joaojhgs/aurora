#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const inputPath = resolve(requiredOption('--input'))
const outputPath = resolve(requiredOption('--output'))
const version = requiredOption('--version')
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u

if (!semver.test(version)) throw new Error(`invalid release version: ${version}`)

const output = readFileSync(inputPath, 'utf8').replaceAll('\r\n', '\n')
const startMarker = 'release_notes<<EOF\n'
const start = output.indexOf(startMarker)
const end = output.lastIndexOf('\nEOF\n')
if (start === -1 || end === -1 || end <= start + startMarker.length) {
  throw new Error('semantic-release output does not contain complete release notes')
}
const metadata = output.slice(0, start)
if (
  !metadata.includes('released=true\n') ||
  !metadata.includes(`version=${version}\n`) ||
  !metadata.includes(`tag=v${version}\n`)
) {
  throw new Error('semantic-release output version does not match the requested preview')
}

const releaseNotes = output.slice(start + startMarker.length, end).trim()
const releaseNotesBytes = Buffer.byteLength(releaseNotes, 'utf8')
if (releaseNotesBytes < 80 || releaseNotesBytes > 750_000) {
  throw new Error('semantic-release notes have an unexpected size')
}
if (!releaseNotes.startsWith(`## v${version}`)) {
  throw new Error('semantic-release notes do not start with the requested version')
}

mkdirSync(dirname(outputPath), { recursive: true })
writeFileSync(outputPath, `${releaseNotes}\n`)
console.log(`Extracted semantic release notes for v${version} (${releaseNotesBytes} bytes)`)

function requiredOption(name) {
  const index = process.argv.indexOf(name)
  const value = index === -1 ? '' : process.argv[index + 1]?.trim() ?? ''
  if (!value) throw new Error(`${name} is required`)
  return value
}
