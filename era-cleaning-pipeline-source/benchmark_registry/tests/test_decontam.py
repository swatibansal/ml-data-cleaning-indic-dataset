"""Unit tests for the ERA decontamination core library and lookup module.

Uses synthetic fixtures only. Builds a tiny in-memory registry, plants a
contaminated string, and asserts: exact plant matches, transliterated variant
matches, clean text does not match, ZWNJ/ZWJ are preserved, and shard SHA-256
verification works.

Run: .venv-indowordnet/bin/python -m unittest discover -s benchmark_registry/tests
"""

from __future__ import annotations

import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path

_LIB = Path(__file__).resolve().parents[1] / "lib"
sys.path.insert(0, str(_LIB))

import era_decontam as dc  # noqa: E402
from era_lookup import ContaminationScanner, RegistryError  # noqa: E402


def _make_registry(tmp: Path, benchmark_texts: dict[str, list[str]]) -> Path:
    """Build a minimal on-disk registry from raw benchmark strings."""
    reg = tmp / "reg"
    (reg / "shards").mkdir(parents=True, exist_ok=True)
    benchmarks = []
    for bid, texts in benchmark_texts.items():
        word, char, tword, tchar = set(), set(), set(), set()
        canaries = []
        for text in texts:
            grams = dc.emit_grams(text)
            word.update(grams.get("word", []))
            char.update(grams.get("char", []))
            tword.update(grams.get("translit_word", []))
            tchar.update(grams.get("translit_char", []))
            canaries.append(dc.canary_record(text))
        shard = {
            "benchmark_id": bid,
            "registry_format_version": dc.REGISTRY_FORMAT_VERSION,
            "word_grams": sorted(word),
            "char_grams": sorted(char),
            "translit_word_grams": sorted(tword),
            "translit_char_grams": sorted(tchar),
            "canaries": sorted(canaries, key=lambda r: r["hash"]),
        }
        payload = json.dumps(shard, ensure_ascii=False, sort_keys=True, indent=0) + "\n"
        (reg / "shards" / f"{bid}.json").write_text(payload, encoding="utf-8")
        sha = hashlib.sha256(payload.encode("utf-8")).hexdigest()
        benchmarks.append(
            {
                "id": bid,
                "status": "INSTALLED",
                "shard": f"shards/{bid}.json",
                "shard_sha256": sha,
                "counts": {"word_grams": len(word), "char_grams": len(char)},
            }
        )
    manifest = {
        "registry_format_version": dc.REGISTRY_FORMAT_VERSION,
        "benchmarks": benchmarks,
    }
    (reg / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, sort_keys=True, indent=2) + "\n",
        encoding="utf-8",
    )
    return reg


class TestNormalization(unittest.TestCase):
    def test_zwnj_zwj_preserved(self):
        # ZWNJ U+200C and ZWJ U+200D must survive normalization.
        s = "क‍ष and क‌ष"
        norm = dc.normalize_for_match(s)
        self.assertIn("‍", norm)
        self.assertIn("‌", norm)

    def test_bidi_and_zwsp_stripped(self):
        s = "hello‮world​﻿"
        norm = dc.normalize_for_match(s)
        self.assertNotIn("‮", norm)
        self.assertNotIn("​", norm)
        self.assertNotIn("﻿", norm)
        self.assertEqual(norm, "helloworld")

    def test_nfc_and_casefold(self):
        self.assertEqual(dc.normalize_for_match("  Hello   WORLD "), "hello world")

    def test_deterministic(self):
        s = "The quick brown fox jumps over the lazy dog many times here"
        self.assertEqual(dc.emit_grams(s), dc.emit_grams(s))


class TestTransliteration(unittest.TestCase):
    def test_devanagari_romanizes(self):
        # भारत -> should contain 'bhaarat'-like romanization.
        out = dc.transliterate_devanagari("भारत")
        self.assertTrue(out.startswith("bh"))
        self.assertIn("a", out)

    def test_translit_deterministic(self):
        s = "नमस्ते दुनिया"
        self.assertEqual(
            dc.transliterate_devanagari(s), dc.transliterate_devanagari(s)
        )

    def test_zero_width_dropped_in_translit(self):
        # Joiners carry no Latin realization in the romanized variant.
        with_joiner = dc.transliterate_devanagari("क‍ष")
        without = dc.transliterate_devanagari("कष")
        self.assertEqual(with_joiner, without)


class TestContaminationMatching(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        # A distinctive English eval item (>=8 tokens) and an Indic item.
        self.eng_item = (
            "Natalia sold clips to forty eight of her friends in April and then"
        )
        self.hin_item = "भारत की राजधानी नई दिल्ली है और यह उत्तर भारत में स्थित है"
        self.reg = _make_registry(
            self.tmp,
            {"GSM8K": [self.eng_item], "MILU": [self.hin_item]},
        )
        self.scanner = ContaminationScanner(self.reg)

    def test_planted_exact_matches(self):
        res = self.scanner.scan_text(
            "Here is the answer: " + self.eng_item + " everything works."
        )
        self.assertTrue(res["is_candidate"])
        self.assertIn("GSM8K", res["matched_benchmarks"])

    def test_indic_planted_matches(self):
        res = self.scanner.scan_text(self.hin_item)
        self.assertTrue(res["is_candidate"])
        self.assertIn("MILU", res["matched_benchmarks"])

    def test_transliterated_variant_matches(self):
        # Feed a Latin transliteration of the Hindi item; should still match MILU
        # because the registry stored translit_word/translit_char grams.
        romanized = dc.transliterate_devanagari(self.hin_item)
        res = self.scanner.scan_text(romanized)
        self.assertTrue(res["is_candidate"])
        self.assertIn("MILU", res["matched_benchmarks"])

    def test_clean_text_does_not_match(self):
        res = self.scanner.scan_text(
            "This is a completely unrelated sentence about gardening tomatoes today."
        )
        self.assertFalse(res["is_candidate"])
        self.assertEqual(res["matched_benchmarks"], [])

    def test_canary_exact_flag(self):
        res = self.scanner.scan_text(self.eng_item)
        detail = {d["benchmark"]: d for d in res["detail"]}
        self.assertTrue(detail["GSM8K"]["canary_exact"])

    def test_conversation_scan(self):
        res = self.scanner.scan_conversation(
            ["User asks a math question.", self.eng_item, "Assistant replies."]
        )
        self.assertIn("GSM8K", res["matched_benchmarks"])

    def test_shard_hash_verification_detects_tamper(self):
        shard = self.reg / "shards" / "GSM8K.json"
        text = shard.read_text(encoding="utf-8")
        shard.write_text(text.replace("GSM8K", "GSM8K "), encoding="utf-8")
        with self.assertRaises(RegistryError):
            ContaminationScanner(self.reg)


if __name__ == "__main__":
    unittest.main()
