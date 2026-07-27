"""Synthetic-fixture tests for the benchmark_decontamination hook.

These tests never touch the real protected registry or the frozen 1M outputs.
They build a tiny throwaway registry (manifest + one shard, using the registry's
own stdlib primitives) with a single known "protected" item, point the pipeline's
module-level scanner at it, and assert the two-tier routing policy:

  * a canary exact match  -> benchmark_holdout (tier 1)
  * >= 3 distinct word 8-grams -> benchmark_holdout (tier 1)
  * 1 word 8-gram, no canary -> retained + tier-2 report count only
  * a clean row is unaffected
  * registry absent (BENCH_SCANNER is None) -> stage NOT RUN + blocker, no crash

No raw matched text is asserted against the reports (counts only), matching the
CLAUDE.md privacy guardrail.
"""

import argparse
import gzip
import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "benchmark_registry" / "lib"))

import indowordnet_1m as era
import era_decontam
from era_lookup import ContaminationScanner


# A "protected" benchmark item with enough words that it yields multiple distinct
# word 8-grams. Latin so the tests do not depend on Devanagari transliteration.
PROTECTED_ITEM = (
    "the quick brown fox jumps over the lazy dog while the sun sets slowly "
    "behind the distant blue mountains near the quiet winding river valley"
)


def _sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def build_synthetic_registry(root: Path) -> str:
    """Write a minimal format-v1 registry with one INSTALLED benchmark. Returns dir."""
    registry_dir = root / "synthetic_registry"
    shards_dir = registry_dir / "shards"
    shards_dir.mkdir(parents=True, exist_ok=True)

    grams = era_decontam.emit_grams(PROTECTED_ITEM)
    canary = era_decontam.canary_record(PROTECTED_ITEM)
    shard = {
        "benchmark_id": "SYNTH",
        "registry_format_version": era_decontam.REGISTRY_FORMAT_VERSION,
        "word_ngram_n": era_decontam.WORD_NGRAM_N,
        "char_ngram_n": era_decontam.CHAR_NGRAM_N,
        "hash_hex_width": era_decontam.HASH_HEX_WIDTH,
        "word_grams": grams["word"],
        "char_grams": grams.get("char", []),
        "translit_word_grams": grams.get("translit_word", []),
        "translit_char_grams": grams.get("translit_char", []),
        "canaries": [canary],
    }
    shard_path = shards_dir / "SYNTH.json"
    shard_path.write_text(
        json.dumps(shard, ensure_ascii=False, sort_keys=True), encoding="utf-8"
    )
    manifest = {
        "registry_format_version": era_decontam.REGISTRY_FORMAT_VERSION,
        "build_timestamp_utc": "1970-01-01T00:00:00+00:00",
        "benchmarks": [
            {
                "id": "SYNTH",
                "status": "INSTALLED",
                "shard": "shards/SYNTH.json",
                "shard_sha256": _sha256_file(shard_path),
                "repo": "synthetic/test",
                "revision": "0" * 40,
                "split": "test",
                "text_fields": ["text"],
                "item_cap": 250000,
                "counts": {"items": 1, "capped": False},
                "note": "synthetic test benchmark",
            }
        ],
    }
    (registry_dir / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, sort_keys=True), encoding="utf-8"
    )
    return str(registry_dir)


def hi_row(index, prompt=None, response=None, **updates):
    value = {
        "id": f"id-{index:03d}",
        "language": "hi",
        "num_turns": 1,
        "interactions": [[
            prompt or f"शब्द {index} का अर्थ क्या है?",
            response or f"यह उत्तर संख्या {index} के लिए एक विशिष्ट अर्थ बताता है।",
        ]],
    }
    value.update(updates)
    return value


