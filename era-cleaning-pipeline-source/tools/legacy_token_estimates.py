#!/usr/bin/env python3
"""Legacy-component token estimates (read-only measurement).

The six components cleaned before the tokenizer stage existed (Anudesh,
Dolly_T, OpenAssistant_T, Wiki_Chat_10K, Toxic_Matrix_10K, IndoWordNet_10K)
have no preserved retained streams on this machine — only their source
samples. This script measures BrahmicTokenizer-131K tokens over the SOURCE
sample text and derives an ESTIMATED retained-token figure by scaling with
each component's unit-level retention rate. These numbers are estimates,
not retained-stream measurements; they are labeled as such everywhere.

Produces era_token_estimates/LEGACY_TOKEN_ESTIMATES.json.
"""

from __future__ import annotations

import json
import sys
from collections import defaultdict
from pathlib import Path

import pyarrow.parquet as pq
from tokenizers import Tokenizer

ROOT = Path("/Users/bansalswati/ERA-phase1")
PERSONAL = Path.home() / "Personal/Technical/AI ERA"
TOKENIZER_REPO = "theschoolofai/BrahmicTokenizer-131K"
TOKENIZER_REVISION = "93df154cbc9dbf038a222c010d9b43906a8a72c3"
TOKENIZER_PATH = (
    Path.home()
    / ".cache/huggingface/hub/models--theschoolofai--BrahmicTokenizer-131K"
    / "snapshots" / TOKENIZER_REVISION / "tokenizer.json"
)
BATCH = 2000
NON_LANG_COLS = {"doc_id", "num_turns", "id", "interactions", "language",
                 "_era_source_index", "_era_source_shard", "_era_shard_row_index"}

# (parquet path, layout, retained units, total units) — unit counts are the
# verified figures from each component's closing report.
COMPONENTS = {
    "Anudesh": (PERSONAL / "anudesh1.parquet", "interactions", 34_185, 36_820),
    "Dolly_T": (ROOT / "era-phase1-datasets/Dolly_T.parquet", "multilingual", 417_392, 420_308),
    "OpenAssistant_T": (ROOT / "era-phase1-datasets/OpenAssistant_T.parquet", "multilingual", 653_667, 871_724),
    "Wiki_Chat_10K": (ROOT / "era-wikichat-pilot/Wiki_Chat_10K.parquet", "multilingual", 757_658, 774_903),
    "Toxic_Matrix_10K": (ROOT / "era-toxic-matrix-10k-pilot/Toxic_Matrix_10K.parquet", "multilingual", 279_943, 280_000),
    "IndoWordNet_10K": (ROOT / "era-indowordnet-10k-pilot/IndoWordNet_10K.parquet", "interactions", 9_986, 10_000),
}


def flatten_texts(value) -> list[str]:
    texts: list[str] = []
    stack = [value]
    while stack:
        item = stack.pop()
        if isinstance(item, str):
            texts.append(item)
        elif isinstance(item, (list, tuple)):
            stack.extend(item)
    return texts


def main() -> int:
    tok = Tokenizer.from_file(str(TOKENIZER_PATH))
    report: dict = {
        "stage": "legacy_named_tokenizer_estimate",
        "status": "RUN",
        "tokenizer": {
            "repo": TOKENIZER_REPO,
            "revision": TOKENIZER_REVISION,
            "vocab_size": tok.get_vocab_size(),
        },
        "method": "Retained streams from the pre-tokenizer phase were not preserved, "
                  "so tokens are measured over the SOURCE sample text (all interaction "
                  "strings, all language columns) and scaled by unit-level retention "
                  "(retained_units / total_units) to estimate retained tokens. "
                  "ESTIMATE, not a retained-stream measurement. Encoding without "
                  "special tokens; words = whitespace-separated segments.",
        "components": {},
    }
    for component, (path, layout, retained_units, total_units) in COMPONENTS.items():
        if not path.exists():
            report["components"][component] = {"status": "BLOCKED", "missing": str(path)}
            continue
        pf = pq.ParquetFile(path)
        if layout == "multilingual":
            columns = [c for c in pf.schema_arrow.names if c not in NON_LANG_COLS]
        else:
            columns = ["interactions"]
        per_lang = defaultdict(lambda: {"cells": 0, "turn_texts": 0, "words": 0, "tokens": 0})
        pending_texts: list[str] = []
        pending_langs: list[str] = []

        def drain():
            if not pending_texts:
                return
            encs = tok.encode_batch(pending_texts, add_special_tokens=False)
            for enc, lang, text in zip(encs, pending_langs, pending_texts):
                bucket = per_lang[lang]
                bucket["tokens"] += len(enc.ids)
                bucket["words"] += len(text.split())
                bucket["turn_texts"] += 1
            pending_texts.clear()
            pending_langs.clear()

        rows = 0
        for batch in pf.iter_batches(batch_size=512, columns=columns):
            data = batch.to_pydict()
            rows += batch.num_rows
            for col in columns:
                lang = col if layout == "multilingual" else "all"
                for cell in data[col]:
                    if cell is None:
                        continue
                    if isinstance(cell, str):
                        try:
                            cell = json.loads(cell)
                        except (ValueError, TypeError):
                            pass
                    texts = flatten_texts(cell)
                    if texts:
                        per_lang[lang]["cells"] += 1
                        for text in texts:
                            pending_texts.append(text)
                            pending_langs.append(lang)
                    if len(pending_texts) >= BATCH:
                        drain()
            if rows % 5120 == 0:
                print(f"  {component}: {rows:,} rows...", flush=True)
        drain()
        totals = {"cells": 0, "turn_texts": 0, "words": 0, "tokens": 0}
        for bucket in per_lang.values():
            for key in totals:
                totals[key] += bucket[key]
        retention = retained_units / total_units
        estimated = round(totals["tokens"] * retention)
        report["components"][component] = {
            "status": "RUN",
            "basis": "source_sample_text_estimate",
            "source_rows": rows,
            "units": {"retained": retained_units, "total": total_units, "retention": round(retention, 6)},
            "source_text_tokens": totals["tokens"],
            "estimated_retained_tokens": estimated,
            "totals": {**totals, "tokens_per_word": round(totals["tokens"] / totals["words"], 4) if totals["words"] else None},
            "per_language": {
                lang: {**bucket, "tokens_per_word": round(bucket["tokens"] / bucket["words"], 4) if bucket["words"] else None}
                for lang, bucket in sorted(per_lang.items())
            },
        }
        print(f"{component}: {rows:,} rows, {totals['tokens']:,} source tokens, "
              f"~{estimated:,} estimated retained", flush=True)

    out = ROOT / "era_token_estimates" / "LEGACY_TOKEN_ESTIMATES.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, ensure_ascii=False, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    print(f"written: {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
