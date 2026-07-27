#!/usr/bin/env python3
"""ERA Phase 1 — benchmark registry verification.

Loads the built registry, verifies every INSTALLED shard's SHA-256 against the
manifest, checks the registry-format version, loads all hash sets, and prints
per-benchmark counts. Exit code 0 on success, non-zero on any mismatch.

Run: .venv-indowordnet/bin/python benchmark_registry/verify_registry.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE / "lib"))

from era_lookup import ContaminationScanner, RegistryError  # noqa: E402


def main() -> int:
    registry_dir = _HERE
    manifest_path = registry_dir / "manifest.json"
    if not manifest_path.exists():
        print(f"FAIL: no manifest at {manifest_path}")
        return 2
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

    print(f"registry_format_version: {manifest.get('registry_format_version')}")
    print(f"build_timestamp_utc: {manifest.get('build_timestamp_utc')}")
    print(f"transliteration_scheme: {manifest.get('transliteration_scheme')}")
    print("")

    try:
        # verify_hashes=True forces per-shard SHA-256 checks during load.
        scanner = ContaminationScanner(registry_dir, verify_hashes=True)
    except RegistryError as exc:
        print(f"FAIL: registry load/verify error: {exc}")
        return 3

    print("Per-benchmark status:")
    installed = 0
    unavailable = 0
    for entry in manifest.get("benchmarks", []):
        bid = entry["id"]
        status = entry["status"]
        if status == "INSTALLED":
            installed += 1
            c = entry["counts"]
            print(
                f"  [INSTALLED]   {bid:16s} repo={entry['repo']} rev={entry['revision'][:12]} "
                f"items={c['items_processed']} word={c['word_grams']} "
                f"char={c['char_grams']} tword={c['translit_word_grams']} "
                f"tchar={c['translit_char_grams']} canaries={c['canaries']} "
                f"capped={c['capped']}"
            )
        else:
            unavailable += 1
            print(f"  [UNAVAILABLE] {bid:16s} reason={entry.get('reason')}")

    print("")
    print(f"installed benchmarks loaded by scanner: {scanner.installed_benchmarks()}")
    print(f"summary: installed={installed} unavailable={unavailable}")
    print(f"total_word_grams={manifest['summary'].get('total_word_grams')} "
          f"total_char_grams={manifest['summary'].get('total_char_grams')} "
          f"total_canaries={manifest['summary'].get('total_canaries')}")
    print("")
    print("OK: all INSTALLED shard SHA-256s verified against manifest.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
