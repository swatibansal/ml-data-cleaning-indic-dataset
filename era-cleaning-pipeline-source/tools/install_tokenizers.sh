#!/usr/bin/env bash
# User-approved 2026-07-26: install the token-counting dependency into the
# project venv only (never global). Used for the named-tokenizer estimate stage.
set -euo pipefail
VENV_PY="/Users/bansalswati/ERA-phase1/.venv-indowordnet/bin/python"
"$VENV_PY" -m pip install --quiet "tokenizers>=0.20,<1"
"$VENV_PY" -c "import tokenizers; print('tokenizers', tokenizers.__version__, 'installed in', __import__('sys').prefix)"
