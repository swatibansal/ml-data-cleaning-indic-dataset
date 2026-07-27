"""ERA Phase 1 — protected benchmark registry lookup / matching module.

Loads a built registry (manifest + per-benchmark shards), verifies shard
SHA-256s against the manifest, and provides a ``ContaminationScanner`` that maps
input text -> normalized -> n-gram hashes -> hash-set lookup -> contamination
annotation.

Contract (aligned with CLAUDE.md frozen decisions):
- Detections are CANDIDATES / ANNOTATIONS only. This module never deletes,
  never auto-holds-out, and returns counts + per-benchmark overlap only.
- No raw candidate text or raw benchmark text is emitted -- only which
  benchmarks matched, how many grams overlapped, and gram-type breakdown.
- Deterministic: same registry + same input -> same annotation.

A conversation/record is annotated as a benchmark-contamination CANDIDATE when
its normalized text shares protected n-gram hashes with any benchmark above the
configured thresholds. The holdout decision is a USER policy decision; this
module only surfaces candidates.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

from era_decontam import (
    REGISTRY_FORMAT_VERSION,
    canary_record,
    emit_grams,
    normalize_for_match,
)

# Minimum distinct protected-gram hash overlaps to flag a candidate. Word-gram
# overlap is the primary signal; a single 8-gram word overlap is already a
# strong contamination signal for eval items. Char/translit overlaps require a
# higher count because short char-grams collide more.
DEFAULT_WORD_GRAM_THRESHOLD = 1
DEFAULT_CHAR_GRAM_THRESHOLD = 10


class RegistryError(RuntimeError):
    pass


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


class ContaminationScanner:
    """Loads a registry directory and scans text for benchmark contamination."""

    def __init__(
        self,
        registry_dir: str | Path,
        word_threshold: int = DEFAULT_WORD_GRAM_THRESHOLD,
        char_threshold: int = DEFAULT_CHAR_GRAM_THRESHOLD,
        verify_hashes: bool = True,
    ) -> None:
        self.registry_dir = Path(registry_dir)
        self.word_threshold = word_threshold
        self.char_threshold = char_threshold
        self.manifest = self._load_manifest()
        # Per-benchmark hash sets, keyed by benchmark id then gram-type.
        self._word: dict[str, set[str]] = {}
        self._char: dict[str, set[str]] = {}
        self._canaries: dict[str, set[str]] = {}
        self._load_shards(verify_hashes)

    def _load_manifest(self) -> dict[str, Any]:
        manifest_path = self.registry_dir / "manifest.json"
        if not manifest_path.exists():
            raise RegistryError(f"manifest not found: {manifest_path}")
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        fmt = str(manifest.get("registry_format_version"))
        if fmt != REGISTRY_FORMAT_VERSION:
            raise RegistryError(
                f"registry format version mismatch: manifest={fmt} "
                f"library={REGISTRY_FORMAT_VERSION}"
            )
        return manifest

    def _load_shards(self, verify_hashes: bool) -> None:
        for entry in self.manifest.get("benchmarks", []):
            if entry.get("status") != "INSTALLED":
                continue
            bid = entry["id"]
            shard_rel = entry["shard"]
            shard_path = self.registry_dir / shard_rel
            if not shard_path.exists():
                raise RegistryError(f"shard missing for {bid}: {shard_path}")
            if verify_hashes:
                actual = _sha256_file(shard_path)
                if actual != entry["shard_sha256"]:
                    raise RegistryError(
                        f"shard SHA-256 mismatch for {bid}: "
                        f"manifest={entry['shard_sha256']} actual={actual}"
                    )
            shard = json.loads(shard_path.read_text(encoding="utf-8"))
            word: set[str] = set(shard.get("word_grams", []))
            word.update(shard.get("translit_word_grams", []))
            char: set[str] = set(shard.get("char_grams", []))
            char.update(shard.get("translit_char_grams", []))
            self._word[bid] = word
            self._char[bid] = char
            self._canaries[bid] = {
                c["hash"] for c in shard.get("canaries", [])
            }

    def installed_benchmarks(self) -> list[str]:
        return sorted(self._word)

    def scan_text(self, text: str) -> dict[str, Any]:
        """Scan a single text blob. Returns a candidate annotation (no raw text)."""
        grams = emit_grams(text)
        query_word = set(grams.get("word", [])) | set(grams.get("translit_word", []))
        query_char = set(grams.get("char", [])) | set(grams.get("translit_char", []))
        norm = normalize_for_match(text)
        canary_hash = canary_record(norm)["hash"] if norm else None

        matches: list[dict[str, Any]] = []
        for bid in self.installed_benchmarks():
            word_hits = len(query_word & self._word.get(bid, set()))
            char_hits = len(query_char & self._char.get(bid, set()))
            canary_hit = bool(canary_hash and canary_hash in self._canaries.get(bid, set()))
            flagged = (
                canary_hit
                or word_hits >= self.word_threshold
                or char_hits >= self.char_threshold
            )
            if flagged:
                matches.append(
                    {
                        "benchmark": bid,
                        "word_gram_overlaps": word_hits,
                        "char_gram_overlaps": char_hits,
                        "canary_exact": canary_hit,
                    }
                )
        return {
            "is_candidate": bool(matches),
            "matched_benchmarks": [m["benchmark"] for m in matches],
            "detail": matches,
        }

    def scan_conversation(self, texts: list[str]) -> dict[str, Any]:
        """Scan a whole conversation (list of turn texts) as one blob.

        Matches the pipeline's "whole conversation" dedup granularity.
        """
        combined = "\n".join(t for t in texts if isinstance(t, str))
        return self.scan_text(combined)
