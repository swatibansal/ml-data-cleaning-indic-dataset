#!/usr/bin/env python3
"""Restartable ERA Policy-v2 rehearsal for 1M IndoWordNet rows."""

from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import gzip
import hashlib
import html
import io
import itertools
import json
import os
import re
import resource
import shutil
import sqlite3
import sys
import time
import unicodedata
from collections import Counter
from pathlib import Path
from typing import Any, Iterable, Iterator, TextIO


REPO_ID = "ai4bharat/indic-align"
REVISION = "032b6a9070e7f85f1a38e0506419f4590a20455a"
CONFIG_ALIASES = ("IndoWordNet", "indo_word_net", "indowordnet")
DEFAULT_ROWS = 1_000_000
DEFAULT_CHUNK_SIZE = 100_000
POLICY_VERSION = "ERA-IndoWordNet-policy-v2.1"
SEED = 20260724

# --- Benchmark decontamination two-tier policy (policy v1, user-approved 2026-07-25) ---
# Whole-conversation scan against the protected benchmark registry. Tier 1
# (auto-holdout): a canary exact match OR >= BENCHMARK_TIER1_WORD_GRAMS distinct
# matching word 8-grams (native or transliterated) in one conversation routes the
# unit to the reversible "benchmark_holdout" category. Tier 2 (annotate only):
# 1..(TIER1-1) matching word 8-grams and no canary hit retains the unit and is
# recorded as a benchmark_overlap_candidate in the REPORT ONLY (aggregate counts,
# never raw matched text; the retained/holdout/candidate streams are untouched so
# a tier-1-free run stays byte-identical to the pre-decontamination run).
# The policy is defined strictly on WORD 8-gram overlaps + canary hits; char
# 5-gram overlaps are reported by the scanner but never used for tiering (Indic
# char 5-grams collide incidentally at high volume). Mirrors the Node pilot
# constants in era-auto-route.mjs.
BENCHMARK_TIER1_WORD_GRAMS = 3
BENCHMARK_TIER2_MIN_WORD_GRAMS = 1
BENCHMARK_POLICY_REASON = "benchmark_decontamination_policy_v1_2026-07-25"

# Construct the contamination scanner once, guarded so that an absent or broken
# registry degrades gracefully to the current NOT RUN state (never crashes, never
# silently skips). BENCH_SCANNER is None => stage NOT RUN + blocker.
import sys as _sys
_REGISTRY_DIR = Path(__file__).resolve().parents[1] / "benchmark_registry"
_sys.path.insert(0, str(_REGISTRY_DIR / "lib"))
BENCH_SCANNER = None
BENCH_SCANNER_BLOCKER = "benchmark registry not installed"
try:
    if (_REGISTRY_DIR / "manifest.json").exists():
        from era_lookup import ContaminationScanner

        BENCH_SCANNER = ContaminationScanner(str(_REGISTRY_DIR))
        BENCH_SCANNER_BLOCKER = None
except Exception as _exc:  # pragma: no cover - defensive; degrade to NOT RUN
    BENCH_SCANNER = None
    BENCH_SCANNER_BLOCKER = f"benchmark registry failed to load: {_exc}"

NOISE_RE = re.compile(
    "[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f"
    "\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]"
)
SPACE_RE = re.compile(r"\s+")
EMAIL_RE = re.compile(r"(?<![\w.+-])[\w.+-]+@[\w-]+(?:\.[\w-]+)+")
PHONE_RE = re.compile(
    r"(?<!\d)(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)|\d{2,4})"
    r"[\s.-]\d{3,4}[\s.-]\d{4}(?!\d)"
)
SECRET_PATTERNS = {
    "aws_access_key": re.compile(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b"),
    "private_key": re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    "github_token": re.compile(r"\bgh[pousr]_[A-Za-z0-9]{30,255}\b"),
}
EXPECTED_SCRIPTS = {
    "as": ("BENGALI",),
    "bn": ("BENGALI",),
    "brx": ("DEVANAGARI",),
    "gu": ("GUJARATI",),
    "hi": ("DEVANAGARI",),
    "kn": ("KANNADA",),
    "kok": ("DEVANAGARI",),
    "ks": ("ARABIC", "DEVANAGARI"),
    "ml": ("MALAYALAM",),
    "mni": ("BENGALI", "MEETEI MAYEK"),
    "mr": ("DEVANAGARI",),
    "ne": ("DEVANAGARI",),
    "or": ("ORIYA", "ODIA"),
    "pa": ("GURMUKHI",),
    "sa": ("DEVANAGARI",),
    "ta": ("TAMIL",),
    "te": ("TELUGU",),
    "ur": ("ARABIC",),
}


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def stable_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def atomic_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n",
        encoding="utf-8",
    )
    os.replace(temporary, path)


@contextlib.contextmanager
def deterministic_gzip_text(path: Path) -> Iterator[TextIO]:
    path.parent.mkdir(parents=True, exist_ok=True)
    raw = path.open("wb")
    zipped = gzip.GzipFile(filename="", mode="wb", fileobj=raw, compresslevel=6, mtime=0)
    text = io.TextIOWrapper(zipped, encoding="utf-8", newline="\n")
    try:
        yield text
    finally:
        text.flush()
        text.close()
        raw.close()


