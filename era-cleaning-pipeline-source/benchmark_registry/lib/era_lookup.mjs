// ERA Phase 1 — protected benchmark registry lookup for the Node pilot pipeline.
//
// Mirrors benchmark_registry/lib/era_decontam.py + era_lookup.py so the
// HHRLHF_T / Wiki_Conv Node scripts can query the SAME registry the Python
// pipeline uses. Loads manifest.json, verifies INSTALLED shard SHA-256s, and
// scans text -> normalized -> n-gram hashes -> hash-set lookup -> candidate
// annotation. Detections are CANDIDATES/ANNOTATIONS only (never auto-holdout).
//
// The normalization, n-gram widths, hashing (BLAKE2b-64 hex) and Devanagari
// romanization here are byte-compatible with the Python library so both
// pipelines produce the same gram hashes. This is covered by a cross-language
// parity check in tests/test_node_parity.mjs.
//
// Stdlib only (node:crypto, node:fs, node:path). No npm dependencies.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const REGISTRY_FORMAT_VERSION = "1";
export const WORD_NGRAM_N = 8;
export const CHAR_NGRAM_N = 5;
export const CANARY_PREVIEW_CHARS = 8;
export const DEFAULT_WORD_GRAM_THRESHOLD = 1;
export const DEFAULT_CHAR_GRAM_THRESHOLD = 10;

// Noise codepoints stripped for matching. ZWNJ (0x200C) and ZWJ (0x200D) are
// deliberately excluded (preserved). Kept in sync with _build_noise_chars in
// era_decontam.py.
function buildNoiseSet() {
  const ranges = [
    [0x0000, 0x0008], [0x000b, 0x000c], [0x000e, 0x001f],
    [0x007f, 0x009f],
    [0x200b, 0x200b],
    [0x200e, 0x200f],
    [0x202a, 0x202e],
    [0x2066, 0x2069],
    [0xfeff, 0xfeff],
  ];
  const set = new Set();
  for (const [lo, hi] of ranges) {
    for (let cp = lo; cp <= hi; cp += 1) set.add(cp);
  }
  return set;
}
const NOISE_SET = buildNoiseSet();

export function normalizeForMatch(value) {
  if (typeof value !== "string") {
    throw new TypeError("normalizeForMatch requires a string");
  }
  const nfc = value.normalize("NFC").toLowerCase();
  let out = "";
  for (const ch of nfc) {
    if (!NOISE_SET.has(ch.codePointAt(0))) out += ch;
  }
  return out.replace(/\s+/gu, " ").trim();
}

const INDIC_RANGES = [
  [0x0900, 0x097f], [0x0980, 0x09ff], [0x0a00, 0x0a7f], [0x0a80, 0x0aff],
  [0x0b00, 0x0b7f], [0x0b80, 0x0bff], [0x0c00, 0x0c7f], [0x0c80, 0x0cff],
  [0x0d00, 0x0d7f], [0xabc0, 0xabff],
];

export function isIndic(text) {
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    for (const [lo, hi] of INDIC_RANGES) {
      if (cp >= lo && cp <= hi) return true;
    }
  }
  return false;
}

export function hashGram(gram) {
  // Truncated SHA-256 (first 16 hex chars). Byte-identical to Python's
  // hashlib.sha256(...).hexdigest()[:16]. SHA-256 is used instead of BLAKE2b
  // because Node's blake2b512 cannot reproduce Python's blake2b(digest_size=8).
  return crypto.createHash("sha256").update(gram, "utf8").digest("hex").slice(0, 16);
}

export function wordNgrams(text, n = WORD_NGRAM_N) {
  const tokens = text.split(" ").filter(Boolean);
  if (tokens.length === 0) return [];
  if (tokens.length < n) return [tokens.join(" ")];
  const grams = new Set();
  for (let i = 0; i <= tokens.length - n; i += 1) {
    grams.add(tokens.slice(i, i + n).join(" "));
  }
  return [...grams].sort();
}

