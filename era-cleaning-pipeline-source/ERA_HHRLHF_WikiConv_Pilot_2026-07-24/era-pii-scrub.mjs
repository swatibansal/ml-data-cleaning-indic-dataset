#!/usr/bin/env node
// ERA Phase 1 — deterministic, reversible PII scrubbing (privacy policy v2).
//
// User-approved policy (2026-07-26): UNIFORM SCRUBBING (scrub-and-retain)
// supersedes the 2026-07-25 privacy-holdout decision. Every privacy detector
// finding in every RETAINED unit is replaced in place by a typed placeholder
// token; the unit stays in the retained (training-exported) stream. No unit is
// held out for privacy anymore, and no source data is destroyed: for every
// scrubbed unit an audit record is written to a separate DATA stream carrying
// the original spans (offsets + types + raw values, allowed in the data stream
// exactly as holdout files already carry raw conversations, NEVER in reports),
// so that   original  <=>  scrubbed + audit   reconstructs byte-identically.
//
// Placeholder vocabulary follows the Stage 6 policy (S6-R5) of the previously
// cleaned datasets (Anudesh/Dolly_T/OpenAssistant_T/Wiki_Chat, recovered from
// ERA_Project_Complete_Documentation_2026-07-24): typed replacements, numbered
// with repeated-reference consistency within a conversation.
//
// Determinism:
//   - Detector findings are produced by the SAME stage-6 analyzer as the
//     privacy detection stage, so findings == scrubbed spans.
//   - Overlap resolution is fixed and documented: LONGEST match wins, then
//     EARLIEST start. Surviving spans are applied left-to-right by offset.
//   - Only matched spans change; all surrounding bytes (including ZWNJ U+200C
//     and ZWJ U+200D) are copied through verbatim.
//   - Re-running scrub on the same input yields byte-identical outputs.

import fs from "node:fs";
import path from "node:path";
import { analyzePrivacy } from "./stage6-privacy-audit.mjs";

export const PRIVACY_POLICY_VERSION = "privacy_policy_v2_2026-07-26";

// Required call-out sentence, documented verbatim in every routing report.
export const PLACEHOLDER_VOCABULARY_CALLOUT =
  "Placeholder vocabulary follows the Stage 6 policy (S6-R5) of the previously " +
  "cleaned datasets (Anudesh/Dolly_T/OpenAssistant_T/Wiki_Chat, " +
  "ERA_Project_Complete_Documentation_2026-07-24): typed replacements with " +
  "repeated-reference consistency within a conversation. Three detector types " +
  "new in this phase are named following the same convention.";

// Canonical placeholder convention (Stage 6 policy S6-R5, recovered from the
// previously cleaned datasets). A finding's token is the detector TYPE NAME,
// uppercased, followed by a 1-based index and wrapped in square brackets:
//   [<TYPE>_<n>]   e.g. [EMAIL_1], [PHONE_CANDIDATE_2], [PAYMENT_CARD_CANDIDATE_1]
// The index is assigned per CONVERSATION per TYPE with repeated-reference
// consistency: the SAME raw value gets the SAME token everywhere in that
// conversation; DISTINCT values get incrementing indices in order of first
// occurrence, starting at _1. Numbering is scoped per conversation (it resets
// for the next unit) and per type (each type has its own _1, _2, ...).
//
// This is derived uniformly for every detector type (no hand-maintained table),
// so a new detector type is named in the same convention automatically. The map
// below is the DOCUMENTED, un-indexed vocabulary (token TEMPLATES) for reports:
// every type the stage-6 detectors can emit, with a `used` flag per component
// filled in by the scrub stage. Types marked here are for documentation only.
export const PII_PLACEHOLDER_TYPES = Object.freeze([
  // Convention shared with the previous four datasets' Stage 6 policy:
  "email",
  "phone_candidate",
  "ipv4_address",
  "payment_card_candidate",
  "secret_placeholder",
  "generic_secret_candidate",
  "indian_pan_candidate",
  "indian_ifsc_candidate",
  "indian_upi_context_candidate",
  // New detector types this phase (named following the same convention):
  "twelve_digit_id_candidate",
  "indian_mobile_candidate",
  "indian_bank_account_context_candidate",
  // Other stage-6 detector types this build can emit (same convention):
  "indian_aadhaar_valid_checksum",
  "indian_aadhaar_context_candidate",
  "indian_gstin_valid_checksum",
  "indian_gstin_format_candidate",
  "indian_driving_licence_candidate",
  "indian_passport_context_candidate",
  "indian_epic_context_candidate",
  "indian_ration_card_context_candidate",
  "aws_access_key",
  "jwt_candidate",
  "private_key_header",
]);

