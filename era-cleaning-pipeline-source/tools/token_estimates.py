#!/usr/bin/env python3
"""Named-tokenizer estimate stage (read-only measurement).

Counts BrahmicTokenizer-131K tokens over the retained streams of completed
components. Never modifies pipeline outputs; produces
era_token_estimates/TOKEN_ESTIMATES.json.
"""

from __future__ import annotations

import glob
import gzip
import json
import sys
from collections import defaultdict
from pathlib import Path

from tokenizers import Tokenizer

ROOT = Path("/Users/bansalswati/ERA-phase1")
TOKENIZER_REPO = "theschoolofai/BrahmicTokenizer-131K"
TOKENIZER_REVISION = "93df154cbc9dbf038a222c010d9b43906a8a72c3"
TOKENIZER_PATH = (
    Path.home()
    / ".cache/huggingface/hub/models--theschoolofai--BrahmicTokenizer-131K"
    / "snapshots" / TOKENIZER_REVISION / "tokenizer.json"
)
BATCH = 2000

COMPONENTS = {
    "IndoWordNet_1M": sorted(
        glob.glob(str(ROOT / "ERA_IndoWordNet_1M_Rehearsal_2026-07-24/INDOWORDNET_1M_DECONTAM/chunks/*.retained.jsonl.gz"))
    ),
    "HHRLHF_T": [str(ROOT / "ERA_HHRLHF_WikiConv_Pilot_2026-07-24/outputs/HHRLHF_T/pilot-retained-scrubbed.jsonl")],
    "Wiki_Conv": [str(ROOT / "ERA_HHRLHF_WikiConv_Pilot_2026-07-24/outputs/Wiki_Conv/pilot-retained-scrubbed.jsonl")],
    "Indic_ShareLlama": [str(ROOT / "ERA_HHRLHF_WikiConv_Pilot_2026-07-24/outputs/Indic_ShareLlama/pilot-retained-scrubbed.jsonl")],
    "WikiHow": [str(ROOT / "ERA_HHRLHF_WikiConv_Pilot_2026-07-24/outputs/WikiHow/pilot-retained-scrubbed.jsonl")],
}


def iter_lines(path: str):
    opener = gzip.open if path.endswith(".gz") else open
    with opener(path, "rt", encoding="utf-8") as handle:
        for line in handle:
            if line.strip():
                yield json.loads(line)


def flatten_texts(interactions) -> list[str]:
    texts: list[str] = []
    stack = [interactions]
    while stack:
        item = stack.pop()
        if isinstance(item, str):
            texts.append(item)
        elif isinstance(item, (list, tuple)):
            stack.extend(item)
    return texts


def record_language(record) -> str:
    if "language" in record:
        return str(record["language"])
    prov = record.get("_era_provenance") or {}
    for key in ("language", "language_column", "path_language"):
        if key in prov:
            return str(prov[key])
    return "unknown"


def main() -> int:
    tok = Tokenizer.from_file(str(TOKENIZER_PATH))
    report: dict = {
        "stage": "named_tokenizer_estimate",
        "status": "RUN",
        "tokenizer": {
            "repo": TOKENIZER_REPO,
            "revision": TOKENIZER_REVISION,
            "vocab_size": tok.get_vocab_size(),
        },
        "method": "All strings in each retained record's interactions are encoded "
                  "without special tokens and summed. words = whitespace-separated "
                  "segments (crude but deterministic); fertility = tokens/words. "
                  "Read-only: no pipeline output is modified.",
        "components": {},
    }
    for component, files in COMPONENTS.items():
        missing = [f for f in files if not Path(f).exists()]
        if missing or not files:
            report["components"][component] = {"status": "BLOCKED", "missing": missing}
            continue
        per_lang = defaultdict(lambda: {"records": 0, "turn_texts": 0, "words": 0, "tokens": 0})
        pending_texts: list[str] = []
        pending_langs: list[str] = []

        def drain():
            if not pending_texts:
                return
            for enc, lang, text in zip(tok.encode_batch(pending_texts, add_special_tokens=False), pending_langs, pending_texts):
                bucket = per_lang[lang]
                bucket["tokens"] += len(enc.ids)
                bucket["words"] += len(text.split())
                bucket["turn_texts"] += 1
            pending_texts.clear()
            pending_langs.clear()

        total_records = 0
        for path in files:
            for record in iter_lines(path):
                lang = record_language(record)
                per_lang[lang]["records"] += 1
                total_records += 1
                for text in flatten_texts(record.get("interactions", [])):
                    pending_texts.append(text)
                    pending_langs.append(lang)
                if len(pending_texts) >= BATCH:
                    drain()
                if total_records % 200_000 == 0:
                    print(f"  {component}: {total_records:,} records...", flush=True)
        drain()
        totals = {"records": 0, "turn_texts": 0, "words": 0, "tokens": 0}
        for bucket in per_lang.values():
            for key in totals:
                totals[key] += bucket[key]
        component_report = {
            "status": "RUN",
            "totals": {**totals, "tokens_per_word": round(totals["tokens"] / totals["words"], 4) if totals["words"] else None},
            "per_language": {
                lang: {**bucket, "tokens_per_word": round(bucket["tokens"] / bucket["words"], 4) if bucket["words"] else None}
                for lang, bucket in sorted(per_lang.items())
            },
        }
        report["components"][component] = component_report
        print(f"{component}: {totals['records']:,} records, {totals['tokens']:,} tokens", flush=True)

    out = ROOT / "era_token_estimates" / "TOKEN_ESTIMATES.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, ensure_ascii=False, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    print(f"written: {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