class BenchmarkDecontaminationTests(unittest.TestCase):
    def setUp(self):
        self._saved_scanner = era.BENCH_SCANNER
        self._saved_blocker = era.BENCH_SCANNER_BLOCKER

    def tearDown(self):
        era.BENCH_SCANNER = self._saved_scanner
        era.BENCH_SCANNER_BLOCKER = self._saved_blocker

    def _run(self, temporary, records, scanner):
        root = Path(temporary)
        source = root / "fixture.jsonl"
        with source.open("w", encoding="utf-8") as handle:
            for record in records:
                handle.write(era.stable_json(record) + "\n")
        era.BENCH_SCANNER = scanner
        era.BENCH_SCANNER_BLOCKER = None if scanner else "benchmark registry not installed"
        out = root / "out"
        args = argparse.Namespace(
            output_dir=str(out),
            rows=len(records),
            chunk_size=len(records),
            max_chunks=None,
            source_jsonl=str(source),
        )
        era.run(args)
        summary = json.loads(
            (out / "reports" / "INDOWORDNET_1M_SUMMARY.json").read_text()
        )
        holdouts = []
        path = out / "chunks" / "chunk-00000.holdouts.jsonl.gz"
        with gzip.open(path, "rt", encoding="utf-8") as handle:
            holdouts = [json.loads(line) for line in handle if line.strip()]
        retained = []
        path = out / "chunks" / "chunk-00000.retained.jsonl.gz"
        with gzip.open(path, "rt", encoding="utf-8") as handle:
            retained = [json.loads(line) for line in handle if line.strip()]
        return summary, holdouts, retained

    def test_canary_match_routes_to_benchmark_holdout(self):
        with tempfile.TemporaryDirectory() as temporary:
            scanner = ContaminationScanner(build_synthetic_registry(Path(temporary)))
            # The whole conversation (prompt + "\n" + response) normalizes to the
            # protected item -> canary exact hit. Split into two non-empty halves so
            # neither turn is empty (an empty turn would route to structural_holdout
            # before the benchmark check).
            words = PROTECTED_ITEM.split()
            half = len(words) // 2
            records = [
                hi_row(0, "प्रश्न", "एक छोटा उत्तर"),  # clean, not contaminated
                {
                    "id": "id-canary",
                    "language": "en",
                    "num_turns": 1,
                    "interactions": [[
                        " ".join(words[:half]),
                        " ".join(words[half:]),
                    ]],
                },
            ]
            summary, holdouts, retained = self._run(temporary, records, scanner)
            self.assertEqual(summary["reconciliation_difference"], 0)
            self.assertEqual(summary["benchmark_decontamination"]["status"], "RUN")
            bench = [h for h in holdouts if h["disposition"] == "benchmark_holdout"]
            self.assertEqual(len(bench), 1)
            self.assertEqual(bench[0]["benchmark_tier"], 1)
            self.assertTrue(bench[0]["canary_exact"])
            self.assertIn("SYNTH", bench[0]["matched_benchmarks"])
            self.assertGreaterEqual(
                summary["benchmark_decontamination"]["tier1_holdout_units"], 1
            )
            # No raw matched text stored anywhere in the summary.
            self.assertNotIn(PROTECTED_ITEM, json.dumps(summary, ensure_ascii=False))

    def test_three_word_grams_route_to_benchmark_holdout(self):
        with tempfile.TemporaryDirectory() as temporary:
            scanner = ContaminationScanner(build_synthetic_registry(Path(temporary)))
            # A contiguous 10-word slice of the protected item yields 3 word 8-grams
            # (10 - 8 + 1 = 3), no canary => tier 1 by the gram threshold.
            slice_10 = " ".join(PROTECTED_ITEM.split()[:10])
            records = [
                {
                    "id": "id-3gram",
                    "language": "en",
                    "num_turns": 1,
                    "interactions": [["explain", slice_10]],
                },
            ]
            summary, holdouts, retained = self._run(temporary, records, scanner)
            self.assertEqual(summary["reconciliation_difference"], 0)
            bench = [h for h in holdouts if h["disposition"] == "benchmark_holdout"]
            self.assertEqual(len(bench), 1)
            self.assertEqual(bench[0]["benchmark_tier"], 1)
            self.assertFalse(bench[0]["canary_exact"])
            self.assertGreaterEqual(bench[0]["max_word_gram_overlaps"], 3)

    def test_single_word_gram_is_tier2_annotation_only(self):
        with tempfile.TemporaryDirectory() as temporary:
            scanner = ContaminationScanner(build_synthetic_registry(Path(temporary)))
            # Exactly 8 contiguous protected words => exactly 1 word 8-gram, no
            # canary => tier 2 (retained + report count only).
            slice_8 = " ".join(PROTECTED_ITEM.split()[:8])
            records = [
                {
                    "id": "id-1gram",
                    "language": "en",
                    "num_turns": 1,
                    "interactions": [["explain", slice_8]],
                },
            ]
            summary, holdouts, retained = self._run(temporary, records, scanner)
            self.assertEqual(summary["reconciliation_difference"], 0)
            # Retained, NOT held out.
            self.assertEqual(
                [h for h in holdouts if h["disposition"] == "benchmark_holdout"], []
            )
            self.assertEqual(len(retained), 1)
            self.assertEqual(
                summary["benchmark_decontamination"]["tier1_holdout_units"], 0
            )
            self.assertEqual(
                summary["benchmark_decontamination"]["tier2_candidate_units"], 1
            )
            self.assertEqual(
                summary["benchmark_decontamination"]["tier2_units_by_benchmark"],
                {"SYNTH": 1},
            )
            # The retained row carries no embedded benchmark annotation (tier 2 is
            # report-only), so the retained stream stays byte-stable.
            self.assertNotIn("benchmark", json.dumps(retained[0], ensure_ascii=False))

    def test_clean_row_is_unaffected(self):
        with tempfile.TemporaryDirectory() as temporary:
            scanner = ContaminationScanner(build_synthetic_registry(Path(temporary)))
            records = [hi_row(0), hi_row(1)]
            summary, holdouts, retained = self._run(temporary, records, scanner)
            self.assertEqual(summary["reconciliation_difference"], 0)
            self.assertEqual(len(retained), 2)
            self.assertEqual(
                [h for h in holdouts if h["disposition"] == "benchmark_holdout"], []
            )
            self.assertEqual(
                summary["benchmark_decontamination"]["tier1_holdout_units"], 0
            )
            self.assertEqual(
                summary["benchmark_decontamination"]["tier2_candidate_units"], 0
            )

    def test_registry_absent_degrades_to_not_run(self):
        with tempfile.TemporaryDirectory() as temporary:
            records = [hi_row(0), hi_row(1)]
            summary, holdouts, retained = self._run(temporary, records, scanner=None)
            self.assertEqual(summary["reconciliation_difference"], 0)
            self.assertEqual(summary["benchmark_decontamination"]["status"], "NOT RUN")
            self.assertEqual(
                summary["strategy_status"]["benchmark_decontamination"], "NOT RUN"
            )
            self.assertIn(
                "benchmark registry not installed", summary["release_blockers"]
            )
            self.assertEqual(len(retained), 2)


if __name__ == "__main__":
    unittest.main()
