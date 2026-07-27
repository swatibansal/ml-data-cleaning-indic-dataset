# ERA IndoWordNet 1M Rehearsal — Data Card

## Result

- Status: **PASSED**
- Source rows: **1,000,000**
- Materialized units: **1,000,000**
- Retained units: **772,611**
- Holdouts: **227,389**
- Reconciliation difference: **0**
- Restartable chunks: **10 × up to 100,000**
- Processing throughput: **445.16 rows/second**

## Frozen source

- Repository: `ai4bharat/indic-align`
- Revision: `032b6a9070e7f85f1a38e0506419f4590a20455a`
- Component: `IndoWordNet`
- Selection: deterministic pinned source-order prefix
- Declared full component: 96,843,950 rows across 10 source shards

## Applied policy

NFC normalization, supported HTML unescape, U+FFFD/control/invisible-direction
removal, and whitespace normalization were applied while preserving ZWNJ/ZWJ.
Valid short lexical answers and repeated templates with different lexical
content remain valid. Exact duplicates use normalized language + prompt +
response. Near-duplicate automatic routing requires character 5-gram Jaccard
>= 0.95 and SimHash64 Hamming distance <= 3; 0.85 to below 0.95 is annotation
only. The earliest deterministic record remains canonical.

Benchmark decontamination (two-tier policy v1, user-approved 2026-07-25):
whole-conversation scan against the protected registry (format v1).
A canary exact match or >= 3 distinct matching word
8-grams (native or transliterated) routes the unit to the reversible
`benchmark_holdout` category; 1..2
matching word 8-grams retain the unit and are recorded as
benchmark_overlap_candidates in the report (aggregate counts only, no raw matched
text). The benchmark check runs after exact/near dedup so a held-out record still
anchors later dedup identically to the pre-decontamination pipeline.

## Benchmark decontamination result

- Status: **RUN**
- Installed benchmarks: GSM8K, IndicGenBench, IndicMMLU-Pro, MATH, MILU
- Tier-1 holdout units: **202,227**
- Tier-2 retained candidate units: **60,014**

## Evidence status

Every source row is routed to exactly one retained or reversible-holdout
disposition. Global duplicate state is persisted across chunks. Per-chunk source
and output hashes are in `INDOWORDNET_1M_SUMMARY.json`.

Human language review is **NOT RUN**. This rehearsal validates scale, restart,
reconciliation and deterministic routing; it does not establish lexical
correctness or translation fidelity.
