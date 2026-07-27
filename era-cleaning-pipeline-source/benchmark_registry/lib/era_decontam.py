"""ERA Phase 1 — protected benchmark decontamination core library.

Shared, dependency-free (stdlib-only) normalization, n-gram, transliteration and
hashing routines used by both the registry builder and the lookup/matching module.

Design contract (must stay aligned with the frozen pipeline decisions in
CLAUDE.md and the existing pipeline normalization):

- NFC normalization.
- Case folding for matching (str.casefold), matching the Python pipeline's
  ``char_ngrams`` (which casefolds) and the Node pilot's toLowerCase.
- Invisible / bidi noise is stripped for matching ONLY (U+200B ZWSP, U+200E/F
  LRM/RLM, U+202A-U+202E, U+2066-U+2069, U+FEFF, C0/C1 controls) -- this mirrors
  ``NOISE_RE`` in indowordnet_1m.py and the Node ``normalize`` regex.
- ZWNJ (U+200C) and ZWJ (U+200D) are PRESERVED. They are never in the noise set.
  This is a frozen decision: Brahmic scripts encode half-characters with them.
- Whitespace collapsed to single spaces and trimmed.

Hashing: n-grams are stored as truncated (first 16 hex chars = 64 bits) SHA-256
digests, so no raw benchmark text is stored in bulk. SHA-256 is chosen over
BLAKE2b so the Python and Node lookup libraries emit byte-identical gram hashes.
Canary items store the full-item SHA-256 hash plus an 8-character preview only.

Transliteration: a deterministic, stdlib-only Devanagari->Latin scheme (an
ISO-15919-flavoured, non-reversible romanization) lets Devanagari<->Latin
transliterated contamination match. The scheme is documented in
``DEVANAGARI_TRANSLIT_SCHEME`` and mirrored in the registry manifest.

Everything here is deterministic: no timestamps, no randomness, sorted outputs.
"""

from __future__ import annotations

import hashlib
import re
import unicodedata

# --- Registry format contract ---------------------------------------------

REGISTRY_FORMAT_VERSION = "1"
# Word-level n-gram width for Latin/space-delimited text.
WORD_NGRAM_N = 8
# Character n-gram width for Indic-script text (matches pipeline char 5-grams).
CHAR_NGRAM_N = 5
# Truncated BLAKE2b digest width, in hex characters (64 bits).
HASH_HEX_WIDTH = 16
# Canary preview length (first N characters of the normalized canary string).
CANARY_PREVIEW_CHARS = 8

# Mirror of indowordnet_1m.py NOISE_RE. ZWNJ (U+200C) and ZWJ (U+200D) are
# deliberately absent: they are preserved (frozen decision). Built from explicit
# \u escapes so this source file contains no literal control bytes.
def _build_noise_chars() -> str:
    # C0/C1 controls (minus tab/newline/carriage-return), plus invisible/bidi.
    # ZWNJ (0x200C) and ZWJ (0x200D) are intentionally excluded.
    ranges = [
        (0x0000, 0x0008), (0x000B, 0x000C), (0x000E, 0x001F),
        (0x007F, 0x009F),
        (0x200B, 0x200B),  # ZWSP
        (0x200E, 0x200F),  # LRM/RLM
        (0x202A, 0x202E),  # bidi embedding/override
        (0x2066, 0x2069),  # bidi isolates
        (0xFEFF, 0xFEFF),  # BOM/ZWNBSP
    ]
    chars = []
    for lo, hi in ranges:
        chars.extend(chr(cp) for cp in range(lo, hi + 1))
    return "".join(chars)


_NOISE_CHARS = _build_noise_chars()
_NOISE_RE = re.compile("[" + re.escape(_NOISE_CHARS) + "]")
_SPACE_RE = re.compile(r"\s+")

# Codepoint ranges that indicate Indic (Brahmic) script content.
_INDIC_RANGES = (
    (0x0900, 0x097F),  # Devanagari
    (0x0980, 0x09FF),  # Bengali/Assamese
    (0x0A00, 0x0A7F),  # Gurmukhi
    (0x0A80, 0x0AFF),  # Gujarati
    (0x0B00, 0x0B7F),  # Oriya/Odia
    (0x0B80, 0x0BFF),  # Tamil
    (0x0C00, 0x0C7F),  # Telugu
    (0x0C80, 0x0CFF),  # Kannada
    (0x0D00, 0x0D7F),  # Malayalam
    (0xABC0, 0xABFF),  # Meetei Mayek
)