def clean_text(value: Any) -> tuple[str, dict[str, bool]]:
    if not isinstance(value, str):
        raise TypeError("text is not a string")
    original = value
    nfc = unicodedata.normalize("NFC", original)
    decoded = html.unescape(nfc)
    no_replacement = decoded.replace("\ufffd", "")
    no_noise = NOISE_RE.sub("", no_replacement)
    cleaned = SPACE_RE.sub(" ", no_noise).strip()
    return cleaned, {
        "nfc_changed": nfc != original,
        "html_unescaped": decoded != nfc,
        "replacement_removed": no_replacement != decoded,
        "noise_removed": no_noise != no_replacement,
        "whitespace_changed": cleaned != no_noise,
        "any_changed": cleaned != original,
    }


def extract_pair(row: dict[str, Any]) -> tuple[str, str]:
    interactions = row.get("interactions")
    if (
        isinstance(interactions, (list, tuple))
        and len(interactions) == 1
        and isinstance(interactions[0], (list, tuple))
    ):
        interactions = interactions[0]
    if not isinstance(interactions, (list, tuple)) or len(interactions) != 2:
        raise ValueError("interactions must contain exactly one prompt/response pair")
    prompt, response = interactions
    if not isinstance(prompt, str) or not isinstance(response, str):
        raise ValueError("prompt and response must both be strings")
    return prompt, response


def char_ngrams(text: str, n: int = 5) -> set[str]:
    text = text.casefold()
    if len(text) <= n:
        return {text} if text else set()
    return {text[i : i + n] for i in range(len(text) - n + 1)}


def jaccard_5gram(left: str, right: str) -> float:
    a, b = char_ngrams(left), char_ngrams(right)
    if not a and not b:
        return 1.0
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def simhash64(text: str) -> int:
    grams = char_ngrams(text)
    if not grams:
        return 0
    vector = [0] * 64
    for gram in grams:
        value = int.from_bytes(
            hashlib.blake2b(gram.encode("utf-8"), digest_size=8).digest(), "big"
        )
        for bit in range(64):
            vector[bit] += 1 if value & (1 << bit) else -1
    result = 0
    for bit, score in enumerate(vector):
        if score >= 0:
            result |= 1 << bit
    return result


def hamming64(left: int, right: int) -> int:
    return (left ^ right).bit_count()


def band_values(value: int) -> list[tuple[int, int]]:
    return [(band, (value >> (band * 16)) & 0xFFFF) for band in range(4)]


def repeated_sentence_holdout(response: str) -> bool:
    sentences = [
        SPACE_RE.sub(" ", part).strip().casefold()
        for part in re.split(r"(?<=[.!?।])\s+", response)
        if part.strip()
    ]
    if len(sentences) < 4:
        return False
    counts = Counter(sentences)
    repeated, count = counts.most_common(1)[0]
    repeated_chars = len(repeated) * count
    return count >= 4 and repeated_chars / max(1, len(response)) >= 0.60


def privacy_findings(text: str) -> list[str]:
    findings = []
    if EMAIL_RE.search(text):
        findings.append("email")
    if PHONE_RE.search(text):
        findings.append("phone")
    return findings


def secret_findings(text: str) -> list[str]:
    return [name for name, pattern in SECRET_PATTERNS.items() if pattern.search(text)]


def benchmark_scan(prompt: str, response: str) -> dict[str, Any] | None:
    """Whole-conversation benchmark contamination scan (annotation only here).

    Returns None when the registry is unavailable (stage NOT RUN) or when no word
    8-gram / canary overlap is found. Otherwise returns the tier (1 or 2) and the
    per-benchmark word-gram overlap counts, plus which benchmarks were hit. No raw
    matched text is ever returned. Char 5-gram overlaps are reported by the scanner
    but deliberately not used for tiering (see policy note near the constants).
    """
    if BENCH_SCANNER is None:
        return None
    scan = BENCH_SCANNER.scan_conversation([prompt, response])
    word_matches = [
        detail
        for detail in scan["detail"]
        if detail["canary_exact"] or detail["word_gram_overlaps"] > 0
    ]
    if not word_matches:
        return None
    matched_benchmarks = sorted(detail["benchmark"] for detail in word_matches)
    max_word_grams = max(detail["word_gram_overlaps"] for detail in word_matches)
    any_canary = any(detail["canary_exact"] for detail in word_matches)
    tier = 1 if (any_canary or max_word_grams >= BENCHMARK_TIER1_WORD_GRAMS) else 2
    return {
        "tier": tier,
        "matched_benchmarks": matched_benchmarks,
        "canary_exact": any_canary,
        "max_word_gram_overlaps": max_word_grams,
        "per_benchmark_word_gram_overlaps": {
            detail["benchmark"]: detail["word_gram_overlaps"] for detail in word_matches
        },
    }


def script_annotation(language: str, text: str) -> dict[str, Any] | None:
    expected = EXPECTED_SCRIPTS.get(language)
    if not expected:
        return None
    letters = [char for char in text if char.isalpha()]
    if len(letters) < 20:
        return None
    expected_count = 0
    latin_count = 0
    for char in letters:
        name = unicodedata.name(char, "")
        if any(script in name for script in expected):
            expected_count += 1
        if "LATIN" in name:
            latin_count += 1
    expected_ratio = expected_count / len(letters)
    latin_ratio = latin_count / len(letters)
    if expected_ratio >= 0.50 or latin_ratio < 0.80:
        return None
    return {
        "type": "language_script_anomaly",
        "expected_scripts": list(expected),
        "letter_count": len(letters),
        "expected_script_ratio": round(expected_ratio, 6),
        "latin_ratio": round(latin_ratio, 6),
    }


