import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runRouting } from "./era-auto-route.mjs";

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "era-route-test-"));
}

function writeInput(dir, rows) {
  const file = path.join(dir, "in.jsonl");
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return file;
}

function unit(id, prompt, response, language = "eng_Latn") {
  return {
    id,
    interactions: [[prompt, response]],
    num_turns: 1,
    _era_provenance: { language_column: language },
  };
}

function readJsonl(file) {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

// A deterministic mock scanner that reports a fixed result per conversation,
// keyed by a sentinel token embedded in the text. Lets us plant canary / tier-1 /
// tier-2 / clean cases without depending on real registry contents.
function mockScanner() {
  return {
    manifest: { registry_format_version: "1" },
    installedBenchmarks: () => ["MILU", "GSM8K"],
    scanConversation(texts) {
      const combined = texts.join("\n");
      if (combined.includes("PLANT_CANARY")) {
        return {
          is_candidate: true,
          matched_benchmarks: ["GSM8K"],
          detail: [
            { benchmark: "GSM8K", word_gram_overlaps: 0, char_gram_overlaps: 0, canary_exact: true },
          ],
        };
      }
      if (combined.includes("PLANT_TIER1")) {
        return {
          is_candidate: true,
          matched_benchmarks: ["MILU"],
          detail: [
            { benchmark: "MILU", word_gram_overlaps: 5, char_gram_overlaps: 40, canary_exact: false },
          ],
        };
      }
      if (combined.includes("PLANT_TIER2")) {
        return {
          is_candidate: true,
          matched_benchmarks: ["MILU"],
          detail: [
            { benchmark: "MILU", word_gram_overlaps: 1, char_gram_overlaps: 3, canary_exact: false },
          ],
        };
      }
      if (combined.includes("PLANT_CHARONLY")) {
        // Char-5-gram-only match: NOT a word/canary hit, must be ignored by policy.
        return {
          is_candidate: true,
          matched_benchmarks: ["MILU"],
          detail: [
            { benchmark: "MILU", word_gram_overlaps: 0, char_gram_overlaps: 900, canary_exact: false },
          ],
        };
      }
      return { is_candidate: false, matched_benchmarks: [], detail: [] };
    },
  };
}

async function route(dir, input, extra = {}) {
  const opts = {
    input,
    component: "HHRLHF_T",
    retainedOutput: path.join(dir, "retained.jsonl"),
    holdoutOutput: path.join(dir, "holdout.jsonl"),
    candidateOutput: path.join(dir, "candidates.jsonl"),
    languageValidationOutput: path.join(dir, "lang.jsonl"),
    privacyWorksheetOutput: path.join(dir, "worksheet.jsonl"),
    report: path.join(dir, "report.json"),
    ...extra,
  };
  const report = await runRouting(opts);
  return {
    report,
    retained: readJsonl(opts.retainedOutput),
    holdout: readJsonl(opts.holdoutOutput),
    worksheet: fs.readFileSync(opts.privacyWorksheetOutput, "utf8"),
  };
}

test("tier-1 canary match routes the unit to benchmark_holdout", async () => {
  const dir = tmpdir();
  const input = writeInput(dir, [
    unit("c1", "This conversation contains PLANT_CANARY somewhere in it here.", "A benign answer that is reasonably long for eligibility."),
    unit("clean1", "An ordinary question about the weather in a nice long form.", "An ordinary and reasonably long benign answer text here now."),
  ]);
  const { report, holdout, retained } = await route(dir, input, { benchScanner: mockScanner() });
  assert.equal(report.counts.benchmark_holdouts, 1);
  const held = holdout.find((r) => r._era_routing.disposition === "benchmark_holdout");
  assert.ok(held, "unit routed to benchmark_holdout");
  assert.equal(held._era_routing.benchmark_tier, 1);
  assert.equal(held._era_routing.reversible, true);
  assert.equal(held.id, "c1");
  assert.equal(retained.some((r) => r.id === "c1"), false);
});

test("tier-1 >= 3 word 8-gram overlaps routes to benchmark_holdout", async () => {
  const dir = tmpdir();
  const input = writeInput(dir, [
    unit("t1", "A prompt with the sentinel PLANT_TIER1 in a long enough body here.", "A benign but reasonably long response body for eligibility purposes."),
  ]);
  const { report, holdout } = await route(dir, input, { benchScanner: mockScanner() });
  assert.equal(report.counts.benchmark_holdouts, 1);
  assert.equal(holdout[0]._era_routing.benchmark_tier, 1);
  assert.equal(report.decontamination.status, "RUN");
});

test("1 word 8-gram overlap retains with a benchmark_overlap_candidate annotation", async () => {
  const dir = tmpdir();
  const input = writeInput(dir, [
    unit("t2", "A prompt with the sentinel PLANT_TIER2 in a long enough body here.", "A benign but reasonably long response body for eligibility purposes."),
  ]);
  const { report, retained, holdout } = await route(dir, input, { benchScanner: mockScanner() });
  assert.equal(report.counts.benchmark_holdouts, 0);
  assert.equal(report.counts.benchmark_overlap_candidates_retained, 1);
  const row = retained.find((r) => r.id === "t2");
  assert.ok(row, "tier-2 unit is retained");
  assert.ok(row._era_benchmark_overlap_candidate, "tier-2 annotation present");
  assert.equal(row._era_benchmark_overlap_candidate.matches[0].benchmark, "MILU");
  assert.equal(holdout.some((r) => r.id === "t2"), false);
});

test("char-5-gram-only match is neither tier-1 nor tier-2 (word-gram policy)", async () => {
  const dir = tmpdir();
  const input = writeInput(dir, [
    unit("co1", "A prompt with the sentinel PLANT_CHARONLY in a long enough body here.", "A benign but reasonably long response body for eligibility purposes."),
  ]);
  const { report, retained } = await route(dir, input, { benchScanner: mockScanner() });
  assert.equal(report.counts.benchmark_holdouts, 0);
  assert.equal(report.counts.benchmark_overlap_candidates_retained, 0);
  const row = retained.find((r) => r.id === "co1");
  assert.ok(row);
  assert.equal(row._era_benchmark_overlap_candidate, undefined);
});

test("a clean row is unaffected by decontamination", async () => {
  const dir = tmpdir();
  const input = writeInput(dir, [
    unit("clean", "A perfectly ordinary question about gardening in the spring season here.", "A perfectly ordinary and reasonably long answer about gardening tips."),
  ]);
  const { retained, report } = await route(dir, input, { benchScanner: mockScanner() });
  assert.equal(report.counts.benchmark_holdouts, 0);
  assert.equal(report.counts.benchmark_overlap_candidates_retained, 0);
  const row = retained.find((r) => r.id === "clean");
  assert.equal(row._era_benchmark_overlap_candidate, undefined);
});

test("privacy policy v2: unit with a finding stays retained, no privacy holdout, worksheet has no raw values", async () => {
  const dir = tmpdir();
  const input = writeInput(dir, [
    unit("p1", "Please call me at +1 (919) 555-0123 tomorrow morning if possible.", "Sure, I will contact you at the number you provided shortly."),
    unit("clean", "A perfectly ordinary question about gardening in the spring here now.", "A perfectly ordinary and reasonably long answer about gardening tips."),
  ]);
  const { report, holdout, retained, worksheet } = await route(dir, input, { benchScanner: null, benchBlocker: "registry off for test" });
  // Privacy is no longer a holdout category under policy v2.
  assert.equal(report.counts.privacy_holdouts, 0);
  assert.equal(report.counts.units_with_privacy_findings, 1);
  assert.equal(holdout.some((r) => r._era_routing.disposition === "privacy_holdout"), false);
  // The unit with the finding is RETAINED (it will be scrubbed downstream).
  assert.equal(retained.some((r) => r.id === "p1"), true);
  assert.equal(report.privacy_detection.units_routed_to_privacy_holdout, 0);
  assert.equal(report.privacy_detection.policy_version, "privacy_policy_v2_2026-07-26");
  assert.equal(
    report.privacy_detection.placeholder_vocabulary.phone_candidate.token_template,
    "[PHONE_CANDIDATE_n]",
  );
  assert.equal(
    report.privacy_detection.placeholder_vocabulary.phone_candidate.used_in_component,
    true,
  );
  assert.ok(report.privacy_detection.placeholder_vocabulary_callout.includes("S6-R5"));
  // Worksheet lists the unit id + signal types, no raw values.
  const wsRows = worksheet.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(wsRows.length, 1);
  assert.equal(wsRows[0].id, "p1");
  assert.equal(wsRows[0].disposition, "retained_then_scrubbed");
  assert.equal(worksheet.includes("555-0123"), false);
  assert.equal(worksheet.includes("919"), false);
});

test("reconciliation: retained + holdouts == input, and categories sum to holdouts", async () => {
  const dir = tmpdir();
  const input = writeInput(dir, [
    unit("h1", "A prompt with the sentinel PLANT_TIER1 in a long enough body here.", "Benign response body reasonably long for eligibility here now please."),
    unit("h2", "Call me on +1 (919) 555-0123 at your earliest convenience please today.", "Sure, noting that phone number for the callback shortly thereafter now."),
    unit("dup", "An identical conversation that appears twice for exact dedup here now.", "An identical answer that appears twice for exact dedup testing here."),
    unit("dup2", "An identical conversation that appears twice for exact dedup here now.", "An identical answer that appears twice for exact dedup testing here."),
    unit("keep", "A totally ordinary retained conversation about local trains here today.", "A totally ordinary and reasonably long answer about local train times."),
  ]);
  const { report } = await route(dir, input, { benchScanner: mockScanner() });
  const c = report.counts;
  assert.equal(c.retained_units + c.holdout_units, c.input_units);
  assert.equal(
    c.exact_duplicate_holdouts +
      c.near_duplicate_holdouts +
      c.repetition_holdouts +
      c.benchmark_holdouts +
      c.privacy_holdouts,
    c.holdout_units,
  );
  assert.equal(c.benchmark_holdouts, 1);
  // Policy v2: privacy is never a holdout; the phone unit is retained + scrubbed.
  assert.equal(c.privacy_holdouts, 0);
  assert.equal(c.units_with_privacy_findings, 1);
  assert.equal(c.exact_duplicate_holdouts, 1);
});

test("decontamination degrades to NOT RUN with a blocker when the registry is absent", async () => {
  const dir = tmpdir();
  const input = writeInput(dir, [
    unit("x", "An ordinary retained conversation that is long enough for eligibility.", "An ordinary and reasonably long benign answer for the routing test."),
  ]);
  const { report } = await route(dir, input, { benchScanner: null, benchBlocker: "benchmark registry not installed" });
  assert.equal(report.decontamination.status, "NOT RUN");
  assert.deepEqual(report.decontamination.blockers, ["benchmark registry not installed"]);
  assert.equal(report.counts.retained_units + report.counts.holdout_units, report.counts.input_units);
});

test("benchmark holdout still applies to a unit that also carries a privacy finding", async () => {
  const dir = tmpdir();
  const input = writeInput(dir, [
    unit("both", "PLANT_TIER1 and also please call +1 (919) 555-0123 when you can here.", "Benign response body reasonably long for eligibility purposes now."),
  ]);
  const { report, holdout } = await route(dir, input, { benchScanner: mockScanner() });
  assert.equal(report.counts.benchmark_holdouts, 1);
  assert.equal(report.counts.privacy_holdouts, 0);
  assert.equal(holdout[0]._era_routing.disposition, "benchmark_holdout");
  // Benchmark-held-out units are not scrubbed (their stream is not exported for
  // training), so they do not count toward units_with_privacy_findings.
  assert.equal(report.counts.units_with_privacy_findings, 0);
});
