#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

PYTHON_BIN="${PYTHON_BIN:-python3}"

if [[ "${ERA_SKIP_INSTALL:-0}" != "1" ]]; then
  "$PYTHON_BIN" -m pip install -r requirements.txt
fi

"$PYTHON_BIN" indowordnet_1m.py run \
  --output-dir "${ERA_OUTPUT_DIR:-$SCRIPT_DIR/INDOWORDNET_1M_OUTPUT}" \
  --rows "${ERA_ROWS:-1000000}" \
  --chunk-size "${ERA_CHUNK_SIZE:-100000}" \
  "$@"
