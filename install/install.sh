#!/bin/sh
set -eu

usage() {
  cat >&2 <<'USAGE'
Usage: install.sh <local-package.tgz|https://host/path/package.tgz> [--sha256 <64-hex-digest>]
Remote HTTPS archives require the published SHA-256 digest. This script does not guess a download URL.
USAGE
}

if [ "$#" -lt 1 ] || [ "$#" -gt 3 ]; then
  usage
  exit 2
fi
source_value=$1
sha256=''
if [ "$#" -gt 1 ]; then
  if [ "$#" -ne 3 ] || [ "$2" != '--sha256' ]; then
    usage
    exit 2
  fi
  sha256=$3
fi

case "$sha256" in
  '' ) ;;
  * )
    case "$sha256" in
      *[!0123456789abcdefABCDEF]* ) echo 'SHA-256 must be exactly 64 hexadecimal characters.' >&2; exit 2 ;;
    esac
    if [ "${#sha256}" -ne 64 ]; then echo 'SHA-256 must be exactly 64 hexadecimal characters.' >&2; exit 2; fi
    ;;
esac

temporary_dir=''
cleanup() {
  if [ -n "$temporary_dir" ]; then rm -rf "$temporary_dir"; fi
}
trap cleanup EXIT HUP INT TERM

package_path=$source_value
case "$source_value" in
  https://* )
    if [ -z "$sha256" ]; then
      echo 'Remote HTTPS archives require --sha256 <64-hex-digest>.' >&2
      exit 2
    fi
    authority=${source_value#https://}
    authority=${authority%%/*}
    case "$authority" in
      *'@'*|'' ) echo 'HTTPS URLs must use a host without embedded user credentials.' >&2; exit 2 ;;
    esac
    case "$source_value" in
      *\?*|*\#* ) echo 'HTTPS URL query strings and fragments are not accepted.' >&2; exit 2 ;;
    esac
    command -v curl >/dev/null 2>&1 || { echo 'curl is required to download an HTTPS archive.' >&2; exit 1; }
    temporary_dir=$(mktemp -d "${TMPDIR:-/tmp}/campaign-manager-install.XXXXXX")
    package_path=$temporary_dir/package.tgz
    curl --fail --location --silent --show-error --proto '=https' --tlsv1.2 --output "$package_path" "$source_value"
    ;;
  http://* ) echo 'Remote archives must use HTTPS.' >&2; exit 2 ;;
  * )
    if [ ! -f "$source_value" ]; then echo 'Local package archive does not exist.' >&2; exit 2; fi
    ;;
esac

if [ -n "$sha256" ]; then
  if command -v sha256sum >/dev/null 2>&1; then
    actual=$(sha256sum "$package_path" | cut -d ' ' -f 1)
  elif command -v shasum >/dev/null 2>&1; then
    actual=$(shasum -a 256 "$package_path" | cut -d ' ' -f 1)
  else
    echo 'sha256sum or shasum is required to verify the archive.' >&2
    exit 1
  fi
  actual_lower=$(printf '%s' "$actual" | tr 'ABCDEF' 'abcdef')
  expected_lower=$(printf '%s' "$sha256" | tr 'ABCDEF' 'abcdef')
  if [ "$actual_lower" != "$expected_lower" ]; then
    echo 'SHA-256 digest mismatch; npm was not invoked.' >&2
    exit 1
  fi
fi

command -v npm >/dev/null 2>&1 || { echo 'npm is required. Install Node.js 24 or later, then retry.' >&2; exit 1; }
if [ -n "${XDG_DATA_HOME:-}" ]; then
  data_home=$XDG_DATA_HOME
else
  data_home=$HOME/.local/share
fi
case "$data_home" in
  /* ) ;;
  * ) echo 'XDG_DATA_HOME must be an absolute path when set.' >&2; exit 2 ;;
esac
install_prefix=$data_home/omo-research/npm
mkdir -p "$install_prefix"
npm install --global --prefix "$install_prefix" --ignore-scripts -- "$package_path"
echo 'Installed campaign-manager without elevation.'
echo "Launcher: $install_prefix/bin/campaign-manager"
