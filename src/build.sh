#!/bin/sh
#
# Gainshift — build script
#
# Produces gainshift.xpi from the files in this directory.
#
# There is no compilation, bundling, minification or code generation of any
# kind in this project. The .xpi is a plain zip of six source files and nine
# PNG icons, exactly as they appear here. This script exists so that the
# packaging step is executable and reproducible rather than described.
#
# Usage:
#   ./build.sh              build ../gainshift.xpi
#   ./build.sh --test       run the test suites first, then build
#   ./build.sh --verify F   build, then compare the result against F
#
# Requirements: see README.md ("Build environment").
#
set -eu

# ---------------------------------------------------------------------------
# Deterministic output.
#
# A zip archive records each entry's modification time, so the same files
# packaged on two machines normally produce two different archives. Two things
# fix that here:
#
#   * every staged file is stamped with SOURCE_DATE_EPOCH (default: a fixed
#     constant, so the default build is deterministic with no setup), and
#   * TZ is pinned to UTC, because zip writes the MS-DOS time field in local
#     time.
#
# The result is byte-for-byte identical on any machine. `sha256sum` on the
# built file is therefore a valid check, not just a formality.
# ---------------------------------------------------------------------------
: "${SOURCE_DATE_EPOCH:=1262304000}"   # 2010-01-01T00:00:00Z
export TZ=UTC

OUT_DEFAULT="../gainshift.xpi"
VERIFY_AGAINST=""
RUN_TESTS=0

while [ $# -gt 0 ]; do
  case "$1" in
    --test)   RUN_TESTS=1; shift ;;
    --verify) VERIFY_AGAINST="${2:?--verify needs a file}"; shift 2 ;;
    -h|--help)
      sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "build.sh: unknown argument: $1" >&2; exit 2 ;;
  esac
done

cd "$(dirname "$0")"

# ---------------------------------------------------------------------------
# The packaged file list, in the order it is written into the archive.
# Anything not on this list is not shipped: the tests, this script, the README
# and the SVG icon sources stay in the source tree only.
# ---------------------------------------------------------------------------
FILES="manifest.json
background.js
content.js
audio-hook.js
popup.html
popup.js
icon-16.png
icon-32.png
icon-48.png
icon-64.png
icon-96.png
icon-128.png
icon-muted-16.png
icon-muted-32.png
icon-muted-48.png"

# ---------------------------------------------------------------------------
# Preconditions.
# ---------------------------------------------------------------------------
command -v zip >/dev/null 2>&1 || {
  echo "build.sh: 'zip' not found. See README.md, 'Build environment'." >&2
  exit 1
}

missing=""
for f in $FILES; do
  [ -f "$f" ] || missing="$missing $f"
done
[ -z "$missing" ] || { echo "build.sh: missing source file(s):$missing" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Tests (optional; they are not part of producing the .xpi).
# ---------------------------------------------------------------------------
if [ "$RUN_TESTS" -eq 1 ]; then
  command -v node >/dev/null 2>&1 || {
    echo "build.sh: --test needs node. See README.md, 'Build environment'." >&2
    exit 1
  }
  echo "== tests =="
  node test-audio-hook.js
  node test-background.js
  node test-popup.js
  echo
fi

# ---------------------------------------------------------------------------
# Package.
# ---------------------------------------------------------------------------
OUT="$OUT_DEFAULT"
OUT_ABS=$(cd "$(dirname "$OUT")" && printf '%s/%s' "$(pwd)" "$(basename "$OUT")")

STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT INT TERM

for f in $FILES; do
  cp -p "$f" "$STAGE/$f"
done

# Normalise timestamps so the archive is reproducible.
if touch -d "@$SOURCE_DATE_EPOCH" "$STAGE/manifest.json" 2>/dev/null; then
  STAMP="-d @$SOURCE_DATE_EPOCH"                      # GNU coreutils
else
  STAMP="-t $(date -u -r "$SOURCE_DATE_EPOCH" +%Y%m%d%H%M.%S)"   # BSD / macOS
fi
for f in $FILES; do
  # shellcheck disable=SC2086
  touch $STAMP "$STAGE/$f"
done

rm -f "$OUT_ABS"
# -X  drop platform extra fields (uid/gid, extended timestamps)
# -D  no directory entries
# -9  fixed compression level, so the level is not a build variable
# -q  quiet; the file list is printed below instead
( cd "$STAGE" && printf '%s\n' $FILES | zip -X -D -9 -q "$OUT_ABS" -@ )

echo "== built =="
echo "$OUT_ABS"
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$OUT_ABS"
elif command -v shasum >/dev/null 2>&1; then
  shasum -a 256 "$OUT_ABS"
fi
echo
unzip -l "$OUT_ABS" 2>/dev/null || true

# ---------------------------------------------------------------------------
# Verify against a reference copy (e.g. the file submitted to AMO).
# ---------------------------------------------------------------------------
if [ -n "$VERIFY_AGAINST" ]; then
  echo
  echo "== verify against $VERIFY_AGAINST =="
  [ -f "$VERIFY_AGAINST" ] || { echo "not found: $VERIFY_AGAINST" >&2; exit 1; }

  if cmp -s "$OUT_ABS" "$VERIFY_AGAINST"; then
    echo "IDENTICAL (byte for byte)"
  else
    # Fall back to a content comparison: the archive container can differ
    # (timestamps, zip version) while every packaged file is identical.
    A="$STAGE/_a"; B="$STAGE/_b"
    mkdir -p "$A" "$B"
    unzip -qq "$OUT_ABS"        -d "$A"
    unzip -qq "$VERIFY_AGAINST" -d "$B"
    if diff -r "$A" "$B" >/dev/null 2>&1; then
      echo "Archive bytes differ, but every packaged file is IDENTICAL."
      echo "(That is a zip container difference — timestamps or zip version —"
      echo " not a difference in the add-on's code.)"
    else
      echo "DIFFERENT — packaged files do not match:"
      diff -r "$A" "$B" || true
      exit 1
    fi
  fi
fi
