#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

PYTHON_BIN="${PYTHON_BIN:-python3}"
"$PYTHON_BIN" indowordnet_1m.py verify \
  --output-dir "${ERA_OUTPUT_DIR:-$SCRIPT_DIR/INDOWORDNET_1M_OUTPUT}"
