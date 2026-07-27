# ERA Phase 1 — Data cleaning pipeline

Context file for Claude Code sessions in `~/ERA-phase1`. Read fully before touching any pipeline code or data.

## What this project is

Data cleaning pipeline for SFT/preference datasets feeding the India-first 40B LLM plan (ERA V5 course assignment). Sources are configurations of `ai4bharat/indic-align` on HuggingFace. The pipeline follows the ERA V5 8-strategy model: extract, normalize, language ID, quality filter, dedup, PII, decontamination, manifest/provenance.

## Frozen decisions — do NOT change without explicit user approval

- **Pinned source revision:** `032b6a9070e7f85f1a38e0506419f4590a20455a` (all components, all runs)
- **Source selection:** deterministic source-order prefix at the pinned revision
- **Exact duplicate key:** normalized language + prompt + response; earliest deterministic input record is canonical
- **Near-duplicate automatic holdout requires BOTH:** character 5-gram Jaccard >= 0.95 AND SimHash64 Hamming distance <= 3
- **Jaccard 0.85 to <0.95:** retain and annotate as candidate (never auto-holdout)
- **Dedup comparisons:** whole conversation, within the same language column only
- **ZWNJ and ZWJ are preserved** — never strip zero-width characters (Brahmic scripts encode half-characters with them)
- **Valid short answers and repeated lexical templates remain valid** — do not add length/repetition heuristics that reject them
- **No source row is ever physically deleted; all holdouts are reversible**
- **Alternative multilingual paths are never merged**
- **Unmatched final user message:** suffix goes to reversible structural holdout; preceding complete exchanges remain eligible
- **Determinism is a hard requirement:** a resumed run must produce byte-identical outputs to an uninterrupted run. Any code change must preserve this and pass the replay verification.
- **Refusal/safety-language signals do not authorize removal.** Privacy and security detections are candidates only; no raw candidate values are stored in reports.

### Approved 2026-07-25 (user decisions)

- ~~**Privacy candidates route to reversible `privacy_holdout`** (applies to Wiki_Conv's 82 and HHRLHF_T's 2); held-out sets double as detector-precision calibration samples for human review.~~ **SUPERSEDED 2026-07-26 by privacy policy v2 (see below).**

### Approved 2026-07-26 — privacy policy v2 (SUPERSEDES the 2026-07-25 privacy-holdout decision)

