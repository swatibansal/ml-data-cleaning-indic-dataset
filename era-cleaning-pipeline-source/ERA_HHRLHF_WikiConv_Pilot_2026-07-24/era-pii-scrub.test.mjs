import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  PII_PLACEHOLDER_VOCABULARY,
  PII_NEW_TYPES_THIS_PHASE,
  PLACEHOLDER_VOCABULARY_CALLOUT,
  placeholderTemplate,
  placeholderToken,
  placeholderFor,
  createConversationIndexer,
  resolveNonOverlapping,
  scrubText,
  scrubUnit,
  reconstructUnit,
  scrubRetainedStream,
  verifyReconstruction,
} from "./era-pii-scrub.mjs";
import { analyzePrivacy } from "./stage6-privacy-audit.mjs";

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "era-scrub-test-"));
}

function unit(id, prompt, response, language = "eng_Latn") {
  return {
    id,
    interactions: [[prompt, response]],
    num_turns: 1,
    _era_provenance: { language_column: language },
  };
}

test("placeholder token follows S6-R5 convention [<TYPE_UPPER>_<n>]", () => {
  assert.equal(placeholderToken("email", 1), "[EMAIL_1]");
  assert.equal(placeholderToken("phone_candidate", 2), "[PHONE_CANDIDATE_2]");
  assert.equal(placeholderToken("ipv4_address", 1), "[IPV4_ADDRESS_1]");
  assert.equal(placeholderToken("payment_card_candidate", 3), "[PAYMENT_CARD_CANDIDATE_3]");
  assert.equal(placeholderToken("twelve_digit_id_candidate", 1), "[TWELVE_DIGIT_ID_CANDIDATE_1]");
  assert.equal(placeholderToken("indian_mobile_candidate", 1), "[INDIAN_MOBILE_CANDIDATE_1]");
  assert.equal(
    placeholderToken("indian_bank_account_context_candidate", 1),
    "[INDIAN_BANK_ACCOUNT_CONTEXT_CANDIDATE_1]",
  );
});

test("documented vocabulary lists templates for the previous-convention and new types", () => {
  assert.equal(PII_PLACEHOLDER_VOCABULARY.email, "[EMAIL_n]");
  assert.equal(PII_PLACEHOLDER_VOCABULARY.phone_candidate, "[PHONE_CANDIDATE_n]");
  assert.equal(PII_PLACEHOLDER_VOCABULARY.ipv4_address, "[IPV4_ADDRESS_n]");
  assert.equal(PII_PLACEHOLDER_VOCABULARY.payment_card_candidate, "[PAYMENT_CARD_CANDIDATE_n]");
  // Types present in the previous convention but with no findings in this phase.
  assert.equal(PII_PLACEHOLDER_VOCABULARY.secret_placeholder, "[SECRET_PLACEHOLDER_n]");
  assert.equal(PII_PLACEHOLDER_VOCABULARY.generic_secret_candidate, "[GENERIC_SECRET_CANDIDATE_n]");
  assert.equal(PII_PLACEHOLDER_VOCABULARY.indian_pan_candidate, "[INDIAN_PAN_CANDIDATE_n]");
  assert.equal(PII_PLACEHOLDER_VOCABULARY.indian_ifsc_candidate, "[INDIAN_IFSC_CANDIDATE_n]");
  assert.equal(PII_PLACEHOLDER_VOCABULARY.indian_upi_context_candidate, "[INDIAN_UPI_CONTEXT_CANDIDATE_n]");
  assert.equal(placeholderTemplate("email"), "[EMAIL_n]");
});

test("the three new-this-phase types are declared as such", () => {
  assert.deepEqual([...PII_NEW_TYPES_THIS_PHASE].sort(), [
    "indian_bank_account_context_candidate",
    "indian_mobile_candidate",
    "twelve_digit_id_candidate",
  ]);
});

test("required call-out cites the previous datasets' Stage 6 (S6-R5) policy", () => {
  assert.ok(PLACEHOLDER_VOCABULARY_CALLOUT.includes("S6-R5"));
  assert.ok(PLACEHOLDER_VOCABULARY_CALLOUT.includes("Anudesh/Dolly_T/OpenAssistant_T/Wiki_Chat"));
  assert.ok(PLACEHOLDER_VOCABULARY_CALLOUT.includes("ERA_Project_Complete_Documentation_2026-07-24"));
  assert.ok(PLACEHOLDER_VOCABULARY_CALLOUT.includes("repeated-reference consistency"));
  assert.ok(PLACEHOLDER_VOCABULARY_CALLOUT.includes("new in this phase"));
});

