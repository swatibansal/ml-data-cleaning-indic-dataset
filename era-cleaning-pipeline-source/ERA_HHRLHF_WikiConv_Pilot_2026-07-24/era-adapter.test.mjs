import test from "node:test";
import assert from "node:assert/strict";
import { adaptSourceRow } from "./era-multilingual-path-adapter.mjs";

test("materializes complete exchanges and holds out unmatched suffix", () => {
  const result = adaptSourceRow(
    {
      doc_id: "doc-1",
      num_turns: 2,
      eng_Latn: [["q1", "a1", "q2"]],
      hin_Deva: [["प्रश्न", "उत्तर"]],
    },
    7,
    "Wiki_Conv",
  );
  assert.equal(result.metrics.discoveredPaths, 2);
  assert.equal(result.metrics.discoveredCompleteExchanges, 2);
  assert.equal(result.structural.length, 1);
  assert.equal(result.structural[0].unmatched_user_suffix, "q2");
  assert.equal(result.selected.interactions.length, 1);
});

test("keeps alternative paths independent", () => {
  const result = adaptSourceRow(
    {
      doc_id: "doc-2",
      num_turns: 2,
      eng_Latn: [
        ["q1", "a1"],
        ["q2", "a2"],
      ],
    },
    8,
    "HHRLHF_T",
  );
  assert.equal(result.metrics.materializablePaths, 2);
  assert.equal(result.selected.interactions.length, 1);
});

test("selection is deterministic", () => {
  const row = {
    doc_id: "doc-3",
    num_turns: 1,
    eng_Latn: [["q", "a"]],
    ben_Beng: [["প্রশ্ন", "উত্তর"]],
  };
  assert.deepEqual(
    adaptSourceRow(row, 9, "Wiki_Conv").selected,
    adaptSourceRow(row, 9, "Wiki_Conv").selected,
  );
});
