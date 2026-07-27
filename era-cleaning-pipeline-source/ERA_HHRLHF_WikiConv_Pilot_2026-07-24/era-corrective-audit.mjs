#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import crypto from "node:crypto";
import zlib from "node:zlib";
import {
  bandKeys, characterShingles, isNearDuplicate, normalizeForSimilarity, simhash64,
} from "./stage5-dedup-audit.mjs";

export function normalizeText(value) {
  return String(value ?? "").normalize("NFC").toLowerCase()
    .replace(/[\u200b\ufeff\u202a-\u202e\u2066-\u2069]/gu, "")
    .replace(/\s+/gu, " ").trim();
}

export function extractText(row) {
  if (Array.isArray(row.messages)) return row.messages.map(x => x?.content ?? "").join("\n");
  if (Array.isArray(row.interactions)) {
    return row.interactions.flatMap(x => Array.isArray(x) ? x : [x]).join("\n");
  }
  return [row.prompt, row.instruction, row.input, row.response, row.output, row.text]
    .filter(Boolean).join("\n");
}

function shingles(text, width = 5) {
  const tokens = normalizeText(text).split(/\s+/u).filter(Boolean);
  if (tokens.length <= width) return new Set([tokens.join(" ")]);
  const out = new Set();
  for (let i = 0; i <= tokens.length - width; i++) out.add(tokens.slice(i, i + width).join(" "));
  return out;
}

const SEEDS = Array.from({ length: 32 }, (_, i) => `era-minhash-v1:${i}:`);
function hash32(seed, text) {
  return crypto.createHash("sha256").update(seed).update(text).digest().readUInt32BE(0);
}

export function minhash(text) {
  const grams = shingles(text);
  const sig = SEEDS.map(() => 0xffffffff);
  for (const gram of grams) {
    for (let i = 0; i < SEEDS.length; i++) {
      const h = hash32(SEEDS[i], gram);
      if (h < sig[i]) sig[i] = h;
    }
  }
  return sig;
}

export function signatureSimilarity(a, b) {
  let equal = 0;
  for (let i = 0; i < a.length; i++) if (a[i] === b[i]) equal++;
  return equal / a.length;
}