test("every detector type this build can emit produces a well-formed token", () => {
  const samples = [
    "Email a@b.com, phone +1 (919) 555-0123, IP 10.0.0.1, card 4111 1111 1111 1111.",
    "Aadhaar 2345 6789 0123 and PAN ABCDE1234F with GSTIN 27ABCDE1234F1Z5.",
    "IFSC HDFC0001234, UPI user@okhdfc, bank account number 123456789012345.",
    "Passport A1234567, voter EPIC ABC1234567, driving licence MH12 20120001234.",
    "AWS AKIAIOSFODNN7EXAMPLE token eyJab.cdef.ghij and api_key = s3cr3tvalue123.",
    "-----BEGIN RSA PRIVATE KEY-----",
    "ration card ABC1234 issued last year for the family here in the village now.",
  ];
  for (const text of samples) {
    for (const finding of analyzePrivacy(text)) {
      const token = placeholderFor(finding.type, 1);
      assert.match(token, /^\[[A-Z0-9_]+_1\]$/, `type ${finding.type} produced ${token}`);
    }
  }
});

test("placeholderFor throws loudly for a non-string type (no silent pass-through)", () => {
  assert.throws(() => placeholderFor(null), /No PII placeholder/);
});

test("overlap resolution keeps the longest match, then the earliest start", () => {
  const findings = [
    { type: "a", start: 0, end: 5 },
    { type: "b", start: 2, end: 10 }, // longest, overlaps a
    { type: "c", start: 12, end: 15 },
  ];
  const kept = resolveNonOverlapping(findings);
  assert.deepEqual(
    kept.map((f) => f.type),
    ["b", "c"],
  );
});

test("scrubText replaces only matched spans and leaves surrounding text byte-for-byte", () => {
  const text = "Reach me at a@example.com today please.";
  const { scrubbed, spans, detected } = scrubText(text);
  assert.equal(scrubbed, "Reach me at [EMAIL_1] today please.");
  assert.equal(spans.length, 1);
  assert.equal(spans[0].original, "a@example.com");
  assert.equal(spans[0].type, "email");
  assert.equal(spans[0].placeholder, "[EMAIL_1]");
  assert.equal(detected.length, 1);
});

test("S6-R5 repeated-reference consistency: same value -> same token, distinct values increment per type", () => {
  const indexer = createConversationIndexer();
  // Two distinct emails and a repeat of the first, across two calls sharing the indexer.
  const a = scrubText("Mail a@example.com then b@example.com about it.", indexer);
  const b = scrubText("Reply to a@example.com again for the same thread.", indexer);
  assert.equal(a.scrubbed, "Mail [EMAIL_1] then [EMAIL_2] about it.");
  // The repeat of a@example.com in the second call reuses [EMAIL_1], not a new index.
  assert.equal(b.scrubbed, "Reply to [EMAIL_1] again for the same thread.");
});

test("numbering is per type: email and phone each start at _1 in the same conversation", () => {
  const indexer = createConversationIndexer();
  const { scrubbed } = scrubText("Mail a@example.com or call +1 (919) 555-0123 today.", indexer);
  assert.ok(scrubbed.includes("[EMAIL_1]"));
  assert.ok(scrubbed.includes("[PHONE_CANDIDATE_1]"));
});

test("overlapping detectors on the same bytes: one placeholder, both findings recorded in detected", () => {
  const text = "Connect to host at 192.168.10.240 now for the sync please today.";
  const { scrubbed, spans, detected } = scrubText(text);
  const types = detected.map((d) => d.type).sort();
  assert.ok(types.includes("ipv4_address"));
  assert.ok(types.includes("phone_candidate"), "both detectors fired on the same span");
  assert.equal(spans.length, 1, "exactly one physical replacement");
  assert.equal(analyzePrivacy(scrubbed).length, 0, "zero residual on the winning token");
});

test("ZWNJ (U+200C) and ZWJ (U+200D) are preserved verbatim around a scrubbed span", () => {
  const zwnj = "‌";
  const zwj = "‍";
  const text = `प्र${zwnj}त${zwj}याशी को +1 (919) 555-0123 पर कॉल करें।`;
  const { scrubbed } = scrubText(text);
  assert.ok(scrubbed.includes(zwnj), "ZWNJ preserved");
  assert.ok(scrubbed.includes(zwj), "ZWJ preserved");
  assert.equal(scrubbed, `प्र${zwnj}त${zwj}याशी को [PHONE_CANDIDATE_1] पर कॉल करें।`);
});

test("scrubUnit is deterministic: identical input yields identical output", () => {
  const row = unit("d1", "Call +1 (919) 555-0123 or mail a@example.com now please.", "Noted a@example.com and the number for the follow up call today.");
  const first = scrubUnit(row);
  const second = scrubUnit(row);
  assert.equal(JSON.stringify(first.scrubbedRow), JSON.stringify(second.scrubbedRow));
  assert.equal(JSON.stringify(first.audit), JSON.stringify(second.audit));
});

test("conversation numbering is consistent ACROSS turns (same email reused in the answer)", () => {
  const row = unit(
    "x1",
    "Please email a@example.com about the ticket sometime this afternoon today.",
    "Sure, I have emailed a@example.com about the ticket just now as requested.",
  );
  const { scrubbedRow } = scrubUnit(row);
  const [prompt, response] = scrubbedRow.interactions[0];
  assert.ok(prompt.includes("[EMAIL_1]"));
  // The SAME value in the response reuses [EMAIL_1], not [EMAIL_2].
  assert.ok(response.includes("[EMAIL_1]"));
  assert.equal(response.includes("[EMAIL_2]"), false);
});