def setup_database(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path)
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA synchronous=FULL")
    db.execute("PRAGMA temp_store=MEMORY")
    db.executescript(
        """
        CREATE TABLE IF NOT EXISTS records (
          record_pk INTEGER PRIMARY KEY AUTOINCREMENT,
          source_index INTEGER NOT NULL UNIQUE,
          record_id TEXT NOT NULL,
          canonical_record_id TEXT NOT NULL,
          language TEXT NOT NULL,
          prompt TEXT NOT NULL,
          response TEXT NOT NULL,
          simhash_hex TEXT NOT NULL,
          disposition TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS exact_keys (
          exact_key TEXT PRIMARY KEY,
          canonical_record_id TEXT NOT NULL,
          canonical_source_index INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS bands (
          language TEXT NOT NULL,
          band_no INTEGER NOT NULL,
          band_value INTEGER NOT NULL,
          record_pk INTEGER NOT NULL,
          FOREIGN KEY(record_pk) REFERENCES records(record_pk)
        );
        CREATE INDEX IF NOT EXISTS idx_bands_lookup
          ON bands(language, band_no, band_value);
        CREATE INDEX IF NOT EXISTS idx_records_canonical
          ON records(canonical_record_id, source_index);
        CREATE TABLE IF NOT EXISTS chunks (
          chunk_no INTEGER PRIMARY KEY,
          start_index INTEGER NOT NULL,
          end_index INTEGER NOT NULL,
          source_rows INTEGER NOT NULL,
          retained INTEGER NOT NULL,
          holdouts INTEGER NOT NULL,
          source_sha256 TEXT NOT NULL,
          retained_sha256 TEXT NOT NULL,
          holdout_sha256 TEXT NOT NULL,
          candidates_sha256 TEXT NOT NULL,
          elapsed_seconds REAL NOT NULL,
          committed_utc TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS benchmark_stats (
          chunk_no INTEGER NOT NULL,
          tier INTEGER NOT NULL,
          benchmark TEXT NOT NULL,
          units INTEGER NOT NULL,
          PRIMARY KEY (chunk_no, tier, benchmark)
        );
        CREATE TABLE IF NOT EXISTS benchmark_distinct (
          chunk_no INTEGER NOT NULL,
          tier INTEGER NOT NULL,
          distinct_units INTEGER NOT NULL,
          PRIMARY KEY (chunk_no, tier)
        );
        """
    )
    return db


def source_stream(source: str | None = None) -> tuple[Iterable[dict[str, Any]], str]:
    if source:
        path = Path(source)

        def rows() -> Iterator[dict[str, Any]]:
            opener = gzip.open if path.suffix == ".gz" else open
            with opener(path, "rt", encoding="utf-8") as handle:
                for line in handle:
                    if line.strip():
                        yield json.loads(line)

        return rows(), f"local:{path.resolve()}"

    try:
        from datasets import get_dataset_config_names, load_dataset
    except ImportError as exc:
        raise RuntimeError("Install requirements.txt before running") from exc

    configs = get_dataset_config_names(REPO_ID, revision=REVISION)
    normalized = {re.sub(r"[^a-z0-9]", "", item.casefold()): item for item in configs}
    config = None
    for alias in CONFIG_ALIASES:
        config = normalized.get(re.sub(r"[^a-z0-9]", "", alias.casefold()))
        if config:
            break
    if not config:
        raise RuntimeError(
            f"Could not resolve IndoWordNet configuration. Available: {configs}"
        )
    dataset = load_dataset(
        REPO_ID,
        name=config,
        split="train",
        revision=REVISION,
        streaming=True,
    )
    return dataset, f"hf://datasets/{REPO_ID}/{config}@{REVISION}"


def candidate_rows(
    db: sqlite3.Connection, language: str, fingerprint: int
) -> list[sqlite3.Row]:
    db.row_factory = sqlite3.Row
    # UNION of one lookup per band so each uses the full
    # (language, band_no, band_value) index; the OR form degrades to
    # scanning every band row for the language. Result set and ORDER BY
    # are identical to the OR form (UNION dedups record_pk like DISTINCT).
    subquery = " UNION ".join(
        "SELECT record_pk FROM bands WHERE language=? AND band_no=? AND band_value=?"
        for _ in range(4)
    )
    params: list[Any] = []
    for band_no, value in band_values(fingerprint):
        params.extend([language, band_no, value])
    query = f"""
      SELECT r.*
      FROM records r
      WHERE r.record_pk IN ({subquery})
      ORDER BY r.source_index ASC
    """
    return list(db.execute(query, params))


def index_record(
    db: sqlite3.Connection,
    *,
    source_index: int,
    record_id: str,
    canonical_record_id: str,
    language: str,
    prompt: str,
    response: str,
    fingerprint: int,
    disposition: str,
    add_bands: bool = True,
) -> None:
    cursor = db.execute(
        """
        INSERT INTO records(
          source_index,record_id,canonical_record_id,language,prompt,response,
          simhash_hex,disposition
        ) VALUES(?,?,?,?,?,?,?,?)
        """,
        (
            source_index,
            record_id,
            canonical_record_id,
            language,
            prompt,
            response,
            f"{fingerprint:016x}",
            disposition,
        ),
    )
    if add_bands:
        db.executemany(
            "INSERT INTO bands(language,band_no,band_value,record_pk) VALUES(?,?,?,?)",
            [(language, no, value, cursor.lastrowid) for no, value in band_values(fingerprint)],
        )


