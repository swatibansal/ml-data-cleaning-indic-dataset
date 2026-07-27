# ERA Phase 1 — Protected Benchmark Registry: integration notes

This registry lets the `benchmark_decontamination` stage flip from **NOT RUN** to
**RUN** for every pipeline component. It stores only hashes and short previews —
no raw benchmark text — per the CLAUDE.md privacy guardrail. Detections are
**candidates / annotations only**; benchmark-contamination holdout is a **user
policy decision** (like the existing privacy/security candidate handling).

## Layout

```
benchmark_registry/
  manifest.json                 versioned manifest (format v1): sources, pinned
                                revisions, counts, per-shard SHA-256, hashing +
                                normalization + transliteration scheme, build ts
  shards/<benchmark>.json        protected n-gram hashes + 50 canaries each
  lib/era_decontam.py            stdlib core: normalize, n-grams, translit, hash
  lib/era_lookup.py              Python scanner (loads + verifies + scans)
  lib/era_lookup.mjs             Node scanner (byte-compatible with the Python one)
  build_registry.py             deterministic builder
  verify_registry.py            loads registry, verifies SHA-256s, prints counts
  run_tests.sh                  full test suite (Python unittest + Node --test)
  tests/                        synthetic-fixture tests + parity vectors
```

## What is installed

| Benchmark | Source repo | Pinned revision | Items | Word 8-grams | Char 5-grams | Translit grams | Canaries |
|---|---|---|---|---|---|---|---|
| MILU | ai4bharat/MILU | 946c423e72cd… | 79,608 | 1,078,024 | 2,140,701 | 366,183 w / 416,154 c | 50 |
| IndicMMLU-Pro | LinguaLift/IndicMMLU-Pro | 9cadffd98bb7… | 108,288 | 5,664,134 | 5,038,979 | 1,349,055 w / 496,514 c | 50 |
| GSM8K | openai/gsm8k (main) | 740312add88f… | 1,319 | 111,537 | 0 | 0 | 50 |
| MATH | EleutherAI/hendrycks_math | 21a5633873b6… | 5,000 | 484,740 | 0 | 0 | 50 |
| IndicGenBench | google/IndicGenBench_flores_in | f8650438298d… | 58,696 | 427,564 | 1,117,350 | 245,332 w / 252,065 c | 50 |
| **BharatEval** | — | — | **UNAVAILABLE** | — | — | — | — |

Item counts are the full eval/test splits (no silent capping — the item cap is
250,000, well above the largest split; `counts.capped` is `false` for all).
The exact pinned commit hashes are recorded per benchmark in `manifest.json`.

### Notes on sources

- **MATH**: `hendrycks/competition_math` is gated; `EleutherAI/hendrycks_math`
  was used (7 subject configs, 5,000 test items total).
- **IndicGenBench**: the `google/IndicGenBench_*` repos are custom-JSON (each
  file has an embedded canary GUID + an `examples` list), not standard HF
  datasets, so a dedicated raw-JSON loader is used. Only `IndicGenBench_flores_in`
  was materialized in this build; the other constituent repos
  (`_crosssum_in`, `_xorqa_in`, `_xquad_in`) are listed as candidates and can be
  added by extending `text_fields`/candidates and rebuilding.
- **IndicMMLU-Pro**: `LinguaLift/IndicMMLU-Pro` (9 language configs).
- **BharatEval**: no public HF repo was found. It is **NOT fabricated** — it is
  marked `UNAVAILABLE` in the manifest. To install it, supply a repo id:
  `build_registry.py --bharateval-repo <owner/repo>` (or set
  `ERA_BHARATEVAL_REPO`). Until then, decontamination coverage excludes it and
  that must be stated in any report.

## Query contract (how a pipeline uses the registry)

Both scanners implement the same contract:

```
input text
  -> normalize_for_match  (NFC -> casefold -> strip invisible/bidi noise,
                           PRESERVING ZWNJ U+200C and ZWJ U+200D -> collapse ws)
  -> word 8-grams (always) + char 5-grams (Indic only) + Devanagari romanized
     variants (Indic only)
  -> SHA-256-truncated (64-bit) hash of each gram
  -> set-intersection against each benchmark's hash set + canary exact-hash check
  -> candidate annotation: { is_candidate, matched_benchmarks[], detail[] }
```

