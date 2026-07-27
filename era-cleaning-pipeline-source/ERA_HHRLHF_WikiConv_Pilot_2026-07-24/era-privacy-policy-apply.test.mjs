import test from "node:test";
import assert from "node:assert/strict";
import {
  applyPolicy,
  restorePolicy,
  privacyUnitSignalTypes,
  PRIVACY_POLICY_REASON,
} from "./era-privacy-policy-apply.mjs";

function unit(id, prompt, response, language = "eng_Latn") {
  return {
    id,
    interactions: [[prompt, response]],
    num_turns: 1,
    _era_provenance: { language_column: language },
  };
}

test("privacyUnitSignalTypes returns sorted distinct finding types, no raw values", () => {
  const row = unit(
    "u",
    "Call +1 (919) 555-0123 or mail a@example.com, IP 10.0.0.1 also.",
    "Noted your phone, email and address for the follow up call today.",
  );
  const types = privacyUnitSignalTypes(row);
  assert.deepEqual([...types].sort(), types); // already sorted
  assert.ok(types.includes("phone_candidate"));
  assert.ok(types.includes("email"));
  assert.ok(types.includes("ipv4_address"));
});

test("apply moves only units with a finding; unit-level not finding-level count", () => {
  const pre = [
    unit("a", "Ordinary long text one for the harness with nothing sensitive here.", "Ordinary long answer one for the harness with nothing sensitive."),
    // one unit with THREE distinct phone findings -> still ONE held-out unit
    unit("b", "Numbers: +1 (919) 555-0123, +1 (919) 555-0124, +1 (919) 555-0125.", "Recorded all three of the phone numbers you sent for the callback."),
    unit("c", "Ordinary long text two for the harness with nothing sensitive here.", "Ordinary long answer two for the harness with nothing sensitive."),
  ];
  const { postRetained, privacyHoldout, unitTypeCounts } = applyPolicy(pre, "Wiki_Conv");
  assert.equal(privacyHoldout.length, 1, "one distinct unit held out despite multiple findings");
  assert.equal(postRetained.length, 2);
  assert.equal(privacyHoldout[0].reason, PRIVACY_POLICY_REASON);
  assert.equal(privacyHoldout[0].original_disposition, "retained");
  assert.equal(privacyHoldout[0].reversible, true);
  // unit-level type count: phone_candidate counted once for this unit
  assert.equal(unitTypeCounts.phone_candidate, 1);
});

test("apply then restore reproduces the pre-policy stream byte-for-byte", () => {
  const pre = [
    unit("a", "Ordinary long text one for the harness with nothing sensitive here.", "Ordinary long answer one for the harness with nothing sensitive."),
    unit("b", "Reach me at +1 (919) 555-0123 for the scheduled follow up call soon.", "Understood, using that phone number for the follow up call now."),
    unit("c", "Ordinary long text two for the harness with nothing sensitive here.", "Ordinary long answer two for the harness with nothing sensitive."),
    unit("d", "Mail me at person@example.com about the invoice details this week.", "Will email person@example.com the invoice details later this week."),
  ];
  const preStr = pre.map((r) => JSON.stringify(r)).join("\n") + "\n";
  const { postRetained, privacyHoldout } = applyPolicy(pre, "Wiki_Conv");
  assert.equal(privacyHoldout.length, 2);
  const restored = restorePolicy(postRetained, privacyHoldout);
  const restoredStr = restored.map((r) => JSON.stringify(r)).join("\n") + "\n";
  assert.equal(restoredStr, preStr);
});

test("restore rejects a corrupt index rather than silently misordering", () => {
  const post = [unit("a", "one long harmless conversation body for the test here now.", "one long harmless answer body.")];
  const bad = [
    {
      id: "z",
      pre_policy_retained_index: 99,
      record: unit("z", "x", "y"),
    },
  ];
  assert.throws(() => restorePolicy(post, bad), /invalid pre_policy_retained_index/);
});

test("empty input yields empty, reversible output", () => {
  const { postRetained, privacyHoldout } = applyPolicy([], "HHRLHF_T");
  assert.equal(postRetained.length, 0);
  assert.equal(privacyHoldout.length, 0);
  assert.deepEqual(restorePolicy(postRetained, privacyHoldout), []);
});