export function contentSignals(text) {
  const value = normalizeText(text);
  const patterns = {
    ai_boilerplate: /\b(as an ai(?: language model)?|i am an ai(?: language model)?)\b/u,
    refusal: /\b(i (?:cannot|can't|won't|am unable to)|i must refuse|cannot assist)\b/u,
    apology: /\b(i'?m sorry|i apologize)\b/u,
    uncertainty: /\b(i (?:do not|don't) know|not sure|cannot verify|may be inaccurate)\b/u,
  };
  const result = Object.fromEntries(Object.entries(patterns).map(([k, re]) => [k, re.test(value)]));
  const lines = value.split(/\n+/u).filter(Boolean);
  result.repeated_line = lines.length >= 3 && new Set(lines).size / lines.length < 0.6;
  result.suspicious_birthplace_claim = /\b(?:born|birthplace)\b.{0,80}\b(?:chennai|delhi|mumbai|kolkata)\b/u.test(value);
  return result;
}

function openLines(file) {
  const source = fs.createReadStream(file);
  const input = file.endsWith(".gz") ? source.pipe(zlib.createGunzip()) : source;
  return readline.createInterface({ input, crlfDelay: Infinity });
}

function stableId(row, index) {
  return String(row.conversation_id ?? row.doc_id ?? row.id ?? row.source_index ?? index);
}

export async function auditFile(options) {
  const {
    input, dataset, outputDir, maxRows = Infinity, minChars = 80,
    similarityThreshold = 0.85, maxCandidates = 10000,
  } = options;
  fs.mkdirSync(outputDir, { recursive: true });
  const candidatesPath = path.join(outputDir, `${dataset}.near-duplicate-candidates.jsonl`);
  const candidates = fs.createWriteStream(candidatesPath, { encoding: "utf8" });
  const buckets = new Map();
  const signatures = new Map();
  const signalCounts = {};
  let rows = 0, parseErrors = 0, empty = 0, eligible = 0, candidateCount = 0;

  for await (const line of openLines(input)) {
    if (!line.trim()) continue;
    if (rows >= maxRows) break;
    const index = rows++;
    let row;
    try { row = JSON.parse(line); } catch { parseErrors++; continue; }
    const text = extractText(row);
    if (!normalizeText(text)) { empty++; continue; }
    for (const [name, hit] of Object.entries(contentSignals(text))) {
      if (hit) signalCounts[name] = (signalCounts[name] ?? 0) + 1;
    }
    if (normalizeText(text).length < minChars) continue;
    eligible++;
    const normalized = normalizeForSimilarity(text);
    const grams = characterShingles(normalized, 5, 1200);
    const sig = simhash64(grams);
    const id = stableId(row, index);
    const candidateIds = new Set();
    for (const key of bandKeys(sig)) {
      const prior = buckets.get(key);
      if (prior) for (const priorId of prior.slice(-25)) candidateIds.add(priorId);
    }
    for (const priorId of candidateIds) {
      const prior = signatures.get(priorId);
      const comparison = isNearDuplicate(
        { normalizedLength: [...normalized].length, shingles: grams, simhash: sig },
        prior,
        { minimumJaccard: similarityThreshold },
      );
      if (comparison.match && candidateCount < maxCandidates) {
        candidates.write(JSON.stringify({ dataset, id, prior_id: priorId, jaccard: comparison.jaccard, hamming: comparison.hamming, method: "simhash64-char5-lsh-jaccard-v1" }) + "\n");
        candidateCount++;
      }
    }
    signatures.set(id, { normalizedLength: [...normalized].length, shingles: grams, simhash: sig });
    for (const key of bandKeys(sig)) {
      const list = buckets.get(key) ?? [];
      list.push(id);
      buckets.set(key, list);
    }
  }
  await new Promise((resolve, reject) => candidates.end(resolve).on("error", reject));
  const report = {
    schema_version: "era-corrective-audit-v1",
    dataset, input: path.resolve(input), rows_scanned: rows, parse_errors: parseErrors,
    empty_text: empty, near_dedup_eligible: eligible, near_duplicate_candidates: candidateCount,
    near_duplicate_action: "review_only_no_automatic_removal",
    near_dedup: { method: "simhash64-char5-lsh-jaccard-v1", shingle_characters: 5, max_shingles_per_record: 1200, jaccard_threshold: similarityThreshold, candidate_cap: maxCandidates },
    content_quality: { action: "descriptive_only", counts: signalCounts },
    quality_routing: { status: "run", removed: 0, note: "Corrective pass is non-destructive; signals are reported for review." },
    decontamination: { status: "not_run", reason: "Benchmark registry text is not embedded in this corrective package." },
    token_estimation: { status: "not_run", reason: "Named tokenizer dependencies/models unavailable; no heuristic is presented as measurement." },
    language_validation: { status: "sample_generation_available_separately", human_labels_completed: 0 },
  };
  fs.writeFileSync(path.join(outputDir, `${dataset}.corrective-audit.json`), JSON.stringify(report, null, 2) + "\n");
  return report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = Object.fromEntries(process.argv.slice(2).map(x => {
    const [k, ...v] = x.replace(/^--/, "").split("="); return [k, v.join("=") || true];
  }));
  if (!args.input || !args.dataset || !args.output) {
    console.error("Usage: node era-corrective-audit.mjs --input=FILE --dataset=NAME --output=DIR [--max-rows=N]");
    process.exit(2);
  }
  const report = await auditFile({
    input: args.input, dataset: args.dataset, outputDir: args.output,
    maxRows: args["max-rows"] ? Number(args["max-rows"]) : Infinity,
  });
  console.log(JSON.stringify(report, null, 2));
}