// Detector types NEW in this phase (documented as such per the required call-out).
export const PII_NEW_TYPES_THIS_PHASE = Object.freeze([
  "twelve_digit_id_candidate",
  "indian_mobile_candidate",
  "indian_bank_account_context_candidate",
]);

// Un-indexed token TEMPLATE for a type: [<TYPE_UPPER>_n]. For the report's
// documented vocabulary. The live token substitutes the per-conversation index.
export function placeholderTemplate(type) {
  return `[${type.toUpperCase()}_n]`;
}

// The indexed token actually written into text: [<TYPE_UPPER>_<index>].
export function placeholderToken(type, index) {
  return `[${type.toUpperCase()}_${index}]`;
}

// Documented vocabulary object (type -> token template) for routing reports.
export const PII_PLACEHOLDER_VOCABULARY = Object.freeze(
  Object.fromEntries(
    PII_PLACEHOLDER_TYPES.map((type) => [type, placeholderTemplate(type)]),
  ),
);

// Retained for backward-compatible callers: the documented template map.
export const PII_PLACEHOLDERS = PII_PLACEHOLDER_VOCABULARY;

// Every detector type resolves to a token uniformly, so this never throws for a
// real finding; kept as a guard so a non-string type fails loudly.
export function placeholderFor(type, index = 1) {
  if (typeof type !== "string" || !type) {
    throw new Error(`No PII placeholder for detector type: ${String(type)}`);
  }
  return placeholderToken(type, index);
}

// Resolve overlaps deterministically: LONGEST match wins, then EARLIEST start.
// Returns the surviving, non-overlapping findings sorted by start offset.
export function resolveNonOverlapping(findings) {
  const ordered = [...findings].sort((left, right) => {
    const leftLength = left.end - left.start;
    const rightLength = right.end - right.start;
    if (rightLength !== leftLength) return rightLength - leftLength; // longest first
    if (left.start !== right.start) return left.start - right.start; // then earliest
    if (left.end !== right.end) return left.end - right.end;
    return left.type < right.type ? -1 : left.type > right.type ? 1 : 0;
  });
  const kept = [];
  for (const finding of ordered) {
    const overlaps = kept.some(
      (other) => finding.start < other.end && other.start < finding.end,
    );
    if (!overlaps) kept.push(finding);
  }
  kept.sort((left, right) => left.start - right.start || left.end - right.end);
  return kept;
}

// A conversation-scoped indexer implementing S6-R5 repeated-reference
// consistency. For a (type, rawValue) pair it returns a stable 1-based index:
// the SAME raw value always maps to the SAME index within the conversation;
// DISTINCT values of a type get incrementing indices in order of first request.
// Numbering is per type (each type keeps its own counter) and per conversation
// (a fresh indexer is created for each unit).
export function createConversationIndexer() {
  const perType = new Map(); // type -> { counter, byValue: Map(rawValue -> index) }
  return {
    indexFor(type, rawValue) {
      let state = perType.get(type);
      if (!state) {
        state = { counter: 0, byValue: new Map() };
        perType.set(type, state);
      }
      const existing = state.byValue.get(rawValue);
      if (existing !== undefined) return existing;
      state.counter += 1;
      state.byValue.set(rawValue, state.counter);
      return state.counter;
    },
  };
}

// Scrub a single text string. Returns { scrubbed, spans, detected } where:
//   - `spans` are the physical, NON-OVERLAPPING replaced spans (start order),
//     each carrying the raw original slice and the indexed placeholder token —
//     this is what reconstruction uses.
//   - `detected` are ALL raw detector findings (type + offsets), INCLUDING ones
//     that a longer overlapping span subsumed. Two detectors can match the same
//     bytes (e.g. an IPv4 also matches phone_candidate; a phone also matches
//     indian_mobile / twelve_digit_id); only one placeholder can be written, but
//     every finding is still recorded so the per-type "findings_detected" counts
//     reconcile exactly with the routing report's finding_counts (the raw
//     detector total). No finding is silently dropped from the accounting.
//
// `indexer` is the conversation-scoped S6-R5 indexer; when omitted a fresh
// (message-scoped) one is used, so scrubText remains usable in isolation.
export function scrubText(text, indexer = createConversationIndexer()) {
  if (typeof text !== "string") {
    throw new TypeError("PII scrub requires string text.");
  }
  const rawFindings = analyzePrivacy(text);
  const detected = rawFindings.map((finding) => ({
    type: finding.type,
    original_start: finding.start,
    original_end: finding.end,
  }));
  const findings = resolveNonOverlapping(rawFindings);
  if (findings.length === 0) return { scrubbed: text, spans: [], detected };
  let output = "";
  let cursor = 0;
  const spans = [];
  for (const finding of findings) {
    const original = text.slice(finding.start, finding.end);
    // Repeated-reference consistency keys on the raw value AFTER overlap
    // resolution, so the same masked bytes always get the same numbered token.
    const index = indexer.indexFor(finding.type, original);
    const placeholder = placeholderToken(finding.type, index);
    output += text.slice(cursor, finding.start);
    output += placeholder;
    spans.push({
      type: finding.type,
      original_start: finding.start,
      original_end: finding.end,
      original: original,
      placeholder,
    });
    cursor = finding.end;
  }
  output += text.slice(cursor);
  return { scrubbed: output, spans, detected };
}