def process_record(
    db: sqlite3.Connection, row: dict[str, Any], source_index: int
) -> tuple[str, dict[str, Any], dict[str, bool]]:
    record_id = str(row.get("id") or f"source-{source_index:09d}")
    language = str(row.get("language") or "").strip().casefold()
    provenance = {
        "source_index": source_index,
        "source_id": record_id,
        "language": language,
    }
    try:
        raw_prompt, raw_response = extract_pair(row)
        prompt, prompt_changes = clean_text(raw_prompt)
        response, response_changes = clean_text(raw_response)
    except (TypeError, ValueError) as exc:
        return "holdout", {
            **provenance,
            "disposition": "structural_holdout",
            "reason": str(exc),
        }, {}
    if not language or not prompt or not response or row.get("num_turns", 1) != 1:
        return "holdout", {
            **provenance,
            "disposition": "structural_holdout",
            "reason": "missing language/text or num_turns is not one",
        }, {}

    combined = f"{prompt}\n{response}"
    secrets = secret_findings(combined)
    if secrets:
        return "holdout", {
            **provenance,
            "disposition": "security_holdout",
            "reason": "supported secret pattern",
            "findings": secrets,
        }, {}
    pii = privacy_findings(combined)
    if pii:
        return "holdout", {
            **provenance,
            "disposition": "privacy_holdout",
            "reason": "supported residual PII pattern",
            "findings": pii,
        }, {}
    if repeated_sentence_holdout(response):
        return "holdout", {
            **provenance,
            "disposition": "repetition_holdout",
            "reason": "sentence repeated >=4 times and occupies >=60% of response",
        }, {}

    exact_key = sha256_text(stable_json([language, prompt, response]))
    existing = db.execute(
        "SELECT canonical_record_id,canonical_source_index FROM exact_keys WHERE exact_key=?",
        (exact_key,),
    ).fetchone()
    if existing:
        return "holdout", {
            **provenance,
            "disposition": "exact_duplicate_holdout",
            "canonical_record_id": existing[0],
            "canonical_source_index": existing[1],
        }, {
            "normalization_changed": prompt_changes["any_changed"]
            or response_changes["any_changed"]
        }

    fingerprint = simhash64(combined)
    annotations = []
    language_annotation = script_annotation(language, combined)
    if language_annotation:
        annotations.append(language_annotation)
    automatic_match = None
    best_candidate = None
    for candidate in candidate_rows(db, language, fingerprint):
        candidate_hash = int(candidate["simhash_hex"], 16)
        distance = hamming64(fingerprint, candidate_hash)
        if distance > 3:
            continue
        similarity = jaccard_5gram(
            combined, f"{candidate['prompt']}\n{candidate['response']}"
        )
        current = {
            "record_id": candidate["record_id"],
            "canonical_record_id": candidate["canonical_record_id"],
            "canonical_source_index": db.execute(
                "SELECT MIN(source_index) FROM records WHERE canonical_record_id=?",
                (candidate["canonical_record_id"],),
            ).fetchone()[0],
            "jaccard_5gram": round(similarity, 8),
            "simhash_hamming": distance,
        }
        if similarity >= 0.95:
            automatic_match = current
            break
        if similarity >= 0.85 and (
            best_candidate is None
            or similarity > best_candidate["jaccard_5gram"]
            or (
                similarity == best_candidate["jaccard_5gram"]
                and candidate["source_index"] < best_candidate["canonical_source_index"]
            )
        ):
            best_candidate = current

    if automatic_match:
        canonical_id = automatic_match["canonical_record_id"]
        index_record(
            db,
            source_index=source_index,
            record_id=record_id,
            canonical_record_id=canonical_id,
            language=language,
            prompt=prompt,
            response=response,
            fingerprint=fingerprint,
            disposition="near_duplicate_holdout",
        )
        db.execute(
            "INSERT INTO exact_keys VALUES(?,?,?)",
            (exact_key, canonical_id, automatic_match["canonical_source_index"]),
        )
        return "holdout", {
            **provenance,
            "disposition": "near_duplicate_holdout",
            **automatic_match,
        }, {
            "normalization_changed": prompt_changes["any_changed"]
            or response_changes["any_changed"]
        }

    # Benchmark decontamination (routing order: exact > near > repetition >
    # benchmark > privacy). The scan runs on records that have survived exact and
    # near dedup, i.e. records that become a fresh canonical for their exact key.
    # A tier-1 hit re-labels the disposition to benchmark_holdout but the record is
    # STILL indexed as canonical (bands + exact_key registered with itself), so the
    # set of records that anchor later dedup is byte-identical to the pre-
    # decontamination pipeline and frozen dedup decisions do not shift. Tier 2 is
    # recorded via a report-only flag and leaves the retained row untouched.
    bench = benchmark_scan(prompt, response)
    bench_tier1 = bench is not None and bench["tier"] == 1
    canonical_id = record_id
    index_record(
        db,
        source_index=source_index,
        record_id=record_id,
        canonical_record_id=canonical_id,
        language=language,
        prompt=prompt,
        response=response,
        fingerprint=fingerprint,
        disposition="benchmark_holdout" if bench_tier1 else "retained",
    )
    db.execute(
        "INSERT INTO exact_keys VALUES(?,?,?)",
        (exact_key, canonical_id, source_index),
    )
    if bench_tier1:
        return "holdout", {
            **provenance,
            "disposition": "benchmark_holdout",
            "canonical_record_id": canonical_id,
            "reason": BENCHMARK_POLICY_REASON,
            "benchmark_tier": 1,
            "matched_benchmarks": bench["matched_benchmarks"],
            "canary_exact": bench["canary_exact"],
            "max_word_gram_overlaps": bench["max_word_gram_overlaps"],
            "per_benchmark_word_gram_overlaps": bench["per_benchmark_word_gram_overlaps"],
        }, {
            "normalization_changed": prompt_changes["any_changed"]
            or response_changes["any_changed"],
            "benchmark_tier1": True,
        }
    if best_candidate:
        annotations.append({
            "type": "near_duplicate_candidate",
            **provenance,
            **best_candidate,
        })
    retained = {
        **provenance,
        "interactions": [[prompt, response]],
        "num_turns": 1,
        "canonical_record_id": canonical_id,
        "annotations": annotations,
    }
    return "retained", retained, {
        "normalization_changed": prompt_changes["any_changed"]
        or response_changes["any_changed"],
        "near_duplicate_candidate": best_candidate is not None,
        "language_script_anomaly": language_annotation is not None,
        "benchmark_tier2": bench is not None and bench["tier"] == 2,
        "benchmark_tier2_benchmarks": (
            bench["matched_benchmarks"] if bench is not None and bench["tier"] == 2 else None
        ),
    }


