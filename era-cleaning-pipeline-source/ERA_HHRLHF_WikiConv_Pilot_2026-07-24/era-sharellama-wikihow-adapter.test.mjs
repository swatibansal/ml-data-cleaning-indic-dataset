import test from "node:test";
import assert from "node:assert/strict";
import { adaptSourceRow } from "./era-multilingual-path-adapter.mjs";

// Fixtures mirror the two regenerated 2026-07-25 samples' observed shapes:
//   - Indic_ShareLlama: ShareGPT-style, carries __index_level_0__, List(List(string)).
//   - WikiHow: long-form how-to, NO __index_level_0__ column, List(List(string)).
// Both are exercised through the SAME generic multilingual-path adapter; no
// dataset-specific adapter code was added. These tests pin the frozen behaviour
// (one deterministic path per source row, alternative paths never merged,
// unmatched suffix -> structural holdout, ZWNJ/ZWJ preserved) for each shape.

test("Indic_ShareLlama: ShareGPT row with __index_level_0__ materializes one path per row", () => {
  const row = {
    doc_id: "cebcd799-be2e-4892-92f3-1d5b45e0ce2e",
    num_turns: 1,
    eng_Latn: [["from where do water come from to earth?", "Water reaches Earth ..."]],
    hin_Deva: [["पृथ्वी पर पानी कहाँ से आता है?", "पृथ्वी पर पानी ..."]],
    __index_level_0__: 0,
  };
  const result = adaptSourceRow(row, 0, "Indic_ShareLlama");
  assert.equal(result.metrics.populatedLanguages, 2);
  assert.equal(result.metrics.discoveredPaths, 2);
  assert.equal(result.metrics.discoveredCompleteExchanges, 2);
  assert.equal(result.metrics.materializablePaths, 2);
  // Exactly one path is selected for the bounded pilot; both remain counted.
  assert.equal(result.selected.interactions.length, 1);
  assert.equal(result.selected._era_provenance.original_source_index, 0);
  assert.equal(result.structural.length, 0);
});

test("WikiHow: long-form row with NO __index_level_0__ falls back to source index", () => {
  const row = {
    doc_id: "2043615f-645e-445e-b3d0-1558112e9393",
    num_turns: 1,
    eng_Latn: [[
      "How to conduct an online workshop?\n\nProvide a response in summary steps.",
      "1. Pick a platform.\n2. Send invites.\n3. Prepare an agenda.",
    ]],
    hin_Deva: [[
      "ऑनलाइन कार्यशाला कैसे आयोजित करें?\n\nसंक्षिप्त चरणों में प्रतिक्रिया प्रदान करें।",
      "१. एक मंच चुनें।\n२. निमंत्रण भेजें।",
    ]],
  };
  const result = adaptSourceRow(row, 42, "WikiHow");
  assert.equal(result.metrics.materializablePaths, 2);
  assert.equal(result.selected.interactions.length, 1);
  // No __index_level_0__ => provenance.original_source_index falls back to the
  // physical source row index (deterministic source-order prefix).
  assert.equal(result.selected._era_provenance.original_source_index, 42);
});

test("WikiHow: unmatched final user message routes to reversible structural holdout", () => {
  const row = {
    doc_id: "wh-suffix",
    num_turns: 2,
    eng_Latn: [["How to bake?", "Preheat, mix, bake.", "How long?"]],
  };
  const result = adaptSourceRow(row, 1, "WikiHow");
  assert.equal(result.selected.interactions.length, 1); // preceding exchange retained
  assert.equal(result.structural.length, 1);
  assert.equal(result.structural[0].unmatched_user_suffix, "How long?");
  assert.deepEqual(result.structural[0].reasons, ["unmatched_user_suffix"]);
});

test("ZWNJ and ZWJ are preserved through adaptation (Brahmic half-characters)", () => {
  // U+200C ZWNJ, U+200D ZWJ must survive verbatim in materialized text.
  const zwnj = "‌";
  const zwj = "‍";
  const q = `क${zwnj}ष प्रश्न${zwj}जोड़`;
  const a = `उत्तर${zwnj}${zwj}पाठ`;
  const row = { doc_id: "zw", num_turns: 1, hin_Deva: [[q, a]] };
  const result = adaptSourceRow(row, 3, "Indic_ShareLlama");
  const [gotQ, gotA] = result.selected.interactions[0];
  assert.ok(gotQ.includes(zwnj) && gotQ.includes(zwj), "ZWNJ/ZWJ preserved in prompt");
  assert.ok(gotA.includes(zwnj) && gotA.includes(zwj), "ZWNJ/ZWJ preserved in response");
});

test("alternative multilingual paths are never merged and selection is deterministic", () => {
  const row = {
    doc_id: "multi",
    num_turns: 1,
    eng_Latn: [["q-en", "a-en"]],
    tam_Taml: [["கேள்வி", "பதில்"]],
    urd_Arab: [["سوال", "جواب"]],
    __index_level_0__: 5,
  };
  const first = adaptSourceRow(row, 5, "Indic_ShareLlama");
  const second = adaptSourceRow(row, 5, "Indic_ShareLlama");
  assert.equal(first.metrics.materializablePaths, 3);
  // Selected unit carries exactly one language column; paths are not concatenated.
  assert.equal(first.selected.interactions.length, 1);
  assert.deepEqual(first.selected, second.selected);
});
