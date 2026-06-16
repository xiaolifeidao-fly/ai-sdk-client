#!/bin/sh
set -eu

export LC_ALL=C
export LANG=C

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

usage() {
  echo "Usage: $0 [archive.tar.gz] [deploy_parent_dir]" >&2
  echo "Example: $0" >&2
  echo "Example: $0 ai-sdk-client-linux-x64.tar.gz $SCRIPT_DIR" >&2
}

ARCHIVE="${1:-}"
DEPLOY_PARENT_DIR="${2:-$SCRIPT_DIR}"

if [ -z "$ARCHIVE" ]; then
  ARCHIVE="$(find "$SCRIPT_DIR" -maxdepth 1 -type f \( -name '*.tar.gz' -o -name '*.tgz' \) | sort | sed -n '1p')"
  if [ -z "$ARCHIVE" ]; then
    usage
    exit 1
  fi
fi

if [ ! -f "$ARCHIVE" ]; then
  echo "archive not found: $ARCHIVE" >&2
  exit 1
fi

case "$ARCHIVE" in
  *.tar.gz|*.tgz) ;;
  *)
    echo "unsupported archive type, expected .tar.gz or .tgz: $ARCHIVE" >&2
    exit 1
    ;;
esac

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/ai-sdk-client-release.XXXXXX")"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT INT TERM

mkdir -p "$DEPLOY_PARENT_DIR"

tar -xzf "$ARCHIVE" -C "$TMP_DIR"

ROOT_COUNT="$(find "$TMP_DIR" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')"
if [ "$ROOT_COUNT" != "1" ]; then
  echo "archive must contain exactly one top-level directory" >&2
  exit 1
fi

SRC_DIR="$(find "$TMP_DIR" -mindepth 1 -maxdepth 1 -type d | sed -n '1p')"
RELEASE_NAME="$(basename "$SRC_DIR")"
RELEASE_DIR="$DEPLOY_PARENT_DIR/$RELEASE_NAME"

tar -xzf "$ARCHIVE" -C "$DEPLOY_PARENT_DIR"

for name in start.sh stop.sh; do
  if [ -f "$RELEASE_DIR/$name" ]; then
    chmod +x "$RELEASE_DIR/$name"
  fi
done

echo "release unpacked: $ARCHIVE -> $RELEASE_DIR"
