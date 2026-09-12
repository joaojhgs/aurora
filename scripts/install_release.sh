#!/bin/sh
set -eu

usage() {
  cat >&2 <<'EOF'
Usage: install_release.sh <server|web> <version> [--prefix DIR] [--bin-dir DIR]

Downloads a pinned Aurora GitHub release archive, verifies it against the
release SHA256SUMS file, and installs it under a versioned directory.
EOF
}

[ "$#" -ge 2 ] || { usage; exit 2; }
surface=$1
version=$2
shift 2

case "$surface" in
  server|web) ;;
  *) echo "unsupported release surface: $surface" >&2; usage; exit 2 ;;
esac
case "$version" in
  *[!0-9A-Za-z.+-]*|.*|-*|*-) echo "invalid release version: $version" >&2; exit 2 ;;
esac

prefix=${AURORA_INSTALL_PREFIX:-"$HOME/.local/share/aurora"}
bin_dir=${AURORA_BIN_DIR:-"$HOME/.local/bin"}
while [ "$#" -gt 0 ]; do
  case "$1" in
    --prefix)
      [ "$#" -ge 2 ] || { echo "--prefix requires a value" >&2; exit 2; }
      prefix=$2
      shift 2
      ;;
    --bin-dir)
      [ "$#" -ge 2 ] || { echo "--bin-dir requires a value" >&2; exit 2; }
      bin_dir=$2
      shift 2
      ;;
    *)
      echo "unknown option: $1" >&2
      usage
      exit 2
      ;;
  esac
done

command -v curl >/dev/null 2>&1 || { echo "curl is required" >&2; exit 1; }
command -v tar >/dev/null 2>&1 || { echo "tar is required" >&2; exit 1; }

asset="aurora-$version-$surface.tar.gz"
tag="v$version"
release_base=${AURORA_RELEASE_BASE_URL:-"https://github.com/joaojhgs/aurora/releases/download"}
asset_url="$release_base/$tag/$asset"
sums_url="$release_base/$tag/SHA256SUMS"
install_root="$prefix/$surface/$version"

if [ -e "$install_root" ]; then
  echo "install target already exists: $install_root" >&2
  exit 1
fi

temp_root=$(mktemp -d "${TMPDIR:-/tmp}/aurora-release-install.XXXXXX")
cleanup() {
  rm -rf -- "$temp_root"
}
trap cleanup EXIT HUP INT TERM

archive="$temp_root/$asset"
sums="$temp_root/SHA256SUMS"
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 -o "$archive" "$asset_url"
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 -o "$sums" "$sums_url"

expected=$(awk -v asset="$asset" '
  $2 == asset && length($1) == 64 && $1 !~ /[^0-9a-f]/ { count += 1; value = $1 }
  END { if (count == 1) print value }
' "$sums")
[ -n "$expected" ] || { echo "release checksum is missing, duplicated, or malformed for $asset" >&2; exit 1; }
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$archive" | awk '{ print $1 }')
elif command -v shasum >/dev/null 2>&1; then
  actual=$(shasum -a 256 "$archive" | awk '{ print $1 }')
else
  echo "sha256sum or shasum is required" >&2
  exit 1
fi
if [ "$actual" != "$expected" ]; then
  echo "checksum verification failed for $asset" >&2
  exit 1
fi

members="$temp_root/members.txt"
tar -tzf "$archive" > "$members"
if awk -F/ '
  /^\// { bad = 1 }
  { for (index = 1; index <= NF; index += 1) if ($index == "..") bad = 1 }
  END { exit bad ? 0 : 1 }
' "$members"; then
  echo "release archive contains an unsafe path" >&2
  exit 1
fi
top_levels=$(awk -F/ 'NF && $1 != "." { print $1 }' "$members" | sort -u)
top_level_count=$(printf '%s\n' "$top_levels" | awk 'NF { count += 1 } END { print count + 0 }')
if [ "$top_level_count" -ne 1 ]; then
  echo "release archive must contain exactly one top-level directory" >&2
  exit 1
fi

extract_root="$temp_root/extracted"
mkdir -p "$extract_root"
tar -xzf "$archive" -C "$extract_root"
source_root="$extract_root/$top_levels"
[ -d "$source_root" ] || { echo "release archive root is missing" >&2; exit 1; }
mkdir -p "$(dirname -- "$install_root")" "$bin_dir"
mv "$source_root" "$install_root"

if [ "$surface" = "server" ]; then
  [ -x "$install_root/install.sh" ] || { echo "server installer is missing" >&2; exit 1; }
  "$install_root/install.sh" --bin-dir "$bin_dir"
else
  command -v node >/dev/null 2>&1 || { echo "Node.js is required to run the web package" >&2; exit 1; }
  web_server="$install_root/apps/aurora-web/server.js"
  [ -f "$web_server" ] || { echo "standalone web server is missing" >&2; exit 1; }
  run_web="$install_root/run-web.sh"
  cat > "$run_web" <<'EOF'
#!/bin/sh
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
web_root=$(CDPATH= cd -P -- "$(dirname -- "$self")" && pwd)
cd "$web_root"
exec node "$web_root/apps/aurora-web/server.js" "$@"
EOF
  chmod 755 "$run_web"
  launcher="$bin_dir/aurora-web"
  if [ -e "$launcher" ] && [ ! -L "$launcher" ]; then
    echo "$launcher already exists and is not a symbolic link" >&2
    exit 1
  fi
  ln -sfn "$run_web" "$launcher"
  printf 'Aurora web installed. Start it with %s\n' "$launcher"
fi

printf 'Installed Aurora %s %s at %s\n' "$surface" "$version" "$install_root"
