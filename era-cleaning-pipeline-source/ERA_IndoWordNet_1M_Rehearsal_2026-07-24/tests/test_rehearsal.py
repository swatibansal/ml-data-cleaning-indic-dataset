import argparse
import gzip
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import indowordnet_1m as era


def row(index, prompt=None, response=None, **updates):
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


def write_fixture(path):
    records = [row(i) for i in range(30)]
    records[0] = row(
        0,
        "लंबे उदाहरण शब्द का अर्थ बताइए।",
        "यह एक पर्याप्त लंबा और स्थिर उत्तर है जो परीक्षण में मूल रिकॉर्ड का काम करता है।",
    )
    records[10] = {
        **records[0],
        "id": "id-010",
    }
    records[1] = row(
        1,
        "एक दूसरे बहुत लंबे उदाहरण शब्द का अर्थ विस्तार से बताइए।",
        "यह दूसरा पर्याप्त लंबा उत्तर है जिसमें केवल अंतिम शब्द बदलकर निकट प्रतिलिपि बनाई जाएगी और बाकी पूरा वाक्य बिल्कुल समान रखा जाएगा ताकि दोनों स्वतंत्र जाँच सीमाएँ सुरक्षित रूप से पार हों।",
    )
    records[20] = row(
        20,
        "एक दूसरे बहुत लंबे उदाहरण शब्द का अर्थ विस्तार से बताइए।",
        "यह दूसरा पर्याप्त लंबा उत्तर है जिसमें केवल अंतिम शब्द बदलकर निकट प्रतिलिपि बनाई जाएगी और बाकी पूरा वाक्य बिल्कुल समान रखा जाएगा ताकि दोनों स्वतंत्र जाँच सीमाएँ सुरक्षित रूप से पार हों।!",
    )
    records[11] = row(11, interactions=[])
    records[12] = row(12, response="संपर्क test@example.com पर करें।")
    records[13] = row(13, response="कुंजी AKIAABCDEFGHIJKLMNOP है।")
    records[14] = row(14, response="दोहराव। दोहराव। दोहराव। दोहराव।")
    with path.open("w", encoding="utf-8") as handle:
        for record in records:
            handle.write(era.stable_json(record) + "\n")
    return records


class UnitTests(unittest.TestCase):
    def test_cleaning_preserves_joiners_and_removes_noise(self):
        source = "  क\u200dष\u200c \u200b\u202e  "
        cleaned, flags = era.clean_text(source)
        self.assertEqual(cleaned, "क\u200dष\u200c")
        self.assertTrue(flags["noise_removed"])
        self.assertTrue(flags["any_changed"])

    def test_hamming_candidate_bands_are_complete_within_three_bits(self):
        base = 0x1234567890ABCDEF
        for changed_bits in ((0,), (0, 17), (0, 17, 42)):
            other = base
            for bit in changed_bits:
                other ^= 1 << bit
            self.assertLessEqual(era.hamming64(base, other), 3)
            self.assertTrue(set(era.band_values(base)) & set(era.band_values(other)))

    def test_near_duplicate_metrics(self):
        left = (
            "a sufficiently long phrase used to test a near duplicate ending and "
            "preserve almost all character five grams across both records. "
        ) * 3
        right = left + "!"
        self.assertGreaterEqual(era.jaccard_5gram(left, right), 0.95)
        self.assertLessEqual(era.hamming64(era.simhash64(left), era.simhash64(right)), 3)

    def test_language_script_anomaly_is_annotation_only(self):
        annotation = era.script_annotation(
            "hi", "this is deliberately long latin text under declared hindi metadata"
        )
        self.assertEqual(annotation["type"], "language_script_anomaly")


class IntegrationTests(unittest.TestCase):
    def make_args(self, output, source, max_chunks=None):
        return argparse.Namespace(
            output_dir=str(output),
            rows=30,
            chunk_size=10,
            max_chunks=max_chunks,
            source_jsonl=str(source),
        )

    def test_restart_global_routing_and_deterministic_outputs(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "fixture.jsonl"
            write_fixture(source)
            resumed = root / "resumed"
            clean = root / "clean"

            era.run(self.make_args(resumed, source, max_chunks=1))
            checkpoint = json.loads((resumed / "checkpoint.json").read_text())
            self.assertEqual(checkpoint["next_chunk"], 1)
            era.run(self.make_args(resumed, source))
            era.run(self.make_args(clean, source))

            resumed_summary = json.loads(
                (resumed / "reports" / "INDOWORDNET_1M_SUMMARY.json").read_text()
            )
            self.assertEqual(resumed_summary["source_rows"], 30)
            self.assertEqual(resumed_summary["reconciliation_difference"], 0)
            self.assertEqual(
                resumed_summary["dispositions"]["exact_duplicate_holdout"], 1
            )
            self.assertEqual(
                resumed_summary["dispositions"]["near_duplicate_holdout"], 1
            )
            self.assertEqual(resumed_summary["dispositions"]["structural_holdout"], 1)
            self.assertEqual(resumed_summary["dispositions"]["privacy_holdout"], 1)
            self.assertEqual(resumed_summary["dispositions"]["security_holdout"], 1)
            self.assertEqual(resumed_summary["dispositions"]["repetition_holdout"], 1)

            for chunk_no in range(3):
                for label in ("retained", "holdouts", "candidates"):
                    name = f"chunk-{chunk_no:05d}.{label}.jsonl.gz"
                    self.assertEqual(
                        era.sha256_file(resumed / "chunks" / name),
                        era.sha256_file(clean / "chunks" / name),
                    )

            cross_chunk_holdouts = []
            for chunk_no in (1, 2):
                path = resumed / "chunks" / f"chunk-{chunk_no:05d}.holdouts.jsonl.gz"
                with gzip.open(path, "rt", encoding="utf-8") as handle:
                    cross_chunk_holdouts.extend(json.loads(line) for line in handle)
            exact = next(
                item
                for item in cross_chunk_holdouts
                if item["disposition"] == "exact_duplicate_holdout"
            )
            near = next(
                item
                for item in cross_chunk_holdouts
                if item["disposition"] == "near_duplicate_holdout"
            )
            self.assertEqual(exact["canonical_record_id"], "id-000")
            self.assertEqual(near["canonical_record_id"], "id-001")

            verify_args = argparse.Namespace(output_dir=str(resumed))
            self.assertEqual(era.verify(verify_args), 0)


if __name__ == "__main__":
    unittest.main()