def recover_committed_outputs(output_dir: Path, db: sqlite3.Connection) -> None:
    chunks_dir = output_dir / "chunks"
    for row in db.execute(
        """
        SELECT chunk_no,retained_sha256,holdout_sha256,candidates_sha256
        FROM chunks ORDER BY chunk_no
        """
    ):
        chunk_no = row[0]
        for label, expected in zip(
            ("retained", "holdouts", "candidates"), row[1:]
        ):
            final = chunks_dir / f"chunk-{chunk_no:05d}.{label}.jsonl.gz"
            temporary = final.with_suffix(final.suffix + ".tmp")
            if not final.exists() and temporary.exists():
                os.replace(temporary, final)
            if not final.exists() or sha256_file(final) != expected:
                raise RuntimeError(f"Committed chunk output missing/corrupt: {final}")
    committed = db.execute("SELECT COALESCE(MAX(chunk_no),-1) FROM chunks").fetchone()[0] + 1
    atomic_json(
        output_dir / "checkpoint.json",
        {"next_chunk": committed, "updated_utc": utc_now(), "policy": POLICY_VERSION},
    )


def write_source_manifest(
    output_dir: Path, source_name: str, rows: int, chunk_size: int
) -> None:
    manifest = {
        "repository_id": REPO_ID,
        "revision": REVISION,
        "resolved_source": source_name,
        "declared_full_component_rows": 96_843_950,
        "declared_source_shards": 10,
        "rehearsal_rows": rows,
        "chunk_size": chunk_size,
        "expected_chunks": (rows + chunk_size - 1) // chunk_size,
        "selection": "deterministic pinned source-order prefix",
        "sampling_seed_reference": SEED,
        "policy": POLICY_VERSION,
        "created_utc": utc_now(),
    }
    atomic_json(output_dir / "manifests" / "source-manifest.json", manifest)


def run(args: argparse.Namespace) -> int:
    output_dir = Path(args.output_dir).resolve()
    for directory in ("chunks", "reports", "manifests", "logs", "state"):
        (output_dir / directory).mkdir(parents=True, exist_ok=True)
    db = setup_database(output_dir / "state" / "global-routing.sqlite")
    recover_committed_outputs(output_dir, db)
    start_chunk = db.execute("SELECT COALESCE(MAX(chunk_no),-1)+1 FROM chunks").fetchone()[0]
    expected_chunks = (args.rows + args.chunk_size - 1) // args.chunk_size
    if start_chunk >= expected_chunks:
        print("All requested chunks are already complete.")
        finalize(output_dir, db, args.rows, args.chunk_size)
        return 0

    stream, source_name = source_stream(args.source_jsonl)
    write_source_manifest(output_dir, source_name, args.rows, args.chunk_size)
    start_index = start_chunk * args.chunk_size
    iterator = itertools.islice(iter(stream), start_index, args.rows)
    chunks_this_run = 0

    for chunk_no in range(start_chunk, expected_chunks):
        if args.max_chunks is not None and chunks_this_run >= args.max_chunks:
            print(f"Stopped cleanly after {chunks_this_run} chunk(s); resume is safe.")
            break
        target = min(args.chunk_size, args.rows - chunk_no * args.chunk_size)
        rows = list(itertools.islice(iterator, target))
        if len(rows) != target:
            raise RuntimeError(
                f"Source ended early in chunk {chunk_no}: expected {target}, got {len(rows)}"
            )
        process_chunk(output_dir, db, chunk_no, rows, chunk_no * args.chunk_size)
        chunks_this_run += 1
        print(f"Completed chunk {chunk_no + 1}/{expected_chunks}")

    completed = db.execute("SELECT COUNT(*) FROM chunks").fetchone()[0]
    if completed == expected_chunks:
        finalize(output_dir, db, args.rows, args.chunk_size)
        print(f"REHEARSAL PASSED: {args.rows:,} rows in {completed} chunks")
    else:
        print(f"Checkpoint saved: {completed}/{expected_chunks} chunks complete")
    return 0


