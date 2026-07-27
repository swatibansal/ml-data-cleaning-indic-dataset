#!/usr/bin/env python3
"""ERA Phase 1 — protected benchmark registry builder.

Downloads TEST/EVAL splits of the 40B eval suite at PINNED revisions, extracts
question/answer/prompt text, normalizes (NFC, preserve ZWNJ/ZWJ), and emits:

  benchmark_registry/
    manifest.json                 -- versioned manifest (sources, revisions,
                                       counts, per-shard SHA-256, translit scheme)
    shards/<benchmark_id>.json     -- protected n-gram hashes + canaries

Deterministic: sorted outputs, fixed seed, no timestamps inside hashed shard
content (the manifest carries a build_timestamp_utc field, and each benchmark
entry's SHA-256 is over the shard file, which contains no timestamps).

Stdlib + datasets/huggingface_hub/pyarrow only. No new dependencies.

Run inside the .venv-indowordnet venv:
    .venv-indowordnet/bin/python benchmark_registry/build_registry.py
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import sys
import traceback
from pathlib import Path

# Make the sibling lib importable regardless of CWD.
_LIB = Path(__file__).resolve().parent / "lib"
sys.path.insert(0, str(_LIB))

from era_decontam import (  # noqa: E402
    CANARY_PREVIEW_CHARS,
    CHAR_NGRAM_N,
    DEVANAGARI_TRANSLIT_SCHEME,
    HASH_HEX_WIDTH,
    REGISTRY_FORMAT_VERSION,
    WORD_NGRAM_N,
    canary_record,
    emit_grams,
    normalize_for_match,
)

REGISTRY_DIR = Path(__file__).resolve().parent
SHARDS_DIR = REGISTRY_DIR / "shards"
CANARIES_PER_BENCHMARK = 50
# Cap on items materialized per benchmark. Eval item banks here top out around
# ~108K rows (IndicMMLU-Pro); this cap is set well above that so no eval split
# is silently truncated. Any cap that actually bites is recorded per benchmark
# in the manifest (counts.capped == true).
DEFAULT_ITEM_CAP = 250_000


# --- Benchmark source definitions -----------------------------------------
#
# Each entry: id, list of HuggingFace (repo, config, split) triples, and the
# names of text fields to extract. Revisions are resolved to the exact commit
# hash at build time and recorded in the manifest.

BENCHMARK_SOURCES: list[dict] = [
    {
        "id": "MILU",
        "note": "ai4bharat/MILU — Indic multitask language understanding.",
        "repo": "ai4bharat/MILU",
        # MILU is configured per-language; enumerate configs at build time.
        "configs": "ALL",
        "split": "test",
        "text_fields": ["question", "option1", "option2", "option3", "option4",
                        "target", "answer"],
    },
    {
        "id": "IndicMMLU-Pro",
        "note": "IndicMMLU-Pro — try LinguaLift/IndicMMLU-Pro.",
        "repo": "LinguaLift/IndicMMLU-Pro",
        "configs": "ALL",
        "split": "test",
        "text_fields": ["question", "options", "answer", "answer_text"],
    },
    {
        "id": "GSM8K",
        "note": "openai/gsm8k — grade-school math, main config, test split.",
        "repo": "openai/gsm8k",
        "configs": ["main"],
        "split": "test",
        "text_fields": ["question", "answer"],
    },
    {
        "id": "MATH",
        "note": "Hendrycks MATH competition set (test split).",
        # Try alternatives in order; first that loads wins (recorded in manifest).
        "repo_candidates": [
            "EleutherAI/hendrycks_math",
            "nlile/hendrycks-MATH-benchmark",
            "hendrycks/competition_math",
        ],
        "configs": "ALL",
        "split": "test",
        "text_fields": ["problem", "solution", "question", "answer"],
    },
    {
        "id": "IndicGenBench",
        "note": (
            "google/IndicGenBench is a collection of custom-JSON repos (each file "
            "has an embedded canary GUID + an 'examples' list). Loaded via a "
            "dedicated raw-JSON path, not datasets.load_dataset."
        ),
        "loader": "indicgenbench_json",
        "repo_candidates": [
            "google/IndicGenBench_flores_in",
            "google/IndicGenBench_crosssum_in",
            "google/IndicGenBench_xorqa_in",
            "google/IndicGenBench_xquad_in",
        ],
        "configs": "ALL",
        "split": "test",
        "text_fields": ["source", "target", "question", "context", "answer",
                        "summary", "text", "prediction"],
    },
    {
        "id": "BharatEval",
        "note": (
            "BharatEval item bank — not confirmed publicly available on HF. "
            "Marked UNAVAILABLE unless a repo id is supplied via --bharateval-repo."
        ),
        "repo": None,  # filled from --bharateval-repo if provided
        "configs": "ALL",
        "split": "test",
        "text_fields": ["question", "answer", "prompt", "text"],
    },
]


def log(msg: str) -> None:
    print(msg, flush=True)


def resolve_commit(repo: str) -> str | None:
    """Resolve the current main-branch commit hash for a dataset repo."""
    try:
        from huggingface_hub import HfApi

        info = HfApi().dataset_info(repo)
        return info.sha
    except Exception as exc:  # noqa: BLE001
        log(f"    ! could not resolve commit for {repo}: {exc!r}")
        return None


def list_configs(repo: str, revision: str | None) -> list[str]:
    from datasets import get_dataset_config_names

    try:
        names = get_dataset_config_names(repo, revision=revision)
        return sorted(names)
    except Exception as exc:  # noqa: BLE001
        log(f"    ! could not list configs for {repo}: {exc!r}")
        return []


def iter_text_values(row: dict, text_fields: list[str]):
    """Yield string values for the requested fields, flattening lists."""
    for field in text_fields:
        if field not in row:
            continue
        val = row[field]
        if isinstance(val, str):
            if val.strip():
                yield val
        elif isinstance(val, (list, tuple)):
            for item in val:
                if isinstance(item, str) and item.strip():
                    yield item
        elif isinstance(val, dict):
            for item in val.values():
                if isinstance(item, str) and item.strip():
                    yield item


def build_shard_for_repo(
    repo: str,
    revision: str | None,
    configs,
    split: str,
    text_fields: list[str],
    item_cap: int,
) -> dict:
    """Load one repo (all/selected configs) and accumulate grams + canaries.

    Returns a partial accumulation dict.
    """
    from datasets import load_dataset

    word: set[str] = set()
    char: set[str] = set()
    tword: set[str] = set()
    tchar: set[str] = set()
    canary_pool: list[str] = []  # normalized full-item strings (dedup+sort later)
    items = 0
    capped = False
    used_configs: list[str] = []

    if configs == "ALL":
        cfgs = list_configs(repo, revision) or [None]
    else:
        cfgs = configs

    for cfg in cfgs:
        try:
            ds = load_dataset(
                repo,
                cfg,
                split=split,
                revision=revision,
            )
        except Exception as exc:  # noqa: BLE001
            log(f"    ! load failed repo={repo} config={cfg} split={split}: {exc!r}")
            continue
        used_configs.append(cfg if cfg is not None else "<default>")
        for row in ds:
            if not isinstance(row, dict):
                continue
            item_texts = list(iter_text_values(row, text_fields))
            if not item_texts:
                continue
            # Canary = the concatenated normalized item.
            combined = normalize_for_match("\n".join(item_texts))
            if combined:
                canary_pool.append(combined)
            for text in item_texts:
                grams = emit_grams(text)
                word.update(grams.get("word", []))
                char.update(grams.get("char", []))
                tword.update(grams.get("translit_word", []))
                tchar.update(grams.get("translit_char", []))
            items += 1
            if items >= item_cap:
                capped = True
                break
        if capped:
            break

    return {
        "word": word,
        "char": char,
        "tword": tword,
        "tchar": tchar,
        "canary_pool": canary_pool,
        "items": items,
        "capped": capped,
        "used_configs": sorted(set(used_configs)),
    }


def build_indicgenbench(
    repo: str,
    revision: str | None,
    text_fields: list[str],
    item_cap: int,
) -> dict:
    """Load an IndicGenBench custom-JSON repo (test files only).

    Each *_test.json holds {"canary": "<GUID banner>", "examples": [ {..}, ]}.
    We register the embedded canary GUID as a real canary and hash grams from
    the requested text fields of every example.
    """
    from huggingface_hub import HfApi, hf_hub_download

    word: set[str] = set()
    char: set[str] = set()
    tword: set[str] = set()
    tchar: set[str] = set()
    canary_pool: list[str] = []
    embedded_canaries: set[str] = set()
    items = 0
    capped = False
    used_files: list[str] = []

    api = HfApi()
    info = api.dataset_info(repo, revision=revision)
    test_files = sorted(
        s.rfilename
        for s in info.siblings
        if s.rfilename.endswith("_test.json")
    )
    for fname in test_files:
        try:
            local = hf_hub_download(
                repo, fname, repo_type="dataset", revision=revision
            )
            with open(local, encoding="utf-8") as handle:
                doc = json.load(handle)
        except Exception as exc:  # noqa: BLE001
            log(f"    ! failed {repo}:{fname}: {exc!r}")
            continue
        used_files.append(fname)
        if isinstance(doc, dict) and isinstance(doc.get("canary"), str):
            embedded_canaries.add(doc["canary"])
        examples = doc.get("examples", []) if isinstance(doc, dict) else doc
        for row in examples:
            if not isinstance(row, dict):
                continue
            item_texts = list(iter_text_values(row, text_fields))
            if not item_texts:
                continue
            combined = normalize_for_match("\n".join(item_texts))
            if combined:
                canary_pool.append(combined)
            for text in item_texts:
                grams = emit_grams(text)
                word.update(grams.get("word", []))
                char.update(grams.get("char", []))
                tword.update(grams.get("translit_word", []))
                tchar.update(grams.get("translit_char", []))
            items += 1
            if items >= item_cap:
                capped = True
                break
        if capped:
            break

    # Ensure the embedded GUID banners are always retained as canaries.
    for banner in embedded_canaries:
        canary_pool.append(normalize_for_match(banner))

    return {
        "word": word,
        "char": char,
        "tword": tword,
        "tchar": tchar,
        "canary_pool": canary_pool,
        "items": items,
        "capped": capped,
        "used_configs": sorted(set(used_files)),
    }


def select_canaries(canary_pool: list[str]) -> list[dict]:
    """Deterministically pick up to CANARIES_PER_BENCHMARK distinctive items.

    Distinctiveness proxy: longest normalized items (more unique), tie-broken by
    the item hash for stability. Stored hashed + preview only.
    """
    uniq = sorted(set(canary_pool))
    # Rank: longer items first, then by sha256 of the item for a stable tiebreak.
    ranked = sorted(
        uniq,
        key=lambda s: (-len(s), hashlib.sha256(s.encode("utf-8")).hexdigest()),
    )
    chosen = ranked[:CANARIES_PER_BENCHMARK]
    records = [canary_record(s) for s in chosen]
    # Sort final records by hash for byte-stable output.
    return sorted(records, key=lambda r: r["hash"])


def write_shard(bid: str, acc: dict) -> tuple[Path, str, dict]:
    """Write a shard file deterministically. Returns (path, sha256, counts)."""
    canaries = select_canaries(acc["canary_pool"])
    shard = {
        "benchmark_id": bid,
        "registry_format_version": REGISTRY_FORMAT_VERSION,
        "word_ngram_n": WORD_NGRAM_N,
        "char_ngram_n": CHAR_NGRAM_N,
        "hash_hex_width": HASH_HEX_WIDTH,
        "word_grams": sorted(acc["word"]),
        "char_grams": sorted(acc["char"]),
        "translit_word_grams": sorted(acc["tword"]),
        "translit_char_grams": sorted(acc["tchar"]),
        "canaries": canaries,
    }
    SHARDS_DIR.mkdir(parents=True, exist_ok=True)
    path = SHARDS_DIR / f"{bid}.json"
    # No timestamps anywhere in the shard. sort_keys for byte stability.
    payload = json.dumps(shard, ensure_ascii=False, sort_keys=True, indent=0) + "\n"
    path.write_text(payload, encoding="utf-8")
    sha = hashlib.sha256(payload.encode("utf-8")).hexdigest()
    counts = {
        "word_grams": len(shard["word_grams"]),
        "char_grams": len(shard["char_grams"]),
        "translit_word_grams": len(shard["translit_word_grams"]),
        "translit_char_grams": len(shard["translit_char_grams"]),
        "canaries": len(canaries),
        "items_processed": acc["items"],
        "capped": acc["capped"],
        "used_configs": acc["used_configs"],
    }
    return path, sha, counts


def build(item_cap: int, bharateval_repo: str | None, only: set[str] | None) -> dict:
    benchmarks_manifest: list[dict] = []
    for src in BENCHMARK_SOURCES:
        bid = src["id"]
        if only and bid not in only:
            continue
        log(f"== {bid}: {src['note']}")

        # Resolve repo + candidates.
        repo = src.get("repo")
        if bid == "BharatEval" and bharateval_repo:
            repo = bharateval_repo
        repo_candidates = src.get("repo_candidates")

        chosen_repo = None
        revision = None
        if repo:
            revision = resolve_commit(repo)
            if revision:
                chosen_repo = repo
        elif repo_candidates:
            for cand in repo_candidates:
                rev = resolve_commit(cand)
                if rev:
                    chosen_repo = cand
                    revision = rev
                    break

        if not chosen_repo:
            reason = (
                "no HF repo id supplied; supply via --bharateval-repo"
                if bid == "BharatEval"
                else "no reachable source repo resolved (all candidates failed)"
            )
            log(f"   -> UNAVAILABLE: {reason}")
            benchmarks_manifest.append(
                {
                    "id": bid,
                    "status": "UNAVAILABLE",
                    "note": src["note"],
                    "reason": reason,
                    "candidates_tried": repo_candidates or ([repo] if repo else []),
                }
            )
            continue

        log(f"   repo={chosen_repo} revision={revision}")
        acc_total = {
            "word": set(),
            "char": set(),
            "tword": set(),
            "tchar": set(),
            "canary_pool": [],
            "items": 0,
            "capped": False,
            "used_configs": [],
        }
        try:
            if src.get("loader") == "indicgenbench_json":
                acc = build_indicgenbench(
                    chosen_repo,
                    revision,
                    src["text_fields"],
                    item_cap,
                )
            else:
                acc = build_shard_for_repo(
                    chosen_repo,
                    revision,
                    src["configs"],
                    src["split"],
                    src["text_fields"],
                    item_cap,
                )
        except Exception as exc:  # noqa: BLE001
            log(f"   ! build error for {bid}: {exc!r}")
            traceback.print_exc()
            benchmarks_manifest.append(
                {
                    "id": bid,
                    "status": "UNAVAILABLE",
                    "note": src["note"],
                    "reason": f"exception during build: {exc!r}",
                    "repo": chosen_repo,
                    "revision": revision,
                }
            )
            continue

        for key in ("word", "char", "tword", "tchar"):
            acc_total[key].update(acc[key])
        acc_total["canary_pool"].extend(acc["canary_pool"])
        acc_total["items"] += acc["items"]
        acc_total["capped"] = acc_total["capped"] or acc["capped"]
        acc_total["used_configs"] = acc["used_configs"]

        if acc_total["items"] == 0:
            log(f"   -> UNAVAILABLE: repo resolved but zero items extracted")
            benchmarks_manifest.append(
                {
                    "id": bid,
                    "status": "UNAVAILABLE",
                    "note": src["note"],
                    "reason": "repo resolved but zero eval items extracted",
                    "repo": chosen_repo,
                    "revision": revision,
                }
            )
            continue

        path, sha, counts = write_shard(bid, acc_total)
        log(
            f"   -> INSTALLED items={counts['items_processed']} "
            f"word={counts['word_grams']} char={counts['char_grams']} "
            f"tword={counts['translit_word_grams']} canaries={counts['canaries']} "
            f"capped={counts['capped']}"
        )
        benchmarks_manifest.append(
            {
                "id": bid,
                "status": "INSTALLED",
                "note": src["note"],
                "repo": chosen_repo,
                "revision": revision,
                "split": src["split"],
                "text_fields": src["text_fields"],
                "item_cap": item_cap,
                "shard": f"shards/{bid}.json",
                "shard_sha256": sha,
                "counts": counts,
            }
        )

    return {"benchmarks": benchmarks_manifest}


def main() -> int:
    parser = argparse.ArgumentParser(description="Build ERA benchmark registry")
    parser.add_argument("--item-cap", type=int, default=DEFAULT_ITEM_CAP)
    parser.add_argument("--bharateval-repo", default=os.environ.get("ERA_BHARATEVAL_REPO"))
    parser.add_argument(
        "--only",
        default=None,
        help="Comma-separated benchmark ids to build (default: all).",
    )
    args = parser.parse_args()
    only = set(x.strip() for x in args.only.split(",")) if args.only else None

    log(f"ERA benchmark registry builder — format v{REGISTRY_FORMAT_VERSION}")
    log(f"registry_dir={REGISTRY_DIR}")

    result = build(args.item_cap, args.bharateval_repo, only)

    installed = [b for b in result["benchmarks"] if b["status"] == "INSTALLED"]
    unavailable = [b for b in result["benchmarks"] if b["status"] != "INSTALLED"]

    manifest = {
        "registry_format_version": REGISTRY_FORMAT_VERSION,
        "policy_note": (
            "Protected benchmark registry for ERA Phase 1 decontamination. "
            "Detections are CANDIDATES/ANNOTATIONS only; benchmark-contamination "
            "holdout is a user policy decision. No raw benchmark text is stored: "
            "n-grams are truncated SHA-256 (64-bit) hex hashes; canaries store a "
            "full sha256 hash plus an 8-char preview only."
        ),
        "build_timestamp_utc": dt.datetime.now(dt.timezone.utc).isoformat(),
        "hashing": {
            "ngram_hash": "sha256 of normalized n-gram, first 16 hex chars (64-bit)",
            "canary_hash": "sha256 of normalized full item (full 64 hex chars)",
            "canary_preview_chars": CANARY_PREVIEW_CHARS,
            "cross_language": (
                "Python and Node lookup libraries produce byte-identical gram "
                "hashes (sha256-truncated)."
            ),
        },
        "ngram": {"word_ngram_n": WORD_NGRAM_N, "char_ngram_n": CHAR_NGRAM_N},
        "normalization": (
            "NFC -> casefold -> strip invisible/bidi noise (U+200B, U+200E/F, "
            "U+202A-U+202E, U+2066-U+2069, U+FEFF, C0/C1) -> collapse whitespace "
            "-> trim. ZWNJ (U+200C) and ZWJ (U+200D) are PRESERVED. Char n-grams "
            "computed on whitespace-stripped normalized text."
        ),
        "transliteration_scheme": DEVANAGARI_TRANSLIT_SCHEME,
        "transliteration_note": (
            "Devanagari->Latin only in this build. Other Brahmic scripts are "
            "hashed in their native form (char n-grams) but not romanized; "
            "per-script romanization tables are a known future extension."
        ),
        "summary": {
            "installed": sorted(b["id"] for b in installed),
            "unavailable": sorted(b["id"] for b in unavailable),
            "total_word_grams": sum(b["counts"]["word_grams"] for b in installed),
            "total_char_grams": sum(b["counts"]["char_grams"] for b in installed),
            "total_canaries": sum(b["counts"]["canaries"] for b in installed),
        },
        "benchmarks": result["benchmarks"],
    }
    manifest_path = REGISTRY_DIR / "manifest.json"
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, sort_keys=True, indent=2) + "\n",
        encoding="utf-8",
    )
    log("")
    log(f"manifest written: {manifest_path}")
    log(f"installed: {manifest['summary']['installed']}")
    log(f"unavailable: {manifest['summary']['unavailable']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