// Scrub every message of a unit's interactions in place. Returns the scrubbed
// unit plus a per-message audit list keyed by (interaction index, message role)
// so reconstruction can address each string uniquely and deterministically.
export function scrubUnit(row) {
  const interactions = Array.isArray(row.interactions) ? row.interactions : [];
  const scrubbedInteractions = [];
  const audit = [];
  // Two accountings, both reported (never conflated):
  //   detected*  = raw detector findings (matches the routing report's total)
  //   replaced*  = physical placeholder substitutions (post overlap-resolution)
  let detectedCount = 0;
  let replacedCount = 0;
  const detectedTypeCounts = {};
  const replacedTypeCounts = {};
  // One indexer for the whole conversation gives S6-R5 repeated-reference
  // consistency ACROSS messages: the same raw value gets the same numbered token
  // in every turn; distinct values increment per type in first-occurrence order.
  const indexer = createConversationIndexer();
  interactions.forEach((pair, interactionIndex) => {
    const scrubbedPair = [];
    pair.forEach((message, roleIndex) => {
      if (typeof message !== "string") {
        scrubbedPair.push(message);
        return;
      }
      const { scrubbed, spans, detected } = scrubText(message, indexer);
      scrubbedPair.push(scrubbed);
      for (const finding of detected) {
        detectedCount += 1;
        detectedTypeCounts[finding.type] =
          (detectedTypeCounts[finding.type] ?? 0) + 1;
      }
      if (spans.length > 0 || detected.length > 0) {
        // Record replaced spans (for reconstruction) plus the full detected list
        // (for accounting). A subsumed finding has spans that reconstruction
        // ignores but the count still reflects it.
        audit.push({
          interaction_index: interactionIndex,
          message_index: roleIndex,
          spans,
          detected,
        });
        for (const span of spans) {
          replacedCount += 1;
          replacedTypeCounts[span.type] =
            (replacedTypeCounts[span.type] ?? 0) + 1;
        }
      }
    });
    scrubbedInteractions.push(scrubbedPair);
  });
  const scrubbedRow = { ...row, interactions: scrubbedInteractions };
  return {
    scrubbedRow,
    audit,
    detectedCount,
    replacedCount,
    detectedTypeCounts,
    replacedTypeCounts,
  };
}

// Reconstruct a single message from its scrubbed form and the ordered spans.
// The scrubbed message is the original with each span replaced by its
// placeholder, so we walk the scrubbed text replacing the first occurrence of
// each placeholder (in span order) back to the original slice.
export function reconstructMessage(scrubbed, spans) {
  if (spans.length === 0) return scrubbed;
  let output = "";
  let cursor = 0;
  for (const span of spans) {
    const at = scrubbed.indexOf(span.placeholder, cursor);
    if (at < 0) {
      throw new Error(
        `Reconstruction failed: placeholder ${span.placeholder} not found in scrubbed message`,
      );
    }
    output += scrubbed.slice(cursor, at);
    output += span.original;
    cursor = at + span.placeholder.length;
  }
  output += scrubbed.slice(cursor);
  return output;
}

// Reconstruct a full unit from its scrubbed form + audit spans.
export function reconstructUnit(scrubbedRow, audit) {
  const interactions = (scrubbedRow.interactions ?? []).map((pair) => [...pair]);
  for (const entry of audit) {
    const { interaction_index: ii, message_index: mi, spans } = entry;
    interactions[ii][mi] = reconstructMessage(interactions[ii][mi], spans);
  }
  return { ...scrubbedRow, interactions };
}

