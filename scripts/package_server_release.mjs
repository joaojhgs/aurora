#!/usr/bin/env node
import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const version = requiredOption('--version')
const wheel = resolve(requiredOption('--wheel'))
const output = resolve(requiredOption('--output'))
const report = resolve(requiredOption('--report'))
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u

if (!semver.test(version)) throw new Error(`invalid release version: ${version}`)
if (!existsSync(wheel) || !lstatSync(wheel).isFile()) throw new Error(`wheel does not exist: ${wheel}`)
if (!/^aurora[-_].*\.whl$/iu.test(basename(wheel))) throw new Error(`not an Aurora wheel: ${wheel}`)
const wheelVersion = /^aurora-([^-]+)-[^-]+-[^-]+-[^-]+\.whl$/iu.exec(basename(wheel))?.[1]
const expectedWheelVersion = version.replace(/-rc\.(\d+)$/iu, 'rc$1')
if (wheelVersion !== expectedWheelVersion) {
  throw new Error(
    `Aurora wheel version ${wheelVersion ?? 'unknown'} does not match release version ${version} (expected ${expectedWheelVersion})`,
  )
}

const outputDir = dirname(output)
const stageName = `aurora-server-${version}`
const stageRoot = join(outputDir, stageName)
rmSync(stageRoot, { recursive: true, force: true })
mkdirSync(join(stageRoot, 'packages'), { recursive: true })
copyFileSync(wheel, join(stageRoot, 'packages', basename(wheel)))

const release = {
  schema: 'aurora.server-release.v1',
  version,
  generatedAt: new Date(0).toISOString(),
  wheel: `packages/${basename(wheel)}`,
  installProfile: 'server-core',
  wheelExtra: 'sidecar-thin',
  startCommand: 'aurora-server',
}
writeFileSync(join(stageRoot, 'RELEASE.json'), `${JSON.stringify(release, null, 2)}\n`)
writeFileSync(join(stageRoot, 'config.json'), `${JSON.stringify(serverConfig(), null, 2)}\n`)
writeFileSync(
  join(stageRoot, 'README.txt'),
  [
    `Aurora server ${version}`,
    '',
    'Run ./install.sh to create the managed Python 3.11 environment.',
    'The default profile includes the Gateway and core server services.',
    'Local Python STT/TTS are disabled; clients may use their native/browser voice path.',
    'After installation, start the service with aurora-server.',
    '',
  ].join('\n'),
)
writeExecutable(join(stageRoot, 'install.sh'), serverInstaller())
writeExecutable(join(stageRoot, 'run-server.sh'), serverLauncher())

rmSync(output, { force: true })
const tar = spawnSync(
  'tar',
  [
    '--sort=name',
    '--mtime=@0',
    '--owner=0',
    '--group=0',
    '--numeric-owner',
    '-czf',
    output,
    '-C',
    outputDir,
    stageName,
  ],
  { cwd: repoRoot, encoding: 'utf8' },
)
if (tar.status !== 0) throw new Error(`tar failed: ${tar.stderr || tar.stdout}`)

const bytes = statSync(output).size
const sha256 = createHash('sha256').update(readFileSync(output)).digest('hex')
mkdirSync(dirname(report), { recursive: true })
writeFileSync(
  report,
  `${JSON.stringify({
    version,
    artifact: relative(repoRoot, output).replaceAll('\\', '/'),
    bytes,
    sha256,
    wheel: basename(wheel),
    reproducibleTarOptions: ['--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner'],
  }, null, 2)}\n`,
)
rmSync(stageRoot, { recursive: true, force: true })
console.log(`Wrote ${relative(repoRoot, output)} (${bytes} bytes, sha256 ${sha256})`)

function requiredOption(name) {
  const index = process.argv.indexOf(name)
  const value = index === -1 ? '' : process.argv[index + 1]?.trim() ?? ''
  if (!value) throw new Error(`${name} is required`)
  return value
}

function writeExecutable(path, contents) {
  writeFileSync(path, contents)
  chmodSync(path, 0o755)
}

function serverInstaller() {
  return `#!/bin/sh
set -eu

server_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
bin_dir=\${AURORA_BIN_DIR:-"$HOME/.local/bin"}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --bin-dir)
      [ "$#" -ge 2 ] || { echo "--bin-dir requires a value" >&2; exit 2; }
      bin_dir=$2
      shift 2
      ;;
    *)
      echo "unknown option: $1" >&2
      exit 2
      ;;
  esac
done

command -v uv >/dev/null 2>&1 || {
  echo "uv is required; install it from https://docs.astral.sh/uv/" >&2
  exit 1
}

wheel=
for candidate in "$server_root"/packages/aurora-*.whl "$server_root"/packages/aurora_*.whl; do
  [ -f "$candidate" ] || continue
  [ -z "$wheel" ] || { echo "server archive contains more than one Aurora wheel" >&2; exit 1; }
  wheel=$candidate
done
[ -n "$wheel" ] || { echo "server archive does not contain an Aurora wheel" >&2; exit 1; }

uv venv --python 3.11 "$server_root/.venv"
uv pip install --python "$server_root/.venv/bin/python" "$wheel[sidecar-thin]"

mkdir -p "$bin_dir"
launcher="$bin_dir/aurora-server"
if [ -e "$launcher" ] && [ ! -L "$launcher" ]; then
  echo "$launcher already exists and is not a symbolic link" >&2
  exit 1
fi
ln -sfn "$server_root/run-server.sh" "$launcher"
printf 'Aurora server installed. Start it with %s\n' "$launcher"
`
}

function serverLauncher() {
  return `#!/bin/sh
set -eu

self=$0
while [ -L "$self" ]; do
  self_dir=$(CDPATH= cd -P -- "$(dirname -- "$self")" && pwd)
  target=$(readlink "$self")
  case "$target" in
    /*) self=$target ;;
    *) self=$self_dir/$target ;;
  esac
done
server_root=$(CDPATH= cd -P -- "$(dirname -- "$self")" && pwd)
cd "$server_root"
exec "$server_root/.venv/bin/aurora" "$@"
`
}

function serverConfig() {
  const defaultsPath = join(repoRoot, 'app', 'services', 'config', 'config_defaults.json')
  if (!existsSync(defaultsPath)) throw new Error(`server config defaults do not exist: ${defaultsPath}`)
  const config = JSON.parse(readFileSync(defaultsPath, 'utf8'))
  config.ui.activate = false
  config.services.gateway.enabled = true
  config.services.stt.coordinator.enabled = false
  config.services.stt.transcription.enabled = false
  config.services.stt.wakeword.enabled = false
  config.services.tts.enabled = false
  return config
}
