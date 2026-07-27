#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUTPUT_DIR="${ERA_OUTPUT_DIR:-$SCRIPT_DIR/INDOWORDNET_1M_OUTPUT}"
ARCHIVE="${ERA_EVIDENCE_ZIP:-$SCRIPT_DIR/ERA_IndoWordNet_1M_Evidence.zip}"

if [[ ! -f "$OUTPUT_DIR/reports/INDOWORDNET_1M_SUMMARY.json" ]]; then
  echo "Missing completed-run summary: $OUTPUT_DIR/reports/INDOWORDNET_1M_SUMMARY.json" >&2
  exit 1
fi

rm -f "$ARCHIVE"
(
  cd "$OUTPUT_DIR"
  zip -q -r "$ARCHIVE" \
    checkpoint.json \
    reports \
    manifests \
    logs \
    -x '*.DS_Store'
)

unzip -t "$ARCHIVE"
if command -v shasum >/dev/null 2>&1; then
  shasum -a 256 "$ARCHIVE"
else
  sha256sum "$ARCHIVE"
fi

echo "Evidence archive: $ARCHIVE"