function readJsonl(file) {
  const raw = fs.readFileSync(file, "utf8");
  if (!raw) return [];
  return raw
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

// Stream-scrub a retained JSONL file. Writes the scrubbed retained stream and,
// for every unit that had >= 1 finding, one audit record to the audit stream.
// Returns accounting counts (no raw values).
export function scrubRetainedStream({ input, retainedOutput, auditOutput, component }) {
  const rows = readJsonl(input);
  const scrubbedLines = [];
  const auditLines = [];
  let unitsScrubbed = 0;
  let findingsDetected = 0;
  let spansReplaced = 0;
  const findingsDetectedByType = {};
  const spansReplacedByType = {};
  for (const row of rows) {
    const {
      scrubbedRow,
      audit,
      detectedCount,
      replacedCount,
      detectedTypeCounts,
      replacedTypeCounts,
    } = scrubUnit(row);
    scrubbedLines.push(JSON.stringify(scrubbedRow));
    if (detectedCount > 0) {
      unitsScrubbed += 1;
      findingsDetected += detectedCount;
      spansReplaced += replacedCount;
      for (const [type, count] of Object.entries(detectedTypeCounts)) {
        findingsDetectedByType[type] = (findingsDetectedByType[type] ?? 0) + count;
      }
      for (const [type, count] of Object.entries(replacedTypeCounts)) {
        spansReplacedByType[type] = (spansReplacedByType[type] ?? 0) + count;
      }
      auditLines.push(
        JSON.stringify({
          component: component ?? row._era_provenance?.component ?? null,
          id: row.id,
          policy_version: PRIVACY_POLICY_VERSION,
          reversible: true,
          messages: audit,
        }),
      );
    }
  }
  fs.writeFileSync(
    path.resolve(retainedOutput),
    scrubbedLines.join("\n") + (scrubbedLines.length ? "\n" : ""),
  );
  fs.writeFileSync(
    path.resolve(auditOutput),
    auditLines.join("\n") + (auditLines.length ? "\n" : ""),
  );
  return {
    policy_version: PRIVACY_POLICY_VERSION,
    input_units: rows.length,
    units_scrubbed: unitsScrubbed,
    // findings_scrubbed == raw detector findings (reconciles with the routing
    // report's finding_counts / total_detector_findings over the retained stream).
    findings_scrubbed: findingsDetected,
    findings_scrubbed_by_type: findingsDetectedByType,
    // spans_replaced == physical placeholder substitutions after overlap
    // resolution (longest match wins, then earliest). <= findings_scrubbed when
    // two detectors match the same bytes and one placeholder covers both.
    spans_replaced: spansReplaced,
    spans_replaced_by_type: spansReplacedByType,
    overlap_resolution: "longest_match_wins_then_earliest_start",
  };
}

// Verify byte-identical reconstruction of the pre-scrub stream from the scrubbed
// stream + audit. Reconstructs each scrubbed unit and compares against the
// original input line for line.
export function verifyReconstruction({ input, retainedOutput, auditOutput }) {
  const original = readJsonl(input);
  const scrubbed = readJsonl(retainedOutput);
  const auditById = new Map();
  for (const entry of readJsonl(auditOutput)) auditById.set(entry.id, entry);
  if (original.length !== scrubbed.length) {
    throw new Error(
      `Reconstruction length mismatch: ${original.length} original vs ${scrubbed.length} scrubbed`,
    );
  }
  for (let index = 0; index < scrubbed.length; index += 1) {
    const scrubbedRow = scrubbed[index];
    const audit = auditById.get(scrubbedRow.id)?.messages ?? [];
    const reconstructed = reconstructUnit(scrubbedRow, audit);
    const reconstructedStr = JSON.stringify(reconstructed);
    const originalStr = JSON.stringify(original[index]);
    if (reconstructedStr !== originalStr) {
      throw new Error(`Reconstruction mismatch at unit ${scrubbedRow.id}`);
    }
  }
  return { reconstructed_units: scrubbed.length, byte_identical: true };
}

function parseArgs(argv) {
  const args = { mode: argv[0] };
  for (let i = 1; i < argv.length; i += 1) {
    const key = argv[i].replace(/^--/, "");
    args[key] = argv[++i];
  }
  return args;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === "scrub") {
    if (!args.input || !args["retained-output"] || !args["audit-output"]) {
      console.error(
        "Usage: era-pii-scrub.mjs scrub --input PRE --retained-output SCRUBBED --audit-output AUDIT [--component NAME]",
      );
      process.exit(2);
    }
    const result = scrubRetainedStream({
      input: args.input,
      retainedOutput: args["retained-output"],
      auditOutput: args["audit-output"],
      component: args.component,
    });
    console.log(JSON.stringify({ mode: "scrub", ...result }, null, 2));
  } else if (args.mode === "verify") {
    if (!args.input || !args["retained-output"] || !args["audit-output"]) {
      console.error(
        "Usage: era-pii-scrub.mjs verify --input PRE --retained-output SCRUBBED --audit-output AUDIT",
      );
      process.exit(2);
    }
    const result = verifyReconstruction({
      input: args.input,
      retainedOutput: args["retained-output"],
      auditOutput: args["audit-output"],
    });
    console.log(JSON.stringify({ mode: "verify", ...result }, null, 2));
  } else {
    console.error("Usage: era-pii-scrub.mjs <scrub|verify> ...");
    process.exit(2);
  }
}