export function charNgrams(text, n = CHAR_NGRAM_N) {
  const compact = [...text.replace(/ /gu, "")];
  if (compact.length === 0) return [];
  if (compact.length <= n) return [compact.join("")];
  const grams = new Set();
  for (let i = 0; i <= compact.length - n; i += 1) {
    grams.add(compact.slice(i, i + n).join(""));
  }
  return [...grams].sort();
}

// --- Devanagari -> Latin (mirror of era_decontam.transliterate_devanagari) ---

const DEVA_INDEPENDENT_VOWELS = {
  "अ": "a", "आ": "aa", "इ": "i", "ई": "ii", "उ": "u", "ऊ": "uu", "ऋ": "ri",
  "ॠ": "rii", "ऌ": "li", "ए": "e", "ऐ": "ai", "ओ": "o", "औ": "au", "ऍ": "e",
  "ऑ": "o", "ॲ": "a",
};
const DEVA_MATRAS = {
  "ा": "aa", "ि": "i", "ी": "ii", "ु": "u", "ू": "uu", "ृ": "ri", "ॄ": "rii",
  "े": "e", "ै": "ai", "ो": "o", "ौ": "au", "ॅ": "e", "ॉ": "o", "ॢ": "li",
};
const DEVA_CONSONANTS = {
  "क": "k", "ख": "kh", "ग": "g", "घ": "gh", "ङ": "ng", "च": "c", "छ": "ch",
  "ज": "j", "झ": "jh", "ञ": "ny", "ट": "t", "ठ": "th", "ड": "d", "ढ": "dh",
  "ण": "n", "त": "t", "थ": "th", "द": "d", "ध": "dh", "न": "n", "प": "p",
  "फ": "ph", "ब": "b", "भ": "bh", "म": "m", "य": "y", "र": "r", "ल": "l",
  "ळ": "l", "व": "v", "श": "sh", "ष": "sh", "स": "s", "ह": "h", "क़": "k",
  "ख़": "kh", "ग़": "g", "ज़": "z", "ड़": "d", "ढ़": "dh", "फ़": "f", "य़": "y",
};
const DEVA_DIGITS = {
  "०": "0", "१": "1", "२": "2", "३": "3", "४": "4", "५": "5", "६": "6",
  "७": "7", "८": "8", "९": "9",
};
const DEVA_VIRAMA = "्";
const DEVA_ANUSVARA = "ं";
const DEVA_CHANDRABINDU = "ँ";
const DEVA_VISARGA = "ः";
const DEVA_NUKTA = "़";
const DEVA_AVAGRAHA = "ऽ";
const ZERO_WIDTH_JOINERS = new Set(["‌", "‍"]);

export function transliterateDevanagari(text) {
  const out = [];
  let pending = false;
  for (const ch of text) {
    if (ZERO_WIDTH_JOINERS.has(ch) || ch === DEVA_NUKTA || ch === DEVA_AVAGRAHA) {
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(DEVA_CONSONANTS, ch)) {
      if (pending) out.push("a");
      out.push(DEVA_CONSONANTS[ch]);
      pending = true;
      continue;
    }
    if (ch === DEVA_VIRAMA) {
      pending = false;
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(DEVA_MATRAS, ch)) {
      out.push(DEVA_MATRAS[ch]);
      pending = false;
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(DEVA_INDEPENDENT_VOWELS, ch)) {
      if (pending) { out.push("a"); pending = false; }
      out.push(DEVA_INDEPENDENT_VOWELS[ch]);
      continue;
    }
    if (ch === DEVA_ANUSVARA || ch === DEVA_CHANDRABINDU) {
      if (pending) { out.push("a"); pending = false; }
      out.push("m");
      continue;
    }
    if (ch === DEVA_VISARGA) {
      if (pending) { out.push("a"); pending = false; }
      out.push("h");
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(DEVA_DIGITS, ch)) {
      if (pending) { out.push("a"); pending = false; }
      out.push(DEVA_DIGITS[ch]);
      continue;
    }
    if (pending) { out.push("a"); pending = false; }
    out.push(ch);
  }
  if (pending) out.push("a");
  return out.join("");
}