- **Uniform PII scrubbing (scrub-and-retain).** Privacy is NO LONGER a holdout category. Every privacy detector finding in every retained unit is replaced in-place by a typed numbered placeholder and the unit is RETAINED. `privacy_holdouts` is always 0 for the four Node pilot components.
- **Reversibility (hard requirement, no source data destroyed):** each scrubbed unit gets an audit record in `pii-scrub-audit.jsonl` carrying original spans (offsets + types + raw values — raw values allowed in this DATA stream, exactly as holdout files carry raw conversations, but NEVER in reports). `original = scrubbed + audit` reconstructs byte-identically; verified by `era-pii-scrub.mjs verify` (a run gate) and the reconstruction test.
- **Placeholder vocabulary (canonical, in `era-pii-scrub.mjs`):** typed NUMBERED tokens `[<TYPE>_<n>]` — e.g. `[EMAIL_1]`, `[PHONE_CANDIDATE_2]`, `[IPV4_ADDRESS_1]`, `[PAYMENT_CARD_CANDIDATE_1]`, `[TWELVE_DIGIT_ID_CANDIDATE_1]`, `[INDIAN_MOBILE_CANDIDATE_1]`, `[INDIAN_BANK_ACCOUNT_CONTEXT_CANDIDATE_1]` — derived uniformly from the detector type name. Numbering implements S6-R5 repeated-reference consistency: within a conversation the same raw value keeps the same numbered token; distinct values increment per type in first-occurrence order (indices reset per conversation). Required call-out (documented verbatim in every routing report): "Placeholder vocabulary follows the Stage 6 policy (S6-R5) of the previously cleaned datasets (Anudesh/Dolly_T/OpenAssistant_T/Wiki_Chat, ERA_Project_Complete_Documentation_2026-07-24): typed replacements with repeated-reference consistency within a conversation. Three detector types new in this phase are named following the same convention." (Convention recovered from `~/Personal/Technical/AI ERA/ERA_Project_Complete_Documentation_2026-07-24.zip`.) Placeholders are plain text, not reserved tokenizer tokens; if later promoted to atomic special tokens, cap or collapse the index range.
- **Determinism / overlap resolution:** same stage-6 detectors as the privacy stage (findings == scrubbed spans); overlaps resolved longest-match-wins then earliest-start; only matched spans change (ZWNJ/ZWJ and all surrounding bytes byte-for-byte). Two full runs are byte-identical.
- **Accounting:** `findings_scrubbed` = raw detector findings (reconciles with the routing report's `total_detector_findings` over the retained stream); `spans_replaced` = physical placeholders after overlap resolution (<= findings when two detectors hit the same bytes). Non-retained holdout streams are left UNSCRUBBED (they are not exported for training).
- **Wiki_Conv's 82 privacy candidates:** resolved — scrubbed-and-retained (priority-queue item 5 closed).
- **Benchmark contamination two-tier policy (v1):** canary match OR >= 3 distinct matching word 8-grams (raw or transliterated) per conversation → new reversible `benchmark_holdout` category; 1-2 matching grams → retain + `benchmark_overlap_candidate` annotation.
- **BharatEval skipped** — remains UNAVAILABLE in the registry manifest; installable later via `build_registry.py --bharateval-repo`.
- **Decontamination integration order:** Node pilot code first; the IndoWordNet Python hook only after the 1M rehearsal + replay verification complete.
- **Human language review: WAIVED (2026-07-26).** The 200-row samples will not be labeled. Consequence: `production_release_eligible` stays false permanently; the project closes at automated-rehearsal grade.
- **Tokenizer: BrahmicTokenizer-131K approved and installed (2026-07-26).** `theschoolofai/BrahmicTokenizer-131K` @ revision `93df154cbc9dbf038a222c010d9b43906a8a72c3`; `tokenizers` installed into the venv with user approval (`tools/install_tokenizers.sh`); estimator at `tools/token_estimates.py`.
- **Performance fixes approved** (both result-identical, self-tests passed, replay verification still gates): (1) `idx_records_canonical` index in `setup_database()`; (2) `candidate_rows()` OR-of-bands rewritten as UNION-per-band so each lookup uses the full `(language, band_no, band_value)` index — the OR form scanned all band rows per language per record (measured 139.67→0.81 ms/call, equivalence verified on live DB: 0 mismatches/25 fingerprints; chunk time 248 min → ~4 min).

## Component status (as of 2026-07-24)

| Component | Status | Notes |
|---|---|---|
| HHRLHF_T | PILOT_COMPLETE | 2026-07-26 privacy policy v2 (scrub-and-retain): 10,000 units = 9,871 retained + 129 holdouts (124 exact, 2 near, 3 benchmark, 0 privacy) + 55 tier-2 benchmark annotations. 2 units scrubbed / 2 findings (2 spans). Decontamination RUN. Two full runs byte-identical (12/12 files); reconstruction byte-identical; 0 residual PII in scrubbed retained. Not production-eligible. |
| Wiki_Conv | PILOT_COMPLETE | 2026-07-26 privacy policy v2 (scrub-and-retain): 10,000 units = 9,930 retained + 70 holdouts (70 exact, 0 privacy) + 4 tier-2 benchmark annotations. 51 units scrubbed / 82 findings (78 spans; 4 overlapping detector pairs collapsed). Decontamination RUN. Two full runs byte-identical (12/12); reconstruction byte-identical; 0 residual PII. Not production-eligible. |
| IndoWordNet | REHEARSAL PASSED | 2026-07-25 baseline: 1M rows, 974,838 retained + 25,162 holdouts (8,692 exact, 16,470 near), recon 0, from-scratch replay byte-identical (30/30). Evidence: `ERA_IndoWordNet_1M_Evidence.zip`. **2026-07-26 benchmark_decontamination integrated + full re-run (`INDOWORDNET_1M_DECONTAM`, PASSED, recon 0, verify PASSED): 772,611 retained + 202,227 benchmark_holdout (tier-1) + 8,692 exact + 16,470 near = 1,000,000. Tier-1 per-benchmark: IndicMMLU-Pro 202,227, MILU 2,352 (2,352 units match both). Tier-2 retained candidates: 60,014 distinct (IndicMMLU-Pro 60,014 / MILU 21,155 per-benchmark), report-only. Decontamination RUN. Exact/near holdout sets byte-identical to baseline; every stream byte-diff vs `INDOWORDNET_1M_OUTPUT` = exactly the 202,227 tier-1 records moving retained→holdout + 13,494 near-dup-candidate annotations dropped for those now-held-out rows (enumerated, 0 unexplained).** Full config is 96.8M rows — post-fix throughput ~4 min/100K early chunks (slows with DB growth on later chunks); growth re-measurement still required. |
| Indic_ShareLlama | PILOT_COMPLETE | 2026-07-26 privacy policy v2 (scrub-and-retain): 9,999 pilot units (1 source row had no complete exchange) = 9,973 retained + 26 holdouts (9 exact, 2 near, 15 benchmark, 0 privacy) + 122 tier-2 benchmark annotations + 1 near-dup candidate. 236 units scrubbed / 999 findings (940 spans). Two full runs byte-identical (12/12); reconstruction byte-identical; 0 residual PII. Not production-eligible. |
| WikiHow | PILOT_COMPLETE | 2026-07-26 privacy policy v2 (scrub-and-retain): 10,000 pilot units = 9,981 retained + 19 holdouts (0 exact, 0 near, 19 benchmark, 0 privacy) + 111 tier-2 benchmark annotations. 106 units scrubbed / 269 findings (249 spans). Two full runs byte-identical (12/12); reconstruction byte-identical; 0 residual PII. Not production-eligible. |

**Benchmark registry installed 2026-07-25** at `benchmark_registry/` (MILU, IndicMMLU-Pro, GSM8K, MATH, IndicGenBench-flores at pinned revisions; BharatEval skipped). Python 16/16 + Node 7/7 tests pass; Python/Node hash parity enforced. See `benchmark_registry/INTEGRATION.md`.

## Pipeline stage status (all components)

RUN: source integrity, structural validation, unicode normalization, quality/repetition gate, language metadata validation, global exact dedup, global near dedup, privacy and secrets, security candidates, checkpoint/restart.
**Named-tokenizer estimate: RUN** (2026-07-26) for all five components — see `era_token_estimates/TOKEN_ESTIMATES.json` (BrahmicTokenizer-131K @ 93df154c): IndoWordNet_1M 67.2M, WikiHow 18.7M, Indic_ShareLlama 8.8M, HHRLHF_T 2.2M, Wiki_Conv 0.5M tokens (~97.5M total retained). **Human language review: waived** (see approved decisions).
**Benchmark decontamination:** RUN for all five components (registry installed 2026-07-25, two-tier policy v1). IndoWordNet Python hook applied 2026-07-26 in `indowordnet_1m.py` (`benchmark_scan()` at the retained branch, order exact>near>repetition>benchmark>privacy; held-out records still anchor dedup so frozen dedup decisions are unchanged); full re-run + verify + stream reconciliation vs baseline all passed. Tier-2 overlaps are report-only aggregate counts (never embedded in streams) so a tier-1-free run stays byte-identical to the pre-decontamination run.

## Key commands (IndoWordNet rehearsal)

```bash
cd ~/ERA-phase1
source .venv-indowordnet/bin/activate

# Smoke test: one chunk, clean stop, then resume
ERA_SKIP_INSTALL=1 bash ERA_IndoWordNet_1M_Rehearsal_2026-07-24/run_1m.sh --max-chunks 1
bash ERA_IndoWordNet_1M_Rehearsal_2026-07-24/resume_1m.sh

# Full run (hours; needs >=10 GB free; 10 restartable chunks of 100K rows)
bash ERA_IndoWordNet_1M_Rehearsal_2026-07-24/run_1m.sh

# Progress
python -m json.tool ERA_IndoWordNet_1M_Rehearsal_2026-07-24/INDOWORDNET_1M_OUTPUT/checkpoint.json

# After "REHEARSAL PASSED"
bash ERA_IndoWordNet_1M_Rehearsal_2026-07-24/verify_replay.sh
bash ERA_IndoWordNet_1M_Rehearsal_2026-07-24/package_evidence.sh
# Deliverable: ERA_IndoWordNet_1M_Evidence.zip (excludes retained/holdout streams and SQLite DB)

# Package self-tests (synthetic fixtures)
bash ERA_IndoWordNet_1M_Rehearsal_2026-07-24/run_tests.sh
```

HHRLHF_T / Wiki_Conv pilot code lives in `ERA_HHRLHF_WikiConv_Pilot_2026-07-24/` (Node .mjs scripts: `era-auto-route.mjs`, `era-multilingual-path-adapter.mjs`, stage 5/6/7 audits, each with tests; outputs under `outputs/<component>/`).

## Priority queue

1. IndoWordNet smoke test (1 chunk + resume), then full 1M rehearsal, verify replay, package evidence.
2. Build and install the protected benchmark registry so `benchmark_decontamination` flips to RUN for all components. Seed from the 40B report eval suite: MILU, IndicGenBench, IndicMMLU-Pro, BharatEval item bank, GSM8K, MATH. Use n-gram overlap + canary checks; transliteration-aware matching for Indic.
3. Regenerate Indic_ShareLlama and WikiHow samples with valid manifest SHA-256 and Parquet footers; re-validate before any processing.
4. Get the named tokenizer (BrahmicTokenizer-131K per the 40B report) installed so token estimates flip to RUN.
5. ~~User decision needed: policy for Wiki_Conv's 82 privacy candidates.~~ CLOSED 2026-07-26: privacy policy v2 (uniform scrubbing) applied to all four Node pilot components; the 82 are scrubbed-and-retained.
6. Label the 200-row language-validation samples (human review) before any production-eligibility claim.

## Guardrails for Claude Code

- Run the relevant test suite after every code change; never commit a change that breaks byte-identical resume behavior.
- Report accounting must always reconcile: source rows = materialized units = retained + holdouts.
- Every stage in any new report must be labeled RUN / NOT RUN / NOT APPLICABLE / BLOCKED — never silently skip.
- Holdout categories: exact_duplicate, near_duplicate, structural, repetition, security, benchmark. Keep them separate and reversible. **Privacy is NOT a holdout category (privacy policy v2, 2026-07-26): PII is scrubbed-and-retained with a reversible audit — see the approved-decisions section.** (Note: `era-corrective-audit.mjs` and the IndoWordNet Python pipeline still use annotation-only privacy handling; only the four Node pilot components scrub.)
- "Pilot" and "rehearsal" outputs are never production releases; `production_release_eligible` stays false until decontamination, tokenizer estimates, and human review are RUN.

## Background docs (in the Personal folder / earlier session)

- `India-First-40B-LLM-Training-Report.docx` — the 40B data/tokenizer strategy this pipeline serves
- `ERA-V5-Session-Summary.md` — course session summary (fertility, data mix, cleaning asks)
- ERA V5 2026-07-18 transcript — 8 cleaning strategies with survival curve 100→92→88→68→44→43%
