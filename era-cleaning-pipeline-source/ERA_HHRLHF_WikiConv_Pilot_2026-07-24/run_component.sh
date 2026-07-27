#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "Usage: bash run_component.sh COMPONENT COMPONENT_SOURCE_DIRECTORY" >&2
  exit 2
fi

component="$1"
source_dir="$2"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
output_dir="${script_dir}/outputs/${component}"
mkdir -p "$output_dir"

node "$script_dir/era-multilingual-path-adapter.mjs" \
  --input "$source_dir/SAMPLE_10K.parquet" \
  --component "$component" \
  --output "$output_dir/pilot-materialized.jsonl" \
  --structural-holdout "$output_dir/structural-holdout.jsonl" \
  --report "$output_dir/adapter-report.json" \
  --source-manifest "$source_dir/SOURCE_MANIFEST.json" \
  --sample-manifest "$source_dir/SAMPLE_MANIFEST.json"

node "$script_dir/era-auto-route.mjs" \
  --input "$output_dir/pilot-materialized.jsonl" \
  --component "$component" \
  --retained-output "$output_dir/pilot-retained.jsonl" \
  --holdout-output "$output_dir/automatic-holdout.jsonl" \
  --candidate-output "$output_dir/near-duplicate-candidates.jsonl" \
  --language-validation-output "$output_dir/language-validation-200.jsonl" \
  --privacy-worksheet-output "$output_dir/privacy-calibration-worksheet.jsonl" \
  --report "$output_dir/routing-report.json"

# Privacy policy v2 (2026-07-26): uniform PII scrubbing of the retained stream.
# Scrub in-place -> pilot-retained-scrubbed.jsonl, reversible audit -> pii-scrub-audit.jsonl,
# accounting -> pii-scrub-report.json. The pre-scrub pilot-retained.jsonl is kept
# so reconstruction (original = scrubbed + audit) can be verified byte-for-byte.
node "$script_dir/era-pii-scrub.mjs" scrub \
  --input "$output_dir/pilot-retained.jsonl" \
  --retained-output "$output_dir/pilot-retained-scrubbed.jsonl" \
  --audit-output "$output_dir/pii-scrub-audit.jsonl" \
  --component "$component" > "$output_dir/pii-scrub-report.json"

# Gate: reconstruction must be byte-identical (no source data destroyed).
node "$script_dir/era-pii-scrub.mjs" verify \
  --input "$output_dir/pilot-retained.jsonl" \
  --retained-output "$output_dir/pilot-retained-scrubbed.jsonl" \
  --audit-output "$output_dir/pii-scrub-audit.jsonl" > "$output_dir/pii-scrub-verify.json"

echo "PILOT COMPLETE: $component"
