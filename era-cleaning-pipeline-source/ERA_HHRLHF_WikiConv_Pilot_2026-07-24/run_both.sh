#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: bash run_both.sh RESTORED_INSPECTION_ROOT" >&2
  exit 2
fi

root="$1"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

bash "$script_dir/run_component.sh" \
  HHRLHF_T "$root/era-pending-indicalign/HHRLHF_T" &
pid_hhrlhf=$!

bash "$script_dir/run_component.sh" \
  Wiki_Conv "$root/era-pending-indicalign/Wiki_Conv" &
pid_wikiconv=$!

wait "$pid_hhrlhf"
wait "$pid_wikiconv"

echo "BOTH VALID PILOTS COMPLETE"
