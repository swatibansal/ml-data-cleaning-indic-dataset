#!/usr/bin/env node
// ERA Phase 1 — deterministic privacy-candidate policy transform.
//
// SUPERSEDED (2026-07-26) by privacy policy v2 (uniform PII scrubbing) in
// era-pii-scrub.mjs. This module implemented the 2026-07-25 privacy-holdout
// policy and is retained only as a standalone, reversible holdout tool and for
// its self-tests; it is NO LONGER wired into run_component.sh / run_both.sh.
// The live pipeline now scrubs-and-retains instead of holding privacy units out.
//
// Historical policy (2026-07-25): any retained conversation carrying >= 1
// privacy detector finding is routed to the reversible "privacy_holdout"
// category. era-auto-route.mjs applied this policy in-pipeline; this standalone
// module exists so the operation can be applied to, and MECHANICALLY REVERSED
// from, a materialized pre-policy retained stream:
//
//   apply   pre-policy-retained.jsonl -> post-policy-retained.jsonl
//                                       + privacy-holdout.jsonl (provenance)
//   restore post-policy-retained.jsonl + privacy-holdout.jsonl
//                                       -> reconstructed pre-policy-retained.jsonl
//
// "restore" reproduces the pre-policy retained stream byte-for-byte, proving the
// holdout is reversible and that no source row is destroyed. Counts/ids only in
// the holdout provenance; no raw candidate values are written.
//
// Determinism: input order is preserved; the holdout carries the pre-policy line
// index so restore can re-interleave exactly. Re-running apply on the same input
// yields byte-identical outputs.

import fs from "node:fs";
import path from "node:path";
import { analyzePrivacy } from "./stage6-privacy-audit.mjs";

export const PRIVACY_POLICY_REASON = "privacy_candidate_policy_2026-07-25";

export function privacyUnitSignalTypes(row) {
  const types = new Set();
  const interactions = Array.isArray(row.interactions) ? row.interactions : [];
  for (const text of interactions.flat()) {
    if (typeof text !== "string") continue;
    for (const finding of analyzePrivacy(text)) types.add(finding.type);
  }
  return [...types].sort();
}

function readJsonl(file) {
  const raw = fs.readFileSync(file, "utf8");
  if (!raw) return [];
  return raw
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function writeJsonl(file, rows) {
  fs.writeFileSync(
    path.resolve(file),
    rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""),
  );
}

// Split a pre-policy retained stream into the post-policy retained rows and the
// privacy-holdout rows. Each holdout row carries the ORIGINAL retained record
// verbatim under `record`, plus reversible provenance. Pure function (no I/O).
export function applyPolicy(retainedRows, component) {
  const postRetained = [];
  const privacyHoldout = [];
  const unitTypeCounts = {};
  retainedRows.forEach((row, index) => {
    const types = privacyUnitSignalTypes(row);
    if (types.length === 0) {
      postRetained.push(row);
      return;
    }
    for (const type of types) unitTypeCounts[type] = (unitTypeCounts[type] ?? 0) + 1;
    privacyHoldout.push({
      component: component ?? row._era_provenance?.component ?? null,
      id: row.id,
      pre_policy_retained_index: index,
      original_disposition: "retained",
      disposition: "privacy_holdout",
      reason: PRIVACY_POLICY_REASON,
      detector_signal_types: types,
      reversible: true,
      record: row,
    });
  });
  return { postRetained, privacyHoldout, unitTypeCounts };
}

// Reconstruct the pre-policy retained stream from the post-policy retained rows
// and the privacy-holdout rows, re-interleaving by pre_policy_retained_index.
export function restorePolicy(postRetainedRows, privacyHoldoutRows) {
  const total = postRetainedRows.length + privacyHoldoutRows.length;
  const slots = new Array(total).fill(undefined);
  for (const entry of privacyHoldoutRows) {
    const index = entry.pre_policy_retained_index;
    if (typeof index !== "number" || index < 0 || index >= total) {
      throw new Error(`privacy holdout has invalid pre_policy_retained_index: ${index}`);
    }
    if (slots[index] !== undefined) {
      throw new Error(`duplicate pre_policy_retained_index: ${index}`);
    }
    slots[index] = entry.record;
  }
  let cursor = 0;
  for (let index = 0; index < total; index += 1) {
    if (slots[index] === undefined) {
      if (cursor >= postRetainedRows.length) {
        throw new Error("post-policy retained stream underran during restore");
      }
      slots[index] = postRetainedRows[cursor++];
    }
  }
  if (cursor !== postRetainedRows.length) {
    throw new Error("post-policy retained stream had leftover rows during restore");
  }
  return slots;
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
  if (args.mode === "apply") {
    if (!args.input || !args["retained-output"] || !args["holdout-output"]) {
      console.error(
        "Usage: era-privacy-policy-apply.mjs apply --input PRE --retained-output POST --holdout-output HOLDOUT [--component NAME]",
      );
      process.exit(2);
    }
    const { postRetained, privacyHoldout, unitTypeCounts } = applyPolicy(
      readJsonl(args.input),
      args.component,
    );
    writeJsonl(args["retained-output"], postRetained);
    writeJsonl(args["holdout-output"], privacyHoldout);
    console.log(
      JSON.stringify(
        {
          mode: "apply",
          post_policy_retained: postRetained.length,
          privacy_holdout_units: privacyHoldout.length,
          unit_type_counts: unitTypeCounts,
        },
        null,
        2,
      ),
    );
  } else if (args.mode === "restore") {
    if (!args["retained-input"] || !args["holdout-input"] || !args.output) {
      console.error(
        "Usage: era-privacy-policy-apply.mjs restore --retained-input POST --holdout-input HOLDOUT --output RECONSTRUCTED",
      );
      process.exit(2);
    }
    const restored = restorePolicy(
      readJsonl(args["retained-input"]),
      readJsonl(args["holdout-input"]),
    );
    writeJsonl(args.output, restored);
    console.log(
      JSON.stringify({ mode: "restore", reconstructed_rows: restored.length }, null, 2),
    );
  } else {
    console.error("Usage: era-privacy-policy-apply.mjs <apply|restore> ...");
    process.exit(2);
  }
}