test("scrubUnit + reconstructUnit reproduces the original unit byte-for-byte (with repeats)", () => {
  const row = unit(
    "r1",
    "Mail a@example.com and a@example.com again, call +1 (919) 555-0123, ip 10.0.0.1.",
    "Recorded a@example.com, +1 (919) 555-0124, and 10.0.0.1 for the ticket please.",
  );
  const originalStr = JSON.stringify(row);
  const { scrubbedRow, audit } = scrubUnit(row);
  assert.notEqual(JSON.stringify(scrubbedRow), originalStr, "something was scrubbed");
  const reconstructed = reconstructUnit(scrubbedRow, audit);
  assert.equal(JSON.stringify(reconstructed), originalStr);
});

test("scrubbed retained stream has ZERO residual detector findings (numbered tokens do not re-fire)", () => {
  const dir = tmpdir();
  const input = path.join(dir, "retained.jsonl");
  const rows = [
    unit("z1", "Email a@example.com, phone +1 (919) 555-0123, IP 10.0.0.1 here now.", "Card 4111 1111 1111 1111 and id 234567890123 recorded for you today."),
    unit("z2", "A perfectly clean conversation with no sensitive identifiers at all.", "Another clean and reasonably long answer with nothing to scrub here."),
  ];
  fs.writeFileSync(input, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const scrubbed = path.join(dir, "scrubbed.jsonl");
  const audit = path.join(dir, "audit.jsonl");
  const result = scrubRetainedStream({ input, retainedOutput: scrubbed, auditOutput: audit, component: "T" });
  assert.ok(result.findings_scrubbed >= 5);
  const scrubbedRows = fs.readFileSync(scrubbed, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  let residual = 0;
  for (const r of scrubbedRows) {
    for (const text of r.interactions.flat()) {
      residual += analyzePrivacy(text).length;
    }
  }
  assert.equal(residual, 0, "no detector re-fires on numbered placeholder text");
});

test("scrubRetainedStream + verifyReconstruction proves byte-identical reversibility over a file", () => {
  const dir = tmpdir();
  const input = path.join(dir, "retained.jsonl");
  const rows = [
    unit("v1", "Ordinary text one for the harness with nothing sensitive here at all.", "Ordinary answer one for the harness with nothing sensitive to remove."),
    unit("v2", "Contact +1 (919) 555-0123 and a@example.com about the invoice soon.", "Using +1 (919) 555-0123 and a@example.com for the invoice follow up."),
    unit("v3", "Ordinary text two for the harness with nothing sensitive here at all.", "Ordinary answer two for the harness with nothing sensitive to remove."),
  ];
  fs.writeFileSync(input, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const scrubbed = path.join(dir, "scrubbed.jsonl");
  const audit = path.join(dir, "audit.jsonl");
  const result = scrubRetainedStream({ input, retainedOutput: scrubbed, auditOutput: audit, component: "T" });
  assert.equal(result.input_units, 3);
  assert.equal(result.units_scrubbed, 1);
  const verify = verifyReconstruction({ input, retainedOutput: scrubbed, auditOutput: audit });
  assert.equal(verify.byte_identical, true);
  assert.equal(verify.reconstructed_units, 3);
});

test("audit stream carries raw spans (data stream) but the scrubbed stream does not", () => {
  const dir = tmpdir();
  const input = path.join(dir, "retained.jsonl");
  fs.writeFileSync(input, JSON.stringify(unit("a1", "Mail a@example.com now.", "Ok, a@example.com noted.")) + "\n");
  const scrubbed = path.join(dir, "scrubbed.jsonl");
  const audit = path.join(dir, "audit.jsonl");
  scrubRetainedStream({ input, retainedOutput: scrubbed, auditOutput: audit, component: "T" });
  const auditText = fs.readFileSync(audit, "utf8");
  assert.ok(auditText.includes("a@example.com"));
  const scrubbedText = fs.readFileSync(scrubbed, "utf8");
  assert.equal(scrubbedText.includes("a@example.com"), false);
  assert.ok(scrubbedText.includes("[EMAIL_1]"));
});

test("empty input yields empty, reversible output", () => {
  const dir = tmpdir();
  const input = path.join(dir, "empty.jsonl");
  fs.writeFileSync(input, "");
  const scrubbed = path.join(dir, "scrubbed.jsonl");
  const audit = path.join(dir, "audit.jsonl");
  const result = scrubRetainedStream({ input, retainedOutput: scrubbed, auditOutput: audit, component: "T" });
  assert.equal(result.input_units, 0);
  assert.equal(result.units_scrubbed, 0);
  assert.equal(fs.readFileSync(scrubbed, "utf8"), "");
  assert.equal(fs.readFileSync(audit, "utf8"), "");
  const verify = verifyReconstruction({ input, retainedOutput: scrubbed, auditOutput: audit });
  assert.equal(verify.byte_identical, true);
});