def process_chunk(
    output_dir: Path,
    db: sqlite3.Connection,
    chunk_no: int,
    rows: list[dict[str, Any]],
    start_index: int,
) -> None:
    chunks_dir = output_dir / "chunks"
    paths = {
        label: chunks_dir / f"chunk-{chunk_no:05d}.{label}.jsonl.gz"
        for label in ("retained", "holdouts", "candidates")
    }
    temporary = {label: path.with_suffix(path.suffix + ".tmp") for label, path in paths.items()}
    for path in temporary.values():
        path.unlink(missing_ok=True)

    source_digest = hashlib.sha256()
    counts = Counter()
    changes = Counter()
    languages = Counter()
    benchmark_tier1 = Counter()
    benchmark_tier2 = Counter()
    benchmark_tier1_units = 0  # distinct units (a unit may match several benchmarks)
    benchmark_tier2_units = 0
    started = time.perf_counter()
    db.execute("BEGIN IMMEDIATE")
    try:
        with (
            deterministic_gzip_text(temporary["retained"]) as retained_out,
            deterministic_gzip_text(temporary["holdouts"]) as holdout_out,
            deterministic_gzip_text(temporary["candidates"]) as candidate_out,
        ):
            for offset, row in enumerate(rows):
                source_index = start_index + offset
                source_digest.update((stable_json(row) + "\n").encode("utf-8"))
                disposition, record, flags = process_record(db, row, source_index)
                # Benchmark per-benchmark unit tallies. The tier-2 benchmark list is
                # carried in flags (report-only) and must not reach the generic
                # `changes` Counter, so pop it out before the update below.
                tier2_benchmarks = flags.pop("benchmark_tier2_benchmarks", None)
                languages[record.get("language", "")] += 1
                changes.update(name for name, enabled in flags.items() if enabled)
                if disposition == "retained":
                    retained_out.write(stable_json(record) + "\n")
                    counts["retained"] += 1
                    for annotation in record.get("annotations", []):
                        if annotation.get("type") == "near_duplicate_candidate":
                            candidate_out.write(stable_json(annotation) + "\n")
                    if flags.get("benchmark_tier2") and tier2_benchmarks:
                        benchmark_tier2_units += 1
                        for name in tier2_benchmarks:
                            benchmark_tier2[name] += 1
                else:
                    holdout_out.write(stable_json(record) + "\n")
                    counts[record["disposition"]] += 1
                    if record["disposition"] == "benchmark_holdout":
                        benchmark_tier1_units += 1
                        for name in record.get("matched_benchmarks", []):
                            benchmark_tier1[name] += 1
        retained_hash = sha256_file(temporary["retained"])
        holdout_hash = sha256_file(temporary["holdouts"])
        candidate_hash = sha256_file(temporary["candidates"])
        elapsed = time.perf_counter() - started
        db.execute(
            """
            INSERT INTO chunks VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
            """,
            (
                chunk_no,
                start_index,
                start_index + len(rows),
                len(rows),
                counts["retained"],
                len(rows) - counts["retained"],
                source_digest.hexdigest(),
                retained_hash,
                holdout_hash,
                candidate_hash,
                elapsed,
                utc_now(),
            ),
        )
        db.executemany(
            "INSERT INTO benchmark_stats(chunk_no,tier,benchmark,units) VALUES(?,?,?,?)",
            [
                (chunk_no, tier, benchmark, units)
                for tier, tally in ((1, benchmark_tier1), (2, benchmark_tier2))
                for benchmark, units in sorted(tally.items())
            ],
        )
        db.executemany(
            "INSERT INTO benchmark_distinct(chunk_no,tier,distinct_units) VALUES(?,?,?)",
            [
                (chunk_no, 1, benchmark_tier1_units),
                (chunk_no, 2, benchmark_tier2_units),
            ],
        )
        db.commit()
    except BaseException:
        db.rollback()
        for path in temporary.values():
            path.unlink(missing_ok=True)
        raise

    for label in paths:
        os.replace(temporary[label], paths[label])
    report = {
        "chunk_no": chunk_no,
        "start_index": start_index,
        "end_index_exclusive": start_index + len(rows),
        "source_rows": len(rows),
        "retained": counts["retained"],
        "holdouts": len(rows) - counts["retained"],
        "dispositions": dict(sorted(counts.items())),
        "normalization_and_annotations": dict(sorted(changes.items())),
        "benchmark_decontamination": {
            "status": "RUN" if BENCH_SCANNER is not None else "NOT RUN",
            "tier1_holdout_units_by_benchmark": dict(sorted(benchmark_tier1.items())),
            "tier2_candidate_units_by_benchmark": dict(sorted(benchmark_tier2.items())),
        },
        "languages": dict(sorted(languages.items())),
        "source_sha256": source_digest.hexdigest(),
        "outputs": {
            label: {"path": paths[label].name, "sha256": sha256_file(paths[label])}
            for label in paths
        },
        "elapsed_seconds": round(elapsed, 3),
        "rows_per_second": round(len(rows) / max(elapsed, 0.001), 2),
        "peak_rss_mib": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / (1024 if sys.platform != "darwin" else 1024 * 1024), 2),
        "completed_utc": utc_now(),
    }
    atomic_json(output_dir / "reports" / f"chunk-{chunk_no:05d}.json", report)
    recover_committed_outputs(output_dir, db)


