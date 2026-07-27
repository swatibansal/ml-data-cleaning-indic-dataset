"""Generates cross-language parity vectors and asserts basic invariants.

Writes benchmark_registry/tests/parity_vectors.json with Python-computed
hash_gram and emit_grams outputs for a fixed set of fixtures. The Node parity
test (test_node_parity.mjs) reads this file and asserts byte-identical results,
proving the two lookup libraries agree.

Run as part of: python -m unittest discover -s benchmark_registry/tests
"""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

_LIB = Path(__file__).resolve().parents[1] / "lib"
sys.path.insert(0, str(_LIB))

import era_decontam as dc  # noqa: E402

_VECTORS_PATH = Path(__file__).resolve().parent / "parity_vectors.json"

# Fixed fixtures spanning Latin, Devanagari, and joiner-bearing text.
_HASH_GRAM_INPUTS = [
    "hello world",
    "the quick brown fox jumps over",
    "नमस्ते दुनिया",
    "भारत की राजधानी",
]
_EMIT_GRAMS_INPUTS = [
    "Natalia sold clips to 48 of her friends in April and then she",
    "भारत की राजधानी नई दिल्ली है और यह उत्तर भारत में स्थित है",
    "short text",
]


class TestParityVectors(unittest.TestCase):
    def test_write_and_selfcheck_vectors(self):
        vectors = {
            "hash_gram": {g: dc.hash_gram(g) for g in _HASH_GRAM_INPUTS},
            "emit_grams": {t: dc.emit_grams(t) for t in _EMIT_GRAMS_INPUTS},
        }
        _VECTORS_PATH.write_text(
            json.dumps(vectors, ensure_ascii=False, sort_keys=True, indent=2) + "\n",
            encoding="utf-8",
        )
        # Self-checks: hashes are 16 hex chars; deterministic on recompute.
        for g, h in vectors["hash_gram"].items():
            self.assertEqual(len(h), dc.HASH_HEX_WIDTH)
            self.assertEqual(dc.hash_gram(g), h)
        for t, grams in vectors["emit_grams"].items():
            self.assertEqual(dc.emit_grams(t), grams)

    def test_indic_emit_has_translit(self):
        grams = dc.emit_grams("भारत की राजधानी नई दिल्ली है")
        self.assertTrue(grams["char"])
        self.assertTrue(grams.get("translit_word"))


if __name__ == "__main__":
    unittest.main()
