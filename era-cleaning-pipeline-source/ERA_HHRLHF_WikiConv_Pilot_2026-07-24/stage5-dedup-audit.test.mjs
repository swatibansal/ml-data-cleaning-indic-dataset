import test from "node:test";
import assert from "node:assert/strict";
import {
  bandKeys,
  characterShingles,
  conversationText,
  hammingDistance64,
  isNearDuplicate,
  normalizeForSimilarity,
  simhash64,
} from "./stage5-dedup-audit.mjs";

function profile(text) {
  const normalized = normalizeForSimilarity(text);
  const shingles = characterShingles(text);
  return {
    normalizedLength: [...normalized].length,
    shingles,
    simhash: simhash64(shingles),
  };
}

test("serializes only interaction text and preserves turn boundaries", () => {
  assert.equal(
    conversationText([["prompt", "answer"], ["next", "response"]]),
    "prompt␞answer␝next␞response",
  );
});

test("similarity normalization changes casing and whitespace only", () => {
  assert.equal(
    normalizeForSimilarity("  Hello,\n  WORLD!  "),
    "hello, world!",
  );
  assert.equal(normalizeForSimilarity("cm²"), "cm²");
});

test("character shingles support Indic scripts", () => {
  const shingles = characterShingles("भारत एक विविध देश है।");
  assert.ok(shingles.size > 5);
});

test("identical text has identical SimHash and bands", () => {
  const left = profile("A sufficiently long multilingual example भारत.");
  const right = profile("A sufficiently long multilingual example भारत.");
  assert.equal(hammingDistance64(left.simhash, right.simhash), 0);
  assert.deepEqual(bandKeys(left.simhash), bandKeys(right.simhash));
});

test("accepts a tiny edit in a long otherwise identical example", () => {
  const shared =
    "Photosynthesis converts light energy into chemical energy inside plant cells. " +
    "Chlorophyll absorbs light while carbon dioxide and water provide raw materials. ";
  const result = isNearDuplicate(
    profile(`${shared}It primarily occurs in chloroplasts.`),
    profile(`${shared}It mainly occurs in chloroplasts.`),
    { maximumHammingDistance: 8 },
  );
  assert.equal(result.match, true);
  assert.ok(result.jaccard >= 0.85);
});

test("rejects unrelated examples", () => {
  const result = isNearDuplicate(
    profile("Photosynthesis converts sunlight into chemical energy in green plants."),
    profile("A binary search repeatedly halves an ordered list to find a target."),
  );
  assert.equal(result.match, false);
});

test("does not classify very short strings as near duplicates", () => {
  const result = isNearDuplicate(profile("Yes."), profile("yes!"));
  assert.equal(result.match, false);
  assert.equal(result.reason, "too_short");
});