def normalize_for_match(value: str) -> str:
    """Normalize text for contamination matching.

    NFC -> casefold -> strip invisible/bidi noise (preserving ZWNJ/ZWJ) ->
    collapse whitespace -> trim. Deterministic and idempotent.
    """
    if not isinstance(value, str):
        raise TypeError("normalize_for_match requires a string")
    nfc = unicodedata.normalize("NFC", value)
    folded = nfc.casefold()
    de_noised = _NOISE_RE.sub("", folded)
    collapsed = _SPACE_RE.sub(" ", de_noised).strip()
    return collapsed


def is_indic(text: str) -> bool:
    """True if the text contains any Brahmic-script codepoint."""
    for ch in text:
        cp = ord(ch)
        for lo, hi in _INDIC_RANGES:
            if lo <= cp <= hi:
                return True
    return False


def hash_gram(gram: str) -> str:
    """Truncated SHA-256 hex digest of a normalized n-gram (first 64 bits).

    SHA-256 (not BLAKE2b) is used so the Python and Node lookup libraries produce
    byte-identical gram hashes: Node's crypto exposes sha256 with matching output,
    whereas its blake2b512 cannot reproduce Python's blake2b(digest_size=8).
    """
    return hashlib.sha256(gram.encode("utf-8")).hexdigest()[:HASH_HEX_WIDTH]


def word_ngrams(text: str, n: int = WORD_NGRAM_N) -> list[str]:
    """Sorted, de-duplicated word-level n-grams of normalized text.

    Tokens are whitespace-delimited on already-normalized text. If the text has
    fewer than ``n`` tokens, a single joined n-gram of all tokens is returned so
    short protected items still contribute a signature.
    """
    tokens = [t for t in text.split(" ") if t]
    if not tokens:
        return []
    if len(tokens) < n:
        return [" ".join(tokens)]
    grams = {" ".join(tokens[i : i + n]) for i in range(len(tokens) - n + 1)}
    return sorted(grams)


def char_ngrams(text: str, n: int = CHAR_NGRAM_N) -> list[str]:
    """Sorted, de-duplicated character n-grams of normalized text.

    Mirrors the pipeline's char_ngrams (casefold already applied by
    normalize_for_match). Whitespace is removed before shingling so that word
    spacing does not fragment Indic character grams.
    """
    compact = text.replace(" ", "")
    if not compact:
        return []
    if len(compact) <= n:
        return [compact]
    grams = {compact[i : i + n] for i in range(len(compact) - n + 1)}
    return sorted(grams)


# --- Deterministic Devanagari -> Latin transliteration ---------------------
#
# ISO-15919-flavoured, non-reversible romanization. Stdlib only. Covers the
# Devanagari block used by Hindi/Marathi/Sanskrit/Nepali/Konkani/Bodo (the
# scripts declared for those languages in the pipeline's EXPECTED_SCRIPTS).
# Other Brahmic scripts are left as-is (their romanization would need per-script
# tables; documented as a known limitation in the manifest).

DEVANAGARI_TRANSLIT_SCHEME = (
    "deterministic-devanagari-iso15919-lite-v1: independent vowels, consonants "
    "with inherent 'a', dependent vowel signs (matras), virama suppresses the "
    "inherent vowel, anusvara->m, visarga->h, chandrabindu->m, nukta folded "
    "into base, digits mapped to ASCII. Non-reversible; ZWNJ/ZWJ dropped only "
    "in the romanized variant (they carry no Latin realization)."
)

_DEVA_INDEPENDENT_VOWELS = {
    "अ": "a", "आ": "aa", "इ": "i", "ई": "ii",
    "उ": "u", "ऊ": "uu", "ऋ": "ri", "ॠ": "rii",
    "ऌ": "li", "ए": "e", "ऐ": "ai", "ओ": "o",
    "औ": "au", "ऍ": "e", "ऑ": "o", "ॲ": "a",
}
_DEVA_MATRAS = {
    "ा": "aa", "ि": "i", "ी": "ii", "ु": "u",
    "ू": "uu", "ृ": "ri", "ॄ": "rii", "े": "e",
    "ै": "ai", "ो": "o", "ौ": "au", "ॅ": "e",
    "ॉ": "o", "ॢ": "li",
}
_DEVA_CONSONANTS = {
    "क": "k", "ख": "kh", "ग": "g", "घ": "gh", "ङ": "ng",
    "च": "c", "छ": "ch", "ज": "j", "झ": "jh", "ञ": "ny",
    "ट": "t", "ठ": "th", "ड": "d", "ढ": "dh", "ण": "n",
    "त": "t", "थ": "th", "द": "d", "ध": "dh", "न": "n",
    "प": "p", "फ": "ph", "ब": "b", "भ": "bh", "म": "m",
    "य": "y", "र": "r", "ल": "l", "ळ": "l", "व": "v",
    "श": "sh", "ष": "sh", "स": "s", "ह": "h",
    "क़": "k", "ख़": "kh", "ग़": "g", "ज़": "z", "ड़": "d",
    "ढ़": "dh", "फ़": "f", "य़": "y",
}
_DEVA_DIGITS = {
    "०": "0", "१": "1", "२": "2", "३": "3", "४": "4",
    "५": "5", "६": "6", "७": "7", "८": "8", "९": "9",
}
_DEVA_VIRAMA = "्"
_DEVA_ANUSVARA = "ं"
_DEVA_CHANDRABINDU = "ँ"
_DEVA_VISARGA = "ः"
_DEVA_NUKTA = "़"
_DEVA_AVAGRAHA = "ऽ"
_ZERO_WIDTH_JOINERS = ("‌", "‍")


