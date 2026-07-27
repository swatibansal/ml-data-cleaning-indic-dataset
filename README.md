# ML Data Cleaning — Indic SFT Datasets (ERA Phase 1)

An eight-strategy, evidence-first data-cleaning pipeline for supervised fine-tuning (SFT)
datasets from [`ai4bharat/indic-align`](https://huggingface.co/datasets/ai4bharat/indic-align),
built as part of an India-first 40B LLM data-preparation plan (ERA V5 course project).

Eleven dataset components were processed end to end. Every number the pipeline produces is
reconciled (source rows = retained + held out, zero gaps), reversible (nothing is ever
deleted — records move to named holdout streams with full provenance), and reproducible
(a 1,000,000-row run, interrupted and resumed mid-flight, is proven byte-identical to an
uninterrupted from-scratch replay).

**📊 Interactive evidence report:** open [`index.html`](index.html) directly in a browser
(it is fully self-contained), or serve it via GitHub Pages.

---

## Headline results

| | |
|---|---|
| Components cleaned | 11 (Anudesh, Dolly_T, OpenAssistant_T, Wiki_Chat, Toxic_Matrix, IndoWordNet 10K + 1M, HHRLHF_T, Wiki_Conv, Indic_ShareLlama, WikiHow) |
| Scale rehearsal | 1M rows, 10 restartable 100K chunks, interrupt/resume proven **byte-identical** to a from-scratch replay |
| Contamination finding | **202,227 conversations (~20%)** of the IndoWordNet 1M slice near-verbatim overlap IndicMMLU-Pro items → reversible benchmark holdout |
| PII handling | Scrub-and-retain: findings replaced in place with numbered typed placeholders (`[EMAIL_1]`, `[PHONE_CANDIDATE_2]`); originals recoverable byte-exactly from a reversible audit stream |
| Token accounting | 85.1M retained tokens measured with BrahmicTokenizer-131K on the five 2026-07 components ([`TOKEN_ESTIMATES.json`](TOKEN_ESTIMATES.json)) |
| Reconciliation | 0 gaps across all components |

## The eight strategies

1. **Schema-first structural validation** — validate rows, IDs, interactions and turn structure before interpreting any text.
2. **Unicode & format normalization** — NFC only; NFKC and blind whitespace/joiner stripping are rejected (ZWNJ/ZWJ carry meaning in Brahmic scripts).
3. **Language & script metadata** — cautious detector signals; uncertain text stays `und`, never guessed.
4. **Quality / repetition gate** — strong failures held out, weak signals annotated for review; valid short answers and lexical templates are explicitly protected.
5. **Deduplication** — exact duplicates (normalized language + prompt + response, earliest copy canonical); near duplicates held out only when **both** gates fire (char 5-gram Jaccard ≥ 0.95 **and** SimHash64 Hamming ≤ 3); 0.85–0.95 is annotate-only.
6. **PII & secrets** — typed detectors with checksums and context; uniform scrub-and-retain with repeated-reference-consistent numbered placeholders; reversible audit stream.
7. **Benchmark decontamination** — pinned, hashed registry of 5 eval suites (MILU, IndicMMLU-Pro, GSM8K, MATH, IndicGenBench-flores); transliteration-aware two-tier policy: canary hit or ≥ 3 distinct word 8-grams → reversible holdout; 1–2 grams → retain + annotate.
8. **Provenance & manifests** — every input, rule, code file and output is hashed so results can be reproduced and reconciled.

**Governing rule:** every removal is a routing decision, not a deletion. Held-out records
keep full provenance and can be restored mechanically.

## Repository layout

```
├── index.html                              # Self-contained single-page evidence report
├── TOKEN_ESTIMATES.json                    # BrahmicTokenizer-131K token counts (measured, per component/language)
├── ERA_IndoWordNet_1M_Evidence/            # Baseline 1M run: chunk reports, data card, replay verification, hashes
├── ERA_IndoWordNet_1M_Decontam_Evidence/   # Decontaminated re-run: benchmark-holdout accounting, hashes, replay proof
└── era-cleaning-pipeline-source/
    ├── CLAUDE.md                           # Frozen decisions record — the pipeline's authoritative policy file
    ├── ERA_IndoWordNet_1M_Rehearsal_2026-07-24/
    │   ├── indowordnet_1m.py               # Python scale harness: streaming, chunk checkpointing, global
    │   │                                   #   SQLite-LSH dedup, benchmark scan, deterministic gzip output
    │   ├── run_1m.sh / resume_1m.sh        # Full run & lossless resume
    │   ├── verify_replay.sh                # Byte-identity check vs recorded hashes
    │   └── tests/                          # Self-tests on synthetic fixtures (no dataset needed)
    ├── ERA_HHRLHF_WikiConv_Pilot_2026-07-24/
    │   ├── era-multilingual-path-adapter.mjs   # Dataset-specific materialization
    │   ├── era-auto-route.mjs                  # Routing: dedup, quality, benchmark, holdout categories
    │   ├── era-pii-scrub.mjs                   # S6-R5 numbered-placeholder scrubber + reconstruction verify
    │   ├── stage5/6/7 audits + *.test.mjs      # Node test suite (node --test)
    │   └── run_component.sh / run_both.sh
    ├── benchmark_registry/
    │   ├── build_registry.py / verify_registry.py   # Build & hash-verify the protected registry
    │   ├── lib/era_decontam.py, era_lookup.{py,mjs}  # Python & Node lookups with enforced hash parity
    │   └── tests/                                    # Parity vectors + unit tests
    ├── tools/
    │   ├── token_estimates.py              # Measured counts over retained streams
    │   ├── legacy_token_estimates.py       # Source-sample estimates for pre-tokenizer components
    │   └── install_tokenizers.sh
    ├── regenerate_blocked_samples.py       # Deterministic sample regeneration with valid manifests
    └── validate_regenerated_samples.py
```

## Running it

No datasets ship in this repo (see *Data & privacy* below). The self-tests run on synthetic
fixtures and need nothing external:

```bash
# Python scale harness — self-tests (synthetic fixtures)
cd era-cleaning-pipeline-source/ERA_IndoWordNet_1M_Rehearsal_2026-07-24
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
bash run_tests.sh

# Node pilot harness — full test suite
cd ../ERA_HHRLHF_WikiConv_Pilot_2026-07-24
node --test .

# Benchmark registry — build (downloads pinned benchmark revisions), verify, test
cd ../benchmark_registry
python3 build_registry.py
python3 verify_registry.py
bash run_tests.sh
```

The full 1M rehearsal (`run_1m.sh`) streams the pinned source revision
(`032b6a9070e7f85f1a38e0506419f4590a20455a`) from Hugging Face, processes ten restartable
100K chunks, and can be interrupted at any point; `resume_1m.sh` continues losslessly and
`verify_replay.sh` proves the result byte-identical.

## Evidence packs

`ERA_IndoWordNet_1M_Evidence/` and `ERA_IndoWordNet_1M_Decontam_Evidence/` are the
machine-checkable proof of the two 1M runs: per-chunk accounting reports, the data card,
SHA-256 manifests of every output stream, and the replay-verification records. The
decontaminated run's streams differ from the baseline by exactly the enumerated
202,227 tier-1 records moving retained → benchmark holdout — nothing else.

## Data & privacy

- **No dataset rows, holdout streams, or PII audit streams are published here.** Those
  streams carry raw conversations and original PII spans by design (that is what makes
  scrubbing reversible), so they stay off public repos. Reports contain only counts,
  hashes and placeholders — never raw candidate values or benchmark text.
- Sources are pinned by revision and SHA-256 manifest, so every artifact is regenerable
  from Hugging Face plus this code.

## Honest scope

This is an educational pilot, not a production release. The pipeline is proven
*conservative, reversible and reproducible* — it has **not** been proven that every
retained example is correct, safe, unbiased or copyright-clear. Human multilingual
review was waived by decision, so the project closes at automated-rehearsal grade and
`production_release_eligible` remains `false`. That distinction is part of the evidence.

## License

[Apache-2.0](LICENSE)