Thresholds (defaults): a candidate is flagged when **any one** word 8-gram
overlaps, or **>= 10** char 5-grams overlap, or a canary hashes exactly. These
are tunable via constructor args. Scan the **whole conversation** (matching the
pipeline's dedup granularity) via `scan_conversation([...turn texts...])`.

**The scanner never deletes, never auto-holds-out.** It returns counts and which
benchmarks matched. Routing a candidate to a `benchmark_holdout` category is a
separate, reversible, user-approved step — identical in spirit to the existing
privacy/security candidate flow.

### Python

```python
import sys; sys.path.insert(0, "benchmark_registry/lib")
from era_lookup import ContaminationScanner
scanner = ContaminationScanner("benchmark_registry")   # verifies shard SHA-256s
ann = scanner.scan_conversation([prompt, response])
# ann == {"is_candidate": bool, "matched_benchmarks": [...], "detail": [...]}
```

### Node

```js
import { ContaminationScanner } from "./benchmark_registry/lib/era_lookup.mjs";
const scanner = new ContaminationScanner("benchmark_registry"); // verifies SHA-256s
const ann = scanner.scanConversation([prompt, response]);
```

The Python and Node libraries emit **byte-identical gram hashes** (SHA-256
truncated to 16 hex chars) and identical normalization/transliteration; this is
enforced by `tests/test_node_parity.mjs` against Python-generated
`tests/parity_vectors.json`.

## Transliteration-aware matching (Indic)

For Indic-script text, each n-gram is emitted twice: once in native script and
once from a deterministic, stdlib-only Devanagari→Latin romanization
(`deterministic-devanagari-iso15919-lite-v1`, documented in the manifest). So a
Devanagari benchmark item AND a Latin transliteration of it both match. This is
verified live in the Node test (a verbatim MILU Hindi item and its romanization
both flag MILU). Non-Devanagari Brahmic scripts are hashed in native form (char
5-grams) but not romanized yet — a documented future extension.

## Determinism

- Shards contain no timestamps; all lists are sorted and de-duplicated.
- Independent full rebuilds produce byte-identical shard files (verified: the
  five shard SHA-256s were stable across two independent builds).
- Only `manifest.json` carries a `build_timestamp_utc` field (outside any hashed
  shard content), so the manifest file hash changes per build but shard hashes
  do not.

## Verification

```bash
.venv-indowordnet/bin/python benchmark_registry/verify_registry.py   # exit 0 = OK
bash benchmark_registry/run_tests.sh                                 # full suite
```

`verify_registry.py` recomputes every INSTALLED shard's SHA-256 and checks it
against the manifest; it fails non-zero on any mismatch.

---

## Proposed changes to flip `benchmark_decontamination` to RUN

> These are **proposed changes requiring approval + a fresh test run** (they add
> a stage to frozen pipeline code). They are NOT applied. Each must pass the
> component's existing test suite and, for IndoWordNet, the byte-identical replay
> verification, before merge. Because the scanner is deterministic and additive
> (annotation only), it does not change routing/holdout decisions and so should
> not affect replay byte-equality of the retained/holdout streams — but that must
> be confirmed by `verify_replay.sh`, not assumed.

### A. IndoWordNet Python pipeline (`ERA_IndoWordNet_1M_Rehearsal_2026-07-24/indowordnet_1m.py`)

1. At module import, construct a scanner once (guarded so absence of the registry
   degrades gracefully to the current NOT RUN state):

   ```python
   # near the other imports / module constants
   import sys as _sys
   _REG = Path(__file__).resolve().parents[1] / "benchmark_registry"
   _sys.path.insert(0, str(_REG / "lib"))
   try:
       from era_lookup import ContaminationScanner
       BENCH_SCANNER = ContaminationScanner(str(_REG)) if (_REG / "manifest.json").exists() else None
   except Exception:
       BENCH_SCANNER = None
   ```

2. Where each record's cleaned prompt/response is available, add an **annotation
   only** call (no disposition change), accumulating a candidate count and a
   per-benchmark tally into the report — mirroring how privacy/security
   candidates are counted. Store no raw text.

3. Replace the two hard-coded lines in the `strategy_status` / `release_blockers`
   block (currently at lines ~804 and ~810):

   ```python
   # before
   "benchmark_decontamination": "NOT RUN",
   ...
   ["benchmark registry not installed"]

   # after
   "benchmark_decontamination": "RUN" if BENCH_SCANNER else "NOT RUN",
   ...
   ([] if BENCH_SCANNER else ["benchmark registry not installed"])
   ```

   Add the candidate counts + the registry's `registry_format_version` and the
   set of `matched_benchmarks` seen into the summary (counts only, no raw values).
   `production_release_eligible` stays governed by the existing blockers plus the
   still-open tokenizer estimate and human review.

### B. Node pilot pipeline (`ERA_HHRLHF_WikiConv_Pilot_2026-07-24/era-auto-route.mjs`)

1. Import the Node scanner and construct it once:

   ```js
   import { ContaminationScanner } from "../benchmark_registry/lib/era_lookup.mjs";
   const REG = new URL("../benchmark_registry/", import.meta.url).pathname;
   const benchScanner = fs.existsSync(path.join(REG, "manifest.json"))
     ? new ContaminationScanner(REG)
     : null;
   ```

2. For each conversation, call `benchScanner?.scanConversation(row.interactions.flat())`
   and accumulate candidate counts per benchmark (annotation only — do not route
   to holdout without a user policy decision).

3. Replace the `decontamination` stanza (currently at
   `era-auto-route.mjs:362-366`):

   ```js
   // before
   decontamination: {
     status: "NOT RUN",
     reason: "The versioned benchmark registry contains no materialized protected items.",
   },

   // after
   decontamination: benchScanner
     ? {
         status: "RUN",
         action: "CANDIDATE_COUNTS_ONLY; benchmark-contamination holdout is a user policy decision",
         registry_format_version: benchScanner.manifest.registry_format_version,
         benchmarks: benchScanner.installedBenchmarks(),
         counts: benchmarkCandidateCounts, // { <benchmark>: <#candidates> }
       }
     : {
         status: "NOT RUN",
         reason: "The versioned benchmark registry contains no materialized protected items.",
       },
   ```

   The corrective-audit script (`era-corrective-audit.mjs:145`) can mirror the
   same pattern if it re-emits a decontamination stanza.

After applying either hook, re-run that component's test suite (and
`verify_replay.sh` for IndoWordNet) and confirm the accounting still reconciles
(`source rows = materialized units = retained + holdouts`) — the decontamination
annotation does not move rows between retained and holdout.