def finalize(
    output_dir: Path, db: sqlite3.Connection, requested_rows: int, chunk_size: int
) -> None:
    rows = list(
        db.execute(
            """
            SELECT chunk_no,source_rows,retained,holdouts,elapsed_seconds,
                   source_sha256,retained_sha256,holdout_sha256,candidates_sha256
            FROM chunks ORDER BY chunk_no
            """
        )
    )
    source_rows = sum(row[1] for row in rows)
    retained = sum(row[2] for row in rows)
    holdouts = sum(row[3] for row in rows)
    dispositions = Counter({"retained": retained})
    for chunk_no in range(len(rows)):
        holdout_path = output_dir / "chunks" / f"chunk-{chunk_no:05d}.holdouts.jsonl.gz"
        with gzip.open(holdout_path, "rt", encoding="utf-8") as handle:
            for line in handle:
                if line.strip():
                    dispositions[json.loads(line)["disposition"]] += 1
    per_chunk_hashes = [
        {
            "chunk_no": row[0],
            "source_sha256": row[5],
            "retained_sha256": row[6],
            "holdout_sha256": row[7],
            "candidates_sha256": row[8],
        }
        for row in rows
    ]

    # Benchmark decontamination aggregate (counts only, no raw matched text). RUN
    # when the registry loaded; otherwise NOT RUN with a blocker. Per-benchmark
    # tier-1 (auto-holdout) and tier-2 (retained candidate) unit tallies are read
    # from benchmark_stats, which is persisted per chunk inside the same
    # transaction as the chunk row, so resume reproduces them exactly.
    tier1_by_benchmark: Counter = Counter()
    tier2_by_benchmark: Counter = Counter()
    for tier, benchmark, units in db.execute(
        "SELECT tier,benchmark,SUM(units) FROM benchmark_stats GROUP BY tier,benchmark"
    ):
        (tier1_by_benchmark if tier == 1 else tier2_by_benchmark)[benchmark] += units
    # Distinct-unit totals (a single unit can match several benchmarks; the
    # per-benchmark tallies count it once per benchmark, so their sum can exceed
    # the number of units. tier1 distinct units == the benchmark_holdout
    # disposition count, which keeps the summary reconcilable at a glance).
    distinct = {
        tier: units
        for tier, units in db.execute(
            "SELECT tier,SUM(distinct_units) FROM benchmark_distinct GROUP BY tier"
        )
    }
    benchmark_run = BENCH_SCANNER is not None
    benchmark_section = {
        "status": "RUN" if benchmark_run else "NOT RUN",
        "policy": "two-tier v1 (2026-07-25): canary OR >= "
        f"{BENCHMARK_TIER1_WORD_GRAMS} distinct word 8-grams => benchmark_holdout; "
        f"{BENCHMARK_TIER2_MIN_WORD_GRAMS}..{BENCHMARK_TIER1_WORD_GRAMS - 1} word "
        "8-grams => retain + candidate annotation (report counts only)",
        "granularity": "whole_conversation",
        "registry_format_version": (
            BENCH_SCANNER.manifest.get("registry_format_version") if benchmark_run else None
        ),
        "registry_dir": str(_REGISTRY_DIR) if benchmark_run else None,
        "installed_benchmarks": (
            BENCH_SCANNER.installed_benchmarks() if benchmark_run else []
        ),
        "tier1_holdout_units": int(distinct.get(1, 0)),
        "tier2_candidate_units": int(distinct.get(2, 0)),
        "tier1_units_by_benchmark": dict(sorted(tier1_by_benchmark.items())),
        "tier2_units_by_benchmark": dict(sorted(tier2_by_benchmark.items())),
        "note_per_benchmark_may_exceed_units": (
            "per-benchmark tallies count a unit once per matched benchmark; a unit "
            "matching several benchmarks contributes to each, so per-benchmark sums "
            "may exceed the distinct tier*_*_units totals above"
        ),
        "blocker": BENCH_SCANNER_BLOCKER,
    }

    summary = {
        "status": "PASSED" if source_rows == requested_rows and retained + holdouts == source_rows else "FAILED",
        "policy": POLICY_VERSION,
        "source_rows": source_rows,
        "materialized_units": source_rows,
        "retained_units": retained,
        "holdouts": holdouts,
        "reconciliation_difference": source_rows - retained - holdouts,
        "chunks": len(rows),
        "chunk_size": chunk_size,
        "elapsed_seconds": round(sum(row[4] for row in rows), 3),
        "rows_per_second": round(source_rows / max(sum(row[4] for row in rows), 0.001), 2),
        "database_records": db.execute("SELECT COUNT(*) FROM records").fetchone()[0],
        "dispositions": dict(sorted(dispositions.items())),
        "benchmark_decontamination": benchmark_section,
        "strategy_status": {
            "source_integrity": "RUN",
            "structural_validation": "RUN",
            "unicode_normalization": "RUN",
            "quality_repetition_gate": "RUN",
            "language_metadata_validation": "RUN",
            "exact_deduplication_global": "RUN",
            "near_deduplication_global": "RUN",
            "privacy_and_secrets": "RUN",
            "benchmark_decontamination": "RUN" if benchmark_run else "NOT RUN",
            "semantic_lexical_correctness": "NOT APPLICABLE",
            "human_language_review": "NOT RUN",
            "checkpoint_restart": "RUN",
        },
        "release_blockers": (
            ([] if benchmark_run else ["benchmark registry not installed"])
            + (
                ["security/privacy holdouts require review"]
                if any(
                    dispositions.get(key, 0) > 0
                    for key in ("security_holdout", "privacy_holdout")
                )
                else []
            )
        ),
        "per_chunk_hashes": per_chunk_hashes,
        "completed_utc": utc_now(),
    }
    atomic_json(output_dir / "reports" / "INDOWORDNET_1M_SUMMARY.json", summary)
    data_card = f"""# ERA IndoWordNet 1M Rehearsal — Data Card

## Result

- Status: **{summary['status']}**
- Source rows: **{source_rows:,}**
- Materialized units: **{source_rows:,}**
- Retained units: **{retained:,}**
- Holdouts: **{holdouts:,}**
- Reconciliation difference: **{summary['reconciliation_difference']}**
- Restartable chunks: **{len(rows)} × up to {chunk_size:,}**
- Processing throughput: **{summary['rows_per_second']:,.2f} rows/second**

## Frozen source

- Repository: `{REPO_ID}`
- Revision: `{REVISION}`
- Component: `IndoWordNet`
- Selection: deterministic pinned source-order prefix
- Declared full component: 96,843,950 rows across 10 source shards

## Applied policy

NFC normalization, supported HTML unescape, U+FFFD/control/invisible-direction
removal, and whitespace normalization were applied while preserving ZWNJ/ZWJ.
Valid short lexical answers and repeated templates with different lexical
content remain valid. Exact duplicates use normalized language + prompt +
response. Near-duplicate automatic routing requires character 5-gram Jaccard
>= 0.95 and SimHash64 Hamming distance <= 3; 0.85 to below 0.95 is annotation
only. The earliest deterministic record remains canonical.

Benchmark decontamination (two-tier policy v1, user-approved 2026-07-25):
whole-conversation scan against the protected registry (format v{summary['benchmark_decontamination'].get('registry_format_version')}).
A canary exact match or >= {BENCHMARK_TIER1_WORD_GRAMS} distinct matching word
8-grams (native or transliterated) routes the unit to the reversible
`benchmark_holdout` category; {BENCHMARK_TIER2_MIN_WORD_GRAMS}..{BENCHMARK_TIER1_WORD_GRAMS - 1}
matching word 8-grams retain the unit and are recorded as
benchmark_overlap_candidates in the report (aggregate counts only, no raw matched
text). The benchmark check runs after exact/near dedup so a held-out record still
anchors later dedup identically to the pre-decontamination pipeline.

## Benchmark decontamination result

- Status: **{summary['benchmark_decontamination']['status']}**
- Installed benchmarks: {", ".join(summary['benchmark_decontamination']['installed_benchmarks']) or "none"}
- Tier-1 holdout units: **{summary['benchmark_decontamination']['tier1_holdout_units']:,}**
- Tier-2 retained candidate units: **{summary['benchmark_decontamination']['tier2_candidate_units']:,}**

## Evidence status

Every source row is routed to exactly one retained or reversible-holdout
disposition. Global duplicate state is persisted across chunks. Per-chunk source
and output hashes are in `INDOWORDNET_1M_SUMMARY.json`.

Human language review is **NOT RUN**. This rehearsal validates scale, restart,
reconciliation and deterministic routing; it does not establish lexical
correctness or translation fidelity.
"""
    (output_dir / "reports" / "INDOWORDNET_1M_DATA_CARD.md").write_text(
        data_card, encoding="utf-8"
    )
    checksums = []
    for path in sorted((output_dir / "reports").glob("*")) + sorted(
        (output_dir / "manifests").glob("*")
    ):
        if path.is_file():
            checksums.append(f"{sha256_file(path)}  {path.relative_to(output_dir)}")
    (output_dir / "manifests" / "SHA256SUMS.txt").write_text(
        "\n".join(checksums) + "\n", encoding="utf-8"
    )


