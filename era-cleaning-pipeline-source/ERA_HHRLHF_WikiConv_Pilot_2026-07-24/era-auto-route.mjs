#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { once } from "node:events";
import {
  bandKeys,
  characterShingles,
  isNearDuplicate,
  normalizeForSimilarity,
  simhash64,
} from "./stage5-dedup-audit.mjs";
import { analyzePrivacy } from "./stage6-privacy-audit.mjs";
import { classifySecurityTurn } from "./stage7-security-audit.mjs";
import {
  PII_PLACEHOLDER_VOCABULARY,
  PII_NEW_TYPES_THIS_PHASE,
  PLACEHOLDER_VOCABULARY_CALLOUT,
  placeholderToken,
} from "./era-pii-scrub.mjs";
import { ContaminationScanner } from "../benchmark_registry/lib/era_lookup.mjs";

// --- Benchmark decontamination two-tier policy (policy v1, user-approved 2026-07-25) ---
// Tier 1 (auto-holdout): a canary exact match OR >= this many distinct matching
// word 8-grams (native or transliterated) within one conversation routes the unit
// to the reversible "benchmark_holdout" category.
const BENCHMARK_TIER1_WORD_GRAMS = 3; // policy v1, user-approved 2026-07-25
// Tier 2 (annotate only): 1..(TIER1-1) matching word 8-grams and no canary hit
// retains the unit with a "benchmark_overlap_candidate" annotation.
const BENCHMARK_TIER2_MIN_WORD_GRAMS = 1; // policy v1, user-approved 2026-07-25

// Privacy policy v2 (user-approved 2026-07-26): UNIFORM SCRUBBING supersedes the
// 2026-07-25 privacy-holdout decision. Routing no longer holds any unit out for
// privacy — privacy detection here is detection/annotation only (finding counts
// + calibration worksheet). Every finding in every retained unit is scrubbed
// in-place by the downstream era-pii-scrub.mjs stage (scrub-and-retain), which
// also writes a reversible audit. This constant records the policy version used
// in the routing report's privacy stanza.
const PRIVACY_POLICY_VERSION = "privacy_policy_v2_2026-07-26";
const PRIVACY_POLICY_SUPERSEDED = "privacy_candidate_policy_2026-07-25";

function locateRegistry() {
  const dir = new URL("../benchmark_registry/", import.meta.url).pathname;
  return fs.existsSync(path.join(dir, "manifest.json")) ? dir : null;
}

function buildBenchScanner() {
  // Degrade gracefully: a missing/broken registry yields null (stage => NOT RUN),
  // never a crash and never a silent skip.
  try {
    const dir = locateRegistry();
    if (!dir) return { scanner: null, blocker: "benchmark registry not installed" };
    return { scanner: new ContaminationScanner(dir), blocker: null };
  } catch (error) {
    return { scanner: null, blocker: `benchmark registry failed to load: ${error.message}` };
  }
}

function parseArguments(argv) {
  const options = {};
  const mapping = {
    "--input": "input",
    "--component": "component",
    "--retained-output": "retainedOutput",
    "--holdout-output": "holdoutOutput",
    "--candidate-output": "candidateOutput",
    "--language-validation-output": "languageValidationOutput",
    "--privacy-worksheet-output": "privacyWorksheetOutput",
    "--report": "report",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const key = mapping[argv[index]];
    if (!key) throw new Error(`Unknown argument: ${argv[index]}`);
    options[key] = argv[++index];
  }
  const optional = new Set(["privacyWorksheetOutput"]);
  for (const key of Object.values(mapping)) {
    if (!optional.has(key) && !options[key]) {
      throw new Error(`Missing required option: ${key}`);
    }
  }
  return options;
}

function normalize(value) {
  return String(value ?? "")
    .normalize("NFC")
    .toLowerCase()
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b\ufeff\u202a-\u202e\u2066-\u2069]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function conversationText(row) {
  return row.interactions.flat().join("\n");
}

