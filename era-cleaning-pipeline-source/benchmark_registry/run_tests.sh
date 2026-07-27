#!/usr/bin/env bash
# Run the full benchmark-registry test suite: Python unittest (generates the
# cross-language parity vectors) then the Node parity + live-scan tests.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
PY="$ROOT/.venv-indowordnet/bin/python"

echo "== Python unit tests (also writes tests/parity_vectors.json) =="
"$PY" -m unittest discover -s "$HERE/tests" -p "test_*.py" -v

echo ""
echo "== Node parity + live-registry scan tests =="
node --test "$HERE/tests/test_node_parity.mjs"

echo ""
echo "== Registry verification =="
"$PY" "$HERE/verify_registry.py"