def verify(args: argparse.Namespace) -> int:
    output_dir = Path(args.output_dir).resolve()
    summary_path = output_dir / "reports" / "INDOWORDNET_1M_SUMMARY.json"
    if not summary_path.exists():
        raise RuntimeError("Completed summary is missing")
    summary = json.loads(summary_path.read_text(encoding="utf-8"))
    db = setup_database(output_dir / "state" / "global-routing.sqlite")
    recover_committed_outputs(output_dir, db)
    errors = []
    for item in summary["per_chunk_hashes"]:
        chunk_no = item["chunk_no"]
        for label in ("retained", "holdout", "candidates"):
            filename_label = "holdouts" if label == "holdout" else label
            path = output_dir / "chunks" / f"chunk-{chunk_no:05d}.{filename_label}.jsonl.gz"
            expected = item[f"{label}_sha256"]
            if sha256_file(path) != expected:
                errors.append(str(path))
            with gzip.open(path, "rt", encoding="utf-8") as handle:
                for line_no, line in enumerate(handle, 1):
                    try:
                        json.loads(line)
                    except json.JSONDecodeError:
                        errors.append(f"{path}:{line_no}")
                        break
    if summary["reconciliation_difference"] != 0:
        errors.append("non-zero reconciliation")
    if errors:
        raise RuntimeError("Verification failed: " + ", ".join(errors))
    verification = {
        "status": "PASSED",
        "files_and_gzip_streams": "PASSED",
        "hashes": "PASSED",
        "reconciliation": "PASSED",
        "verified_utc": utc_now(),
    }
    atomic_json(output_dir / "reports" / "REPLAY_VERIFICATION.json", verification)
    print("VERIFICATION PASSED")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    run_parser = subparsers.add_parser("run")
    run_parser.add_argument("--output-dir", required=True)
    run_parser.add_argument("--rows", type=int, default=DEFAULT_ROWS)
    run_parser.add_argument("--chunk-size", type=int, default=DEFAULT_CHUNK_SIZE)
    run_parser.add_argument("--max-chunks", type=int)
    run_parser.add_argument("--source-jsonl", help="Testing/local JSONL(.gz) override")
    run_parser.set_defaults(func=run)
    verify_parser = subparsers.add_parser("verify")
    verify_parser.add_argument("--output-dir", required=True)
    verify_parser.set_defaults(func=verify)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    if getattr(args, "rows", 1) <= 0 or getattr(args, "chunk_size", 1) <= 0:
        raise SystemExit("rows and chunk-size must be positive")
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
