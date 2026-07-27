#!/usr/bin/env python3
"""Regenerate Indic_ShareLlama and WikiHow inspection samples.

Frozen decisions honored (see CLAUDE.md):
  * Pinned source revision only.
  * Deterministic source-order PREFIX selection (first N rows in the
    source file's physical row order) -- NOT random sampling.
  * Alternative multilingual paths are preserved, never merged: the raw HF
    schema (including repeated `element` columns) is written verbatim.
  * Deterministic output: fixed row order, no timestamps embedded in data
    files, stable pyarrow write settings.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq
from huggingface_hub import hf_hub_download

REPO_ID = "ai4bharat/indic-align"
REVISION = "032b6a9070e7f85f1a38e0506419f4590a20455a"
SAMPLE_SIZE = 10_000
OUT_ROOT = Path("ERA_Regenerated_Samples_2026-07-25")

COMPONENTS = {
    "Indic_ShareLlama": "indicalign-instruct/indicsharellama/indic_sharellama.parquet",
    "WikiHow": "indicalign-instruct/wikihow/wiki_how.parquet",
}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def regenerate(component: str, repo_path: str) -> dict:
    out_dir = OUT_ROOT / component
    out_dir.mkdir(parents=True, exist_ok=True)

    local = hf_hub_download(
        REPO_ID, repo_path, repo_type="dataset", revision=REVISION
    )
    src = pq.ParquetFile(local)
    source_rows = src.metadata.num_rows
    source_sha = sha256_file(Path(local))

    sample_rows = min(SAMPLE_SIZE, source_rows)

    # Deterministic source-order prefix: read the full table (single row
    # group) then slice the first N rows in physical order.
    table = src.read()
    sample = table.slice(0, sample_rows)

    # Preserve the raw schema verbatim (duplicate `element` columns are the
    # alternative multilingual paths; do not rename or merge them).
    sample_path = out_dir / "SAMPLE_10K.parquet"
    pq.write_table(
        sample,
        sample_path,
        compression="zstd",
        # No stats-based nondeterminism concerns for our validator; keep
        # settings explicit and stable so re-runs are byte-identical.
        write_statistics=True,
        store_schema=True,
    )
    # Ensure the footer is flushed to disk before hashing.
    with open(sample_path, "rb") as fh:
        import os

        os.fsync(fh.fileno())

    sample_sha = sha256_file(sample_path)

    # Re-open to confirm footer + full read.
    check = pq.ParquetFile(sample_path)
    assert check.metadata.num_rows == sample_rows, "row count mismatch after write"
    _ = check.read()  # full end-to-end read

    manifest = {
        "component": component,
        "repository_id": REPO_ID,
        "revision": REVISION,
        "repo_source_path": repo_path,
        "selection_rule": "deterministic_source_order_prefix",
        "selection_detail": (
            "first N rows in the source Parquet file's physical row order "
            "at the pinned revision"
        ),
        "source_rows": source_rows,
        "sample_rows": sample_rows,
        "first_selected_source_index": 0,
        "last_selected_source_index": sample_rows - 1,
        "source_parquet_sha256": source_sha,
        "columns": list(table.schema.names),
        "n_columns": len(table.schema.names),
        "files": {
            "SAMPLE_10K.parquet": {
                "sha256": sample_sha,
                "bytes": sample_path.stat().st_size,
                "rows": sample_rows,
            }
        },
    }
    (out_dir / "SAMPLE_MANIFEST.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(f"[{component}] wrote {sample_path} ({sample_path.stat().st_size:,} bytes)")
    return manifest


def main() -> None:
    OUT_ROOT.mkdir(parents=True, exist_ok=True)
    for component, repo_path in COMPONENTS.items():
        regenerate(component, repo_path)
    print("DONE")


if __name__ == "__main__":
    main()
