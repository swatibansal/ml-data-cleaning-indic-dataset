import test from "node:test";
import assert from "node:assert/strict";
import { contentSignals, extractText, minhash, normalizeText, signatureSimilarity } from "./era-corrective-audit.mjs";

test("normalization preserves Indic joiners and removes bidi controls", () => {
  assert.equal(normalizeText(" A\u202E  क\u200Dष "), "a क\u200Dष");
});

test("extracts both supported training schemas", () => {
  assert.equal(extractText({ messages:[{content:"a"},{content:"b"}] }), "a\nb");
  assert.equal(extractText({ interactions:[["q","r"]] }), "q\nr");
});

test("similar text has high MinHash similarity", () => {
  const a = minhash("one two three four five six seven eight nine ten");
  const b = minhash("one two three four five six seven eight nine ten");
  assert.equal(signatureSimilarity(a,b), 1);
});

test("content signals count boilerplate and refusals", () => {
  const s = contentSignals("As an AI language model, I cannot assist with that.");
  assert.equal(s.ai_boilerplate, true);
  assert.equal(s.refusal, true);
});