def transliterate_devanagari(text: str) -> str:
    """Deterministic Devanagari->Latin romanization (see DEVANAGARI_TRANSLIT_SCHEME).

    Non-Devanagari characters pass through unchanged. Returns the input's
    romanization; callers decide whether to run it (only when is_indic()).
    """
    out: list[str] = []
    pending_consonant = False  # a consonant awaiting its inherent 'a'
    for ch in text:
        if ch in _ZERO_WIDTH_JOINERS or ch == _DEVA_NUKTA or ch == _DEVA_AVAGRAHA:
            # ZWNJ/ZWJ carry no Latin realization; nukta folded into base already.
            continue
        if ch in _DEVA_CONSONANTS:
            if pending_consonant:
                out.append("a")
            out.append(_DEVA_CONSONANTS[ch])
            pending_consonant = True
            continue
        if ch == _DEVA_VIRAMA:
            # Suppress the inherent vowel of the preceding consonant.
            pending_consonant = False
            continue
        if ch in _DEVA_MATRAS:
            out.append(_DEVA_MATRAS[ch])
            pending_consonant = False
            continue
        if ch in _DEVA_INDEPENDENT_VOWELS:
            if pending_consonant:
                out.append("a")
                pending_consonant = False
            out.append(_DEVA_INDEPENDENT_VOWELS[ch])
            continue
        if ch in (_DEVA_ANUSVARA, _DEVA_CHANDRABINDU):
            if pending_consonant:
                out.append("a")
                pending_consonant = False
            out.append("m")
            continue
        if ch == _DEVA_VISARGA:
            if pending_consonant:
                out.append("a")
                pending_consonant = False
            out.append("h")
            continue
        if ch in _DEVA_DIGITS:
            if pending_consonant:
                out.append("a")
                pending_consonant = False
            out.append(_DEVA_DIGITS[ch])
            continue
        # Any other character (spaces, Latin, punctuation, other scripts).
        if pending_consonant:
            out.append("a")
            pending_consonant = False
        out.append(ch)
    if pending_consonant:
        out.append("a")
    return "".join(out)


def emit_grams(text: str) -> dict[str, list[str]]:
    """Emit all protected-gram hashes for a piece of benchmark text.

    Returns a dict with keys:
      - "word": word-level 8-gram hashes (always)
      - "char": character 5-gram hashes (only when Indic script present)
      - "translit_word": word 8-gram hashes of the romanized text (Indic only)
      - "translit_char": char 5-gram hashes of the romanized text (Indic only)

    All lists are sorted and de-duplicated. Input is normalized here.
    """
    normalized = normalize_for_match(text)
    result: dict[str, list[str]] = {"word": [], "char": []}
    result["word"] = sorted({hash_gram(g) for g in word_ngrams(normalized)})
    if is_indic(normalized):
        result["char"] = sorted({hash_gram(g) for g in char_ngrams(normalized)})
        romanized = normalize_for_match(transliterate_devanagari(normalized))
        if romanized and romanized != normalized:
            result["translit_word"] = sorted(
                {hash_gram(g) for g in word_ngrams(romanized)}
            )
            result["translit_char"] = sorted(
                {hash_gram(g) for g in char_ngrams(romanized)}
            )
    return result


def canary_record(text: str) -> dict[str, str]:
    """Build a canary record: full-item hash + short preview only (no raw bulk)."""
    normalized = normalize_for_match(text)
    return {
        "hash": hashlib.sha256(normalized.encode("utf-8")).hexdigest(),
        "preview": normalized[:CANARY_PREVIEW_CHARS],
        "norm_len": len(normalized),
    }
