// Cross-language parity + matching tests for the Node lookup library.
//
// Verifies:
//   1. normalizeForMatch preserves ZWNJ/ZWJ and strips bidi/ZWSP.
//   2. hashGram output matches the Python reference vectors (byte-identical).
//   3. emitGrams for a known string equals the Python reference hashes.
//   4. Against the real built registry: a planted GSM8K item matches; its Hindi
//      analogue and a transliterated Hindi item match MILU/IndicGenBench-style
//      Indic benchmarks; clean text does not match; shard tamper is detected.
//
// The Python reference vectors are produced by test_parity_vectors.py (run in
// the same test suite) and written to tests/parity_vectors.json. This test
// reads that file; if it is absent it skips the parity assertions with a notice
// (so the JS test can still run standalone), but the Python suite regenerates it.
//
// Run: node --test benchmark_registry/tests/test_node_parity.mjs

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.join(__dirname, "..", "lib");

const {
  ContaminationScanner,
  emitGrams,
  hashGram,
  normalizeForMatch,
  transliterateDevanagari,
} = await import(path.join(LIB, "era_lookup.mjs"));

const REGISTRY_DIR = path.join(__dirname, "..");

test("normalization preserves ZWNJ/ZWJ, strips bidi and ZWSP", () => {
  const s = "क‍ष and ‮x​";
  const norm = normalizeForMatch(s);
  assert.ok(norm.includes("‍"), "ZWJ must survive");
  assert.ok(!norm.includes("‮"), "bidi override must be stripped");
  assert.ok(!norm.includes("​"), "ZWSP must be stripped");
});

test("hashGram matches Python reference vectors", () => {
  const vecPath = path.join(__dirname, "parity_vectors.json");
  if (!fs.existsSync(vecPath)) {
    console.log("  (parity_vectors.json absent; run the Python suite first)");
    return;
  }
  const vectors = JSON.parse(fs.readFileSync(vecPath, "utf8"));
  for (const [gram, expected] of Object.entries(vectors.hash_gram)) {
    assert.equal(hashGram(gram), expected, `hashGram mismatch for ${JSON.stringify(gram)}`);
  }
});

test("emitGrams matches Python reference vectors", () => {
  const vecPath = path.join(__dirname, "parity_vectors.json");
  if (!fs.existsSync(vecPath)) return;
  const vectors = JSON.parse(fs.readFileSync(vecPath, "utf8"));
  for (const [text, expected] of Object.entries(vectors.emit_grams)) {
    const got = emitGrams(text);
    assert.deepEqual(got.word, expected.word, `word grams differ for ${JSON.stringify(text)}`);
    assert.deepEqual(got.char ?? [], expected.char ?? [], "char grams differ");
    assert.deepEqual(
      got.translit_word ?? [],
      expected.translit_word ?? [],
      "translit_word grams differ",
    );
  }
});

test("transliteration is deterministic and drops joiners", () => {
  const a = transliterateDevanagari("क‍ष");
  const b = transliterateDevanagari("कष");
  assert.equal(a, b);
});

test("scans the real registry for a planted GSM8K contamination", () => {
  const manifestPath = path.join(REGISTRY_DIR, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    console.log("  (registry not built; skipping live scan)");
    return;
  }
  const scanner = new ContaminationScanner(REGISTRY_DIR);
  assert.ok(scanner.installedBenchmarks().length > 0);

  // Verbatim GSM8K test item 0 (openai/gsm8k main test split). This is a real
  // protected item, so an >=8-word-gram overlap is expected.
  const planted =
    "Janet’s ducks lay 16 eggs per day. She eats three for breakfast every " +
    "morning and bakes muffins for her friends every day with four. She sells the " +
    "remainder at the farmers' market daily for $2 per fresh duck egg. How much in " +
    "dollars does she make every day at the farmers' market?";
  const res = scanner.scanText("Sure, here is a practice problem. " + planted);
  assert.ok(res.is_candidate, "planted GSM8K text should be flagged");
  assert.ok(res.matched_benchmarks.includes("GSM8K"), "should match GSM8K");

  const clean = scanner.scanText(
    "My neighbour grows tomatoes and peppers in a small rooftop garden each summer.",
  );
  assert.equal(clean.is_candidate, false, "unrelated clean text must not flag");
});

test("scans the real registry for transliterated Indic contamination", () => {
  const manifestPath = path.join(REGISTRY_DIR, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    console.log("  (registry not built; skipping live translit scan)");
    return;
  }
  const scanner = new ContaminationScanner(REGISTRY_DIR);

  // Verbatim MILU (Hindi) test item — Devanagari.
  const hindi =
    "एक ढलवाँ इस्पात के विद्युतचुंबक में 0.3 cm की लम्बाई का एक वायु अंतराल है। " +
    "तो वायु अंतराल में 0.7 Wb/m2 के फ्लक्स घनत्व के उत्पादन के लिए वायु अंतराल के लिए एम्पियर घुमाव क्या है?";
  const nativeRes = scanner.scanText(hindi);
  assert.ok(nativeRes.is_candidate, "verbatim Devanagari MILU item should flag");
  assert.ok(nativeRes.matched_benchmarks.includes("MILU"));

  // Its Latin romanization must also flag MILU (transliteration-aware matching).
  const romanized = transliterateDevanagari(hindi);
  const translitRes = scanner.scanText(romanized);
  assert.ok(translitRes.is_candidate, "transliterated MILU item should flag");
  assert.ok(
    translitRes.matched_benchmarks.includes("MILU"),
    "transliterated variant should match MILU",
  );
});

test("shard SHA-256 tamper is detected on load", () => {
  const manifestPath = path.join(REGISTRY_DIR, "manifest.json");
  if (!fs.existsSync(manifestPath)) return;
  // Point the scanner at a temp copy with one shard tampered.
  const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "era-reg-"));
  fs.mkdirSync(path.join(tmp, "shards"), { recursive: true });
  fs.copyFileSync(manifestPath, path.join(tmp, "manifest.json"));
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  for (const entry of manifest.benchmarks) {
    if (entry.status !== "INSTALLED") continue;
    const src = path.join(REGISTRY_DIR, entry.shard);
    const dst = path.join(tmp, entry.shard);
    let content = fs.readFileSync(src, "utf8");
    if (entry.id === "GSM8K") content += "\n"; // tamper
    fs.writeFileSync(dst, content);
  }
  assert.throws(() => new ContaminationScanner(tmp), /SHA-256 mismatch/);
});