function contentSignals(text) {
  const value = normalize(text);
  return {
    ai_boilerplate:
      /\b(?:as an ai(?: language model)?|i am an ai(?: language model)?)\b/u.test(
        value,
      ),
    refusal:
      /\b(?:i (?:cannot|can't|won't|am unable to)|i must refuse|cannot assist)\b/u.test(
        value,
      ),
    apology: /\b(?:i'?m sorry|i apologize)\b/u.test(value),
    uncertainty:
      /\b(?:i (?:do not|don't) know|not sure|cannot verify|may be inaccurate)\b/u.test(
        value,
      ),
  };
}

function severeMechanicalRepetition(row) {
  for (const [, response] of row.interactions) {
    const sentences = normalize(response)
      .split(/(?<=[.!?।])\s+/u)
      .map((value) => value.trim())
      .filter((value) => value.length >= 8);
    const counts = new Map();
    for (const sentence of sentences) {
      counts.set(sentence, (counts.get(sentence) ?? 0) + 1);
    }
    for (const [sentence, count] of counts) {
      if (count < 4) continue;
      const occupied = (sentence.length * count) / Math.max(1, normalize(response).length);
      if (occupied >= 0.6) return true;
    }
  }
  return false;
}

function privacySummary(row) {
  const counts = {};
  for (const text of row.interactions.flat()) {
    for (const finding of analyzePrivacy(text)) {
      counts[finding.type] = (counts[finding.type] ?? 0) + 1;
    }
  }
  return counts;
}

function privacyUnitSignalTypes(row) {
  // Distinct detector finding types present in the conversation (no raw values).
  const types = new Set();
  for (const text of row.interactions.flat()) {
    for (const finding of analyzePrivacy(text)) types.add(finding.type);
  }
  return [...types].sort();
}

function privacyUnitFindingCounts(row) {
  // Per-type finding COUNT for the conversation (a unit may carry several of a
  // type). Lets the calibration worksheet itemize every finding by type per unit
  // id, so the finding total (e.g. 82) reconciles against the units (e.g. 51).
  // No raw values — counts only.
  const counts = {};
  for (const text of row.interactions.flat()) {
    for (const finding of analyzePrivacy(text)) {
      counts[finding.type] = (counts[finding.type] ?? 0) + 1;
    }
  }
  return counts;
}

function securitySummary(row) {
  const counts = {};
  for (const [prompt, response] of row.interactions) {
    const classification = classifySecurityTurn(prompt, response);
    for (const finding of [
      ...classification.promptFindings,
      ...classification.responseFindings,
    ]) {
      counts[finding.type] = (counts[finding.type] ?? 0) + 1;
    }
  }
  return counts;
}

function mergeCounts(target, additions) {
  for (const [key, value] of Object.entries(additions)) {
    target[key] = (target[key] ?? 0) + value;
  }
}

async function writeLine(stream, value) {
  if (!stream.write(`${JSON.stringify(value)}\n`)) await once(stream, "drain");
}

async function close(stream) {
  stream.end();
  await once(stream, "finish");
}

async function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

function languageKey(row) {
  return row._era_provenance?.language_column ?? "unknown";
}

function addToBuckets(buckets, keys, id) {
  for (const key of keys) {
    const list = buckets.get(key) ?? [];
    list.push(id);
    buckets.set(key, list);
  }
}

export async function runRouting(options) {
  const inputPath = path.resolve(options.input);
  const retainedPath = path.resolve(options.retainedOutput);
  const holdoutPath = path.resolve(options.holdoutOutput);
  const candidatesPath = path.resolve(options.candidateOutput);
  const languageValidationPath = path.resolve(options.languageValidationOutput);
  const reportPath = path.resolve(options.report);
  const privacyWorksheetPath = options.privacyWorksheetOutput
    ? path.resolve(options.privacyWorksheetOutput)
    : null;
  const retained = fs.createWriteStream(retainedPath, { encoding: "utf8" });
  const holdout = fs.createWriteStream(holdoutPath, { encoding: "utf8" });
  const candidates = fs.createWriteStream(candidatesPath, { encoding: "utf8" });
  const { scanner: benchScanner, blocker: benchBlocker } =
    options.benchScanner !== undefined
      ? { scanner: options.benchScanner, blocker: options.benchBlocker ?? null }
      : buildBenchScanner();
  const reader = readline.createInterface({
    input: fs.createReadStream(inputPath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  const exactByLanguage = new Map();
  const signatures = new Map();
  const buckets = new Map();
  const counts = {
    input_units: 0,
    retained_units: 0,
    holdout_units: 0,
    exact_duplicate_holdouts: 0,
    near_duplicate_holdouts: 0,
    repetition_holdouts: 0,
    benchmark_holdouts: 0,
    privacy_holdouts: 0, // privacy policy v2 (2026-07-26): always 0; scrub-and-retain
    units_with_privacy_findings: 0, // retained units scrubbed downstream (accounting)
    near_duplicate_candidates_retained: 0,
    benchmark_overlap_candidates_retained: 0,
  };
  const signals = {};
  const privacyCandidates = {};
  const securityCandidates = {};
  // Unit-level privacy candidacy (distinct from per-finding privacyCandidates):
  // how many retained-eligible conversations carry >= 1 finding, and per type.
  const privacyUnitTypeCounts = {};
  let privacyUnitsRouted = 0;
  // Benchmark decontamination accumulators (counts only; never raw matched text).
  const benchmarkTier1Counts = {};
  const benchmarkTier2Counts = {};
  const benchmarkMatched = new Set();
  const privacyWorksheet = [];
  const languageSamples = [];

  for await (const line of reader) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    counts.input_units += 1;
    const text = conversationText(row);
    const normalized = normalizeForSimilarity(text);
    const language = languageKey(row);
    const exactKey = `${language}\u001f${normalize(text)}`;
    const canonicalExact = exactByLanguage.get(exactKey);
    const quality = contentSignals(text);
    for (const [name, hit] of Object.entries(quality)) {
      if (hit) signals[name] = (signals[name] ?? 0) + 1;
    }
    mergeCounts(privacyCandidates, privacySummary(row));
    mergeCounts(securityCandidates, securitySummary(row));

    let disposition = null;
    let canonical = null;
    let comparison = null;
    if (canonicalExact) {
      disposition = "exact_duplicate_holdout";
      canonical = canonicalExact;
    } else if (severeMechanicalRepetition(row)) {
      disposition = "repetition_holdout";
    } else if ([...normalized].length >= 80) {
      const grams = characterShingles(normalized, 5, 1200);
      const simhash = simhash64(grams);
      const keys = bandKeys(simhash).map((key) => `${language}:${key}`);
      const candidateIds = new Set();
      for (const key of keys) {
        const prior = buckets.get(key);
        if (prior) {
          for (const id of prior.slice(-25)) candidateIds.add(id);
        }
      }
      for (const priorId of candidateIds) {
        const prior = signatures.get(priorId);
        const result = isNearDuplicate(
          {
            normalizedLength: [...normalized].length,
            shingles: grams,
            simhash,
          },
          prior,
          { minimumJaccard: 0.85 },
        );
        if (!result.match) continue;
        await writeLine(candidates, {
          component: options.component,
          id: row.id,
          canonical_record_id: priorId,
          language_column: language,
          jaccard: result.jaccard,
          hamming: result.hamming,
          automatic_holdout:
            result.jaccard >= 0.95 && result.hamming <= 3,
          method: "simhash64-char5-lsh-jaccard-v1",
        });
        if (result.jaccard >= 0.95 && result.hamming <= 3) {
          disposition = "near_duplicate_holdout";
          canonical = priorId;
          comparison = result;
          break;
        }
        counts.near_duplicate_candidates_retained += 1;
      }
      if (!disposition) {
        signatures.set(row.id, {
          normalizedLength: [...normalized].length,
          shingles: grams,
          simhash,
        });
        addToBuckets(buckets, keys, row.id);
      }
    }

    // Dedup canonicality is independent of the benchmark/privacy policies below.
    // A unit that survived exact/near/repetition routing (disposition still null)
    // becomes the canonical for its exact key BEFORE the benchmark/privacy check,
    // so routing it to benchmark_holdout or privacy_holdout does not change which
    // later units are flagged as exact duplicates. The set of units that register
    // an exact key is identical to the pre-policy pipeline (which registered on
    // the retained branch only), keeping the frozen dedup decisions byte-identical.
    if (!disposition) {
      exactByLanguage.set(exactKey, row.id);
    }

    // Benchmark decontamination (RUN when the registry loaded). Whole-conversation
    // scan, matching dedup granularity. Tier 1 (canary OR >= BENCHMARK_TIER1_WORD_GRAMS
    // distinct matching word 8-grams) => benchmark_holdout. Tier 2 (1..TIER1-1
    // grams, no canary) => retain + annotation. Never stores raw matched text.
    let benchmarkAnnotation = null;
    if (!disposition && benchScanner) {
      const scan = benchScanner.scanConversation(row.interactions.flat());
      // The approved two-tier policy is defined strictly on WORD 8-gram overlaps
      // (native or transliterated) and canary exact matches. The scanner also
      // reports char-5-gram overlaps, but those are NOT used for tiering here:
      // for Indic text char-5-grams overlap incidentally at high volume, so a
      // char-only match is neither tier 1 nor tier 2 under this policy. Restrict
      // benchmark candidates to units with a canary hit or >= 1 word 8-gram.
      const wordMatches = scan.detail.filter(
        (match) => match.canary_exact || match.word_gram_overlaps > 0,
      );
      if (wordMatches.length > 0) {
        const perBenchmark = wordMatches.map((match) => ({
          benchmark: match.benchmark,
          word_gram_overlaps: match.word_gram_overlaps,
          char_gram_overlaps: match.char_gram_overlaps,
          canary_exact: match.canary_exact,
        }));
        const maxWordGrams = Math.max(
          ...wordMatches.map((match) => match.word_gram_overlaps),
        );
        const anyCanary = wordMatches.some((match) => match.canary_exact);
        const matchedBenchmarks = wordMatches.map((match) => match.benchmark);
        for (const bench of matchedBenchmarks) benchmarkMatched.add(bench);
        const tier1 = anyCanary || maxWordGrams >= BENCHMARK_TIER1_WORD_GRAMS;
        if (tier1) {
          disposition = "benchmark_holdout";
          benchmarkAnnotation = { tier: 1, matches: perBenchmark };
          for (const bench of matchedBenchmarks) {
            benchmarkTier1Counts[bench] =
              (benchmarkTier1Counts[bench] ?? 0) + 1;
          }
        } else {
          // Tier 2: BENCHMARK_TIER2_MIN_WORD_GRAMS..TIER1-1 word grams, no canary
          // => retain + annotate as benchmark_overlap_candidate.
          benchmarkAnnotation = { tier: 2, matches: perBenchmark };
          counts.benchmark_overlap_candidates_retained += 1;
          for (const bench of matchedBenchmarks) {
            benchmarkTier2Counts[bench] =
              (benchmarkTier2Counts[bench] ?? 0) + 1;
          }
        }
      }
    }

    // Privacy policy v2 (user-approved 2026-07-26): UNIFORM SCRUBBING.
    // Privacy is NO LONGER a holdout category. A retained-eligible unit carrying
    // >= 1 detector finding stays retained; its findings are scrubbed in-place by
    // the downstream era-pii-scrub.mjs stage and a reversible audit is written.
    // Here we only DETECT/ANNOTATE: record the unit's signal types (counts only,
    // no raw values) for the calibration worksheet and unit-level accounting.
    // "units_with_privacy_findings" counts retained-eligible units that will be
    // scrubbed downstream; disposition is deliberately left unchanged.
    let privacySignalTypes = [];
    if (!disposition) {
      privacySignalTypes = privacyUnitSignalTypes(row);
      if (privacySignalTypes.length > 0) {
        privacyUnitsRouted += 1;
        for (const type of privacySignalTypes) {
          privacyUnitTypeCounts[type] = (privacyUnitTypeCounts[type] ?? 0) + 1;
        }
        privacyWorksheet.push({
          component: options.component,
          id: row.id,
          language_column: language,
          detector_signal_types: privacySignalTypes,
          detector_signal_type_counts: privacyUnitFindingCounts(row),
          policy_version: PRIVACY_POLICY_VERSION,
          disposition: "retained_then_scrubbed",
        });
      }
    }

    if (disposition) {
      counts.holdout_units += 1;
      const routing = {
        disposition,
        canonical_record_id: canonical,
        jaccard: comparison?.jaccard ?? null,
        simhash_hamming: comparison?.hamming ?? null,
        reversible: true,
      };
      if (disposition === "exact_duplicate_holdout") {
        counts.exact_duplicate_holdouts += 1;
      } else if (disposition === "near_duplicate_holdout") {
        counts.near_duplicate_holdouts += 1;
      } else if (disposition === "repetition_holdout") {
        counts.repetition_holdouts += 1;
      } else if (disposition === "benchmark_holdout") {
        counts.benchmark_holdouts += 1;
        routing.original_disposition = "retained";
        routing.reason = "benchmark_decontamination_policy_v1_2026-07-25";
        routing.benchmark_tier = benchmarkAnnotation.tier;
        routing.benchmark_matches = benchmarkAnnotation.matches;
      }
      await writeLine(holdout, { ...row, _era_routing: routing });
    } else {
      counts.retained_units += 1;
      const retainedRow = {
        ...row,
        _era_quality_annotations: Object.entries(quality)
          .filter(([, hit]) => hit)
          .map(([name]) => name),
      };
      if (benchmarkAnnotation && benchmarkAnnotation.tier === 2) {
        retainedRow._era_benchmark_overlap_candidate = {
          matches: benchmarkAnnotation.matches,
        };
      }
      await writeLine(retained, retainedRow);
    }

    const score = crypto
      .createHash("sha256")
      .update("era-language-validation-v1")
      .update(row.id)
      .digest()
      .readUInt32BE(0);
    const sample = {
      score,
      source_id: row.id,
      declared_language: language,
      text: text.slice(0, 1200),
      human_language: null,
      human_script: null,
      detector_correct: null,
      reviewer_note: null,
    };
    if (languageSamples.length < 200) languageSamples.push(sample);
    else {
      let worst = 0;
      for (let index = 1; index < languageSamples.length; index += 1) {
        if (languageSamples[index].score > languageSamples[worst].score) {
          worst = index;
        }
      }
      if (score < languageSamples[worst].score) languageSamples[worst] = sample;
    }
  }
  await Promise.all([close(retained), close(holdout), close(candidates)]);
  languageSamples.sort((a, b) => a.score - b.score);
  fs.writeFileSync(
    languageValidationPath,
    `${languageSamples
      .map(({ score, ...sample }) => JSON.stringify(sample))
      .join("\n")}\n`,
  );
  // Calibration worksheet: the privacy-holdout unit ids + detector signal types
  // (counts/ids only, no raw values) for later human precision review. Emitted in
  // deterministic input order. An empty worksheet is still written as an empty file.
  if (privacyWorksheetPath) {
    fs.writeFileSync(
      privacyWorksheetPath,
      privacyWorksheet.map((entry) => JSON.stringify(entry)).join("\n") +
        (privacyWorksheet.length ? "\n" : ""),
    );
  }
  counts.units_with_privacy_findings = privacyUnitsRouted;
  if (counts.retained_units + counts.holdout_units !== counts.input_units) {
    throw new Error("Routing reconciliation failed.");
  }
  // privacy_holdouts is fixed at 0 under privacy policy v2 (scrub-and-retain).
  const holdoutCategoryTotal =
    counts.exact_duplicate_holdouts +
    counts.near_duplicate_holdouts +
    counts.repetition_holdouts +
    counts.benchmark_holdouts +
    counts.privacy_holdouts;
  if (holdoutCategoryTotal !== counts.holdout_units) {
    throw new Error("Holdout category reconciliation failed.");
  }
  if (counts.privacy_holdouts !== 0) {
    throw new Error("Privacy policy v2 requires zero privacy holdouts.");
  }
  const report = {
    schema_version: "era-automatic-routing-report-v1",
    component: options.component,
    status: "PILOT_ROUTING_COMPLETE",
    production_release_eligible: false,
    counts,
    routing_policy: {
      exact_normalized_duplicate: "exact_duplicate_holdout",
      near_duplicate_automatic:
        "Jaccard >= 0.95 AND SimHash64 Hamming distance <= 3",
      near_duplicate_annotation: "0.85 <= Jaccard < 0.95",
      canonical_selection: "earliest deterministic input order",
      comparison_unit: "complete conversation within the same language column",
      severe_mechanical_repetition:
        "sentence repeated >=4 times and occupies >=60% of response",
      benchmark_decontamination:
        "policy v1, user-approved 2026-07-25: canary OR >= " +
        `${BENCHMARK_TIER1_WORD_GRAMS} distinct matching word 8-grams => benchmark_holdout (tier 1); ` +
        `${BENCHMARK_TIER2_MIN_WORD_GRAMS}..${BENCHMARK_TIER1_WORD_GRAMS - 1} grams => retain + annotate (tier 2)`,
      privacy_candidate_policy:
        "privacy policy v2, user-approved 2026-07-26 (SUPERSEDES the 2026-07-25 privacy-holdout policy): " +
        "uniform scrubbing (scrub-and-retain). Privacy is NOT a holdout category; every finding in every " +
        "retained unit is replaced in-place by a typed, conversation-consistent numbered placeholder token " +
        "([<TYPE>_<n>], S6-R5 convention) by era-pii-scrub.mjs and the unit is retained. A reversible " +
        "pii-scrub-audit.jsonl stream preserves original spans (no data destroyed).",
      holdout_precedence:
        "exact_duplicate > near_duplicate > repetition > benchmark (one category per unit); privacy is no longer a holdout category (policy v2)",
    },
    dataset_exceptions: {
      refusal_is_quality_failure: false,
      repeated_prompt_alone_is_duplicate: false,
      hhrlhf_safety_refusals_expected: options.component === "HHRLHF_T",
      wikiconv_templates_allowed_when_continuation_differs:
        options.component === "Wiki_Conv",
    },
    content_quality: {
      status: "RUN",
      action: "ANNOTATE_EXCEPT_SEVERE_MECHANICAL_REPETITION",
      counts: signals,
    },
    privacy_detection: {
      status: "RUN",
      policy_version: PRIVACY_POLICY_VERSION,
      supersedes: PRIVACY_POLICY_SUPERSEDED,
      action:
        "PRIVACY_POLICY_V2_UNIFORM_SCRUBBING_2026-07-26; every detector finding in every retained unit " +
        "is replaced in-place by a typed, conversation-consistent numbered placeholder token " +
        "([<TYPE>_<n>], S6-R5 convention) by era-pii-scrub.mjs (scrub-and-retain); the same raw value " +
        "gets the same token within a conversation, distinct values increment per type from _1; " +
        "the scrubbed unit is RETAINED (privacy is no longer a holdout category); a reversible " +
        "pii-scrub-audit.jsonl stream preserves the original spans (no source data destroyed); no raw value stored in this report",
      // finding-level vs unit-level counts, both stated per policy requirement.
      total_detector_findings: Object.values(privacyCandidates).reduce(
        (sum, value) => sum + value,
        0,
      ),
      finding_counts: privacyCandidates,
      unit_counts: privacyUnitTypeCounts,
      units_with_privacy_findings: privacyUnitsRouted,
      units_routed_to_privacy_holdout: 0,
      placeholder_convention:
        "[<DETECTOR_TYPE_UPPERCASED>_<n>], 1-based, scoped per conversation per type; " +
        "repeated-reference consistency (same raw value -> same token within a conversation); " +
        "e.g. [EMAIL_1], [PHONE_CANDIDATE_2], [PAYMENT_CARD_CANDIDATE_1]",
      placeholder_vocabulary: Object.fromEntries(
        Object.entries(PII_PLACEHOLDER_VOCABULARY).map(([type, template]) => [
          type,
          {
            token_template: template,
            example: placeholderToken(type, 1),
            new_this_phase: PII_NEW_TYPES_THIS_PHASE.includes(type),
            used_in_component: (privacyCandidates[type] ?? 0) > 0,
          },
        ]),
      ),
      placeholder_vocabulary_new_types_this_phase: PII_NEW_TYPES_THIS_PHASE,
      placeholder_vocabulary_callout: PLACEHOLDER_VOCABULARY_CALLOUT,
      summary:
        `${Object.values(privacyCandidates).reduce((sum, value) => sum + value, 0)} detector findings across ${privacyUnitsRouted} units; all scrubbed in-place and retained (0 privacy holdouts)`,
      note:
        "finding_counts/total_detector_findings count detector matches (a unit may carry several); unit_counts and units_with_privacy_findings count distinct conversations. Under policy v2 every finding is scrubbed in-place and the unit is retained — no unit is held out for privacy and no source data is lost (originals recoverable from pii-scrub-audit.jsonl). Counts here are pre-scrub detector findings across the routing input; the actual scrubbed totals are reported by era-pii-scrub.mjs over the retained stream and reconciled in the scrub report.",
    },
    security_detection: {
      status: "RUN",
      action:
        "CANDIDATE_COUNTS_ONLY; safety/refusal content is not automatically removed",
      counts: securityCandidates,
    },
    decontamination: benchScanner
      ? {
          status: "RUN",
          action:
            "TWO_TIER_POLICY_V1_2026-07-25; tier 1 => benchmark_holdout (reversible), tier 2 => retain + benchmark_overlap_candidate annotation; never stores raw matched text",
          registry_format_version: benchScanner.manifest.registry_format_version,
          registry_installed_benchmarks: benchScanner.installedBenchmarks(),
          matched_benchmarks: [...benchmarkMatched].sort(),
          tier1_holdout_counts_per_benchmark: benchmarkTier1Counts,
          tier2_candidate_counts_per_benchmark: benchmarkTier2Counts,
          tier1_total_units: counts.benchmark_holdouts,
          tier2_total_units: counts.benchmark_overlap_candidates_retained,
        }
      : {
          status: "NOT RUN",
          reason:
            benchBlocker ??
            "The versioned benchmark registry contains no materialized protected items.",
          blockers: [
            benchBlocker ?? "benchmark registry not installed",
          ],
        },
    token_estimation: {
      status: "NOT RUN",
      reason:
        "Named tokenizer dependencies/models were not available; no heuristic count is reported as measurement.",
    },
    language_validation: {
      status: "RUN",
      sample_rows: languageSamples.length,
      human_labels_completed: 0,
    },
    outputs: {
      retained: {
        file: path.basename(retainedPath),
        sha256: await sha256File(retainedPath),
      },
      holdout: {
        file: path.basename(holdoutPath),
        sha256: await sha256File(holdoutPath),
      },
      candidates: {
        file: path.basename(candidatesPath),
        sha256: await sha256File(candidatesPath),
      },
      language_validation: {
        file: path.basename(languageValidationPath),
        sha256: await sha256File(languageValidationPath),
      },
      ...(privacyWorksheetPath
        ? {
            privacy_calibration_worksheet: {
              file: path.basename(privacyWorksheetPath),
              sha256: await sha256File(privacyWorksheetPath),
              rows: privacyWorksheet.length,
            },
          }
        : {}),
    },
  };
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(
    JSON.stringify(await runRouting(parseArguments(process.argv.slice(2))), null, 2),
  );
}