export function emitGrams(text) {
  const normalized = normalizeForMatch(text);
  const result = { word: [], char: [] };
  result.word = [...new Set(wordNgrams(normalized).map(hashGram))].sort();
  if (isIndic(normalized)) {
    result.char = [...new Set(charNgrams(normalized).map(hashGram))].sort();
    const romanized = normalizeForMatch(transliterateDevanagari(normalized));
    if (romanized && romanized !== normalized) {
      result.translit_word = [...new Set(wordNgrams(romanized).map(hashGram))].sort();
      result.translit_char = [...new Set(charNgrams(romanized).map(hashGram))].sort();
    }
  }
  return result;
}

export function canaryHash(text) {
  return crypto.createHash("sha256").update(normalizeForMatch(text), "utf8").digest("hex");
}

function sha256File(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(buf).digest("hex");
}

export class ContaminationScanner {
  constructor(registryDir, options = {}) {
    this.registryDir = registryDir;
    this.wordThreshold = options.wordThreshold ?? DEFAULT_WORD_GRAM_THRESHOLD;
    this.charThreshold = options.charThreshold ?? DEFAULT_CHAR_GRAM_THRESHOLD;
    const verifyHashes = options.verifyHashes ?? true;
    const manifestPath = path.join(registryDir, "manifest.json");
    if (!fs.existsSync(manifestPath)) {
      throw new Error(`manifest not found: ${manifestPath}`);
    }
    this.manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (String(this.manifest.registry_format_version) !== REGISTRY_FORMAT_VERSION) {
      throw new Error(
        `registry format version mismatch: manifest=${this.manifest.registry_format_version} lib=${REGISTRY_FORMAT_VERSION}`,
      );
    }
    this.word = new Map();
    this.char = new Map();
    this.canaries = new Map();
    for (const entry of this.manifest.benchmarks ?? []) {
      if (entry.status !== "INSTALLED") continue;
      const shardPath = path.join(registryDir, entry.shard);
      if (!fs.existsSync(shardPath)) {
        throw new Error(`shard missing for ${entry.id}: ${shardPath}`);
      }
      if (verifyHashes) {
        const actual = sha256File(shardPath);
        if (actual !== entry.shard_sha256) {
          throw new Error(
            `shard SHA-256 mismatch for ${entry.id}: manifest=${entry.shard_sha256} actual=${actual}`,
          );
        }
      }
      const shard = JSON.parse(fs.readFileSync(shardPath, "utf8"));
      const word = new Set(shard.word_grams ?? []);
      for (const g of shard.translit_word_grams ?? []) word.add(g);
      const char = new Set(shard.char_grams ?? []);
      for (const g of shard.translit_char_grams ?? []) char.add(g);
      this.word.set(entry.id, word);
      this.char.set(entry.id, char);
      this.canaries.set(entry.id, new Set((shard.canaries ?? []).map((c) => c.hash)));
    }
  }

  installedBenchmarks() {
    return [...this.word.keys()].sort();
  }

  scanText(text) {
    const grams = emitGrams(text);
    const queryWord = new Set([...(grams.word ?? []), ...(grams.translit_word ?? [])]);
    const queryChar = new Set([...(grams.char ?? []), ...(grams.translit_char ?? [])]);
    const norm = normalizeForMatch(text);
    const cHash = norm ? canaryHash(norm) : null;
    const matches = [];
    for (const bid of this.installedBenchmarks()) {
      let wordHits = 0;
      const bWord = this.word.get(bid);
      for (const g of queryWord) if (bWord.has(g)) wordHits += 1;
      let charHits = 0;
      const bChar = this.char.get(bid);
      for (const g of queryChar) if (bChar.has(g)) charHits += 1;
      const canaryHit = Boolean(cHash && this.canaries.get(bid).has(cHash));
      if (canaryHit || wordHits >= this.wordThreshold || charHits >= this.charThreshold) {
        matches.push({
          benchmark: bid,
          word_gram_overlaps: wordHits,
          char_gram_overlaps: charHits,
          canary_exact: canaryHit,
        });
      }
    }
    return {
      is_candidate: matches.length > 0,
      matched_benchmarks: matches.map((m) => m.benchmark),
      detail: matches,
    };
  }

  scanConversation(texts) {
    const combined = texts.filter((t) => typeof t === "string").join("\n");
    return this.scanText(combined);
  }
}
