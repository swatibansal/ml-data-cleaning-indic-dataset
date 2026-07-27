#!/usr/bin/env python3
"""Validator for regenerated inspection samples.

Checks, per component, exactly the two failure classes that blocked the
originals plus a manifest reconciliation:
  (a) SHA-256 of each file matches the manifest.
  (b) Parquet footer magic bytes 'PAR1' present at BOTH ends and the file is
      readable end-to-end by pyarrow, with row count matching the manifest.
Exit non-zero if any check fails.
"""
from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

import pyarrow.parquet as pq

OUT_ROOT = Path("ERA_Regenerated_Samples_2026-07-25")
COMPONENTS = ["Indic_ShareLlama", "WikiHow"]
MAGIC = b"PAR1"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def check_component(component: str) -> bool:
    d = OUT_ROOT / component
    manifest = json.loads((d / "SAMPLE_MANIFEST.json").read_text())
    ok = True
    print(f"=== {component} ===")
    for fname, meta in manifest["files"].items():
        p = d / fname
        if not p.exists():
            print(f"  [FAIL] {fname}: missing"); ok = False; continue

        # (a) SHA-256
        actual = sha256_file(p)
        if actual == meta["sha256"]:
            print(f"  [PASS] {fname}: sha256 matches manifest")
        else:
            print(f"  [FAIL] {fname}: sha256 {actual} != {meta['sha256']}"); ok = False

        # (b1) footer magic at both ends
        with p.open("rb") as fh:
            head = fh.read(4)
            fh.seek(-4, 2)
            tail = fh.read(4)
        if head == MAGIC and tail == MAGIC:
            print(f"  [PASS] {fname}: PAR1 magic present head+tail")
        else:
            print(f"  [FAIL] {fname}: bad magic head={head!r} tail={tail!r}"); ok = False

        # (b2) full pyarrow read + row count
        try:
            pf = pq.ParquetFile(p)
            n = pf.metadata.num_rows
            table = pf.read()  # end-to-end
            if n == table.num_rows == meta["rows"] == manifest["sample_rows"]:
                print(f"  [PASS] {fname}: readable end-to-end, rows={n} match manifest")
            else:
                print(f"  [FAIL] {fname}: row mismatch meta_footer={n} "
                      f"read={table.num_rows} manifest_file={meta['rows']} "
                      f"manifest_sample={manifest['sample_rows']}"); ok = False
        except Exception as e:  # noqa: BLE001
            print(f"  [FAIL] {fname}: pyarrow read error {type(e).__name__}: {e}"); ok = False

    # selection-rule reconciliation
    if manifest.get("selection_rule") == "deterministic_source_order_prefix":
        print("  [PASS] selection_rule = deterministic_source_order_prefix")
    else:
        print(f"  [FAIL] selection_rule = {manifest.get('selection_rule')}"); ok = False
    return ok


def main() -> int:
    all_ok = all(check_component(c) for c in COMPONENTS)
    print()
    if all_ok:
        print("VALIDATION: PASS")
        return 0
    print("VALIDATION: FAIL")
    return 1


if __name__ == "__main__":
    sys.exit(main())
