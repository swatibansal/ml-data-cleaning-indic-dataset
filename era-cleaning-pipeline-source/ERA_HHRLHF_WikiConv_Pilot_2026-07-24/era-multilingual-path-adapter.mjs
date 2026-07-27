#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { once } from "node:events";
import {
  asyncBufferFromFile,
  parquetReadObjects,
} from "hyparquet/src/node.js";
import { compressors } from "hyparquet-compressors";

const METADATA_COLUMNS = new Set([
  "doc_id",
  "num_turns",
  "__index_level_0__",
  "_era_global_source_index",
  "_era_component",
]);

function parseArguments(argv) {
  const options = {
    samplingMode: "one-path-per-source-row",
    maximumHoldoutExamples: 10_000,
  };
  const mapping = {
    "--input": "input",
    "--component": "component",
    "--output": "output",
    "--structural-holdout": "structuralHoldout",
    "--report": "report",
    "--source-manifest": "sourceManifest",
    "--sample-manifest": "sampleManifest",
    "--sampling-mode": "samplingMode",
    "--maximum-holdout-examples": "maximumHoldoutExamples",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const key = mapping[argv[index]];
    if (!key) throw new Error(`Unknown argument: ${argv[index]}`);
    options[key] = argv[++index];
  }
  for (const required of [
    "input",
    "component",
    "output",
    "structuralHoldout",
    "report",
    "sourceManifest",
    "sampleManifest",
  ]) {
    if (!options[required]) throw new Error(`Missing --${required}`);
  }
  options.maximumHoldoutExamples = Number(options.maximumHoldoutExamples);
  if (options.samplingMode !== "one-path-per-source-row") {
    throw new Error("Only one-path-per-source-row is approved for bounded pilots.");
  }
  return options;
}

function json(value, spacing) {
  return JSON.stringify(
    value,
    (_, item) => (typeof item === "bigint" ? Number(item) : item),
    spacing,
  );
}

function sha256Text(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function sha256File(filePath) {
  const digest = crypto.createHash("sha256");
  const input = fs.createReadStream(filePath);
  for await (const chunk of input) digest.update(chunk);
  return digest.digest("hex");
}

async function writeLine(stream, value) {
  if (!stream.write(`${json(value)}\n`)) await once(stream, "drain");
}

async function close(stream) {
  stream.end();
  await once(stream, "finish");
}

function languageColumns(row) {
  return Object.keys(row).filter(
    (column) => !METADATA_COLUMNS.has(column) && Array.isArray(row[column]),
  );
}

function inspectPath(pathValue) {
  if (!Array.isArray(pathValue)) {
    return {
      interactions: [],
      suffix: null,
      issues: ["path_not_array"],
      messagePositions: 0,
    };
  }
  const issues = [];
  const messages = pathValue.map((value, index) => {
    if (typeof value !== "string") {
      issues.push(`message_${index}_not_string`);
      return null;
    }
    if (!value.trim()) issues.push(`message_${index}_blank`);
    return value;
  });
  const interactions = [];
  for (let index = 0; index + 1 < messages.length; index += 2) {
    if (messages[index] !== null && messages[index + 1] !== null) {
      interactions.push([messages[index], messages[index + 1]]);
    }
  }
  const suffix =
    messages.length % 2 === 1 ? messages[messages.length - 1] : null;
  if (suffix !== null) issues.push("unmatched_user_suffix");
  if (messages.length === 0) issues.push("empty_path");
  if (messages.length === 1) issues.push("no_complete_exchange");
  return {
    interactions,
    suffix,
    issues,
    messagePositions: messages.length,
  };
}

function stableConversationId({
  component,
  sourceIndex,
  docId,
  languageColumn,
  pathIndex,
}) {
  const key = [
    "era-multilingual-path-v1",
    component,
    sourceIndex,
    docId ?? "",
    languageColumn,
    pathIndex,
  ].join("\u001f");
  const hex = sha256Text(key);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function adaptSourceRow(row, sourceIndex, component) {
  const candidates = [];
  const structural = [];
  let discoveredPaths = 0;
  let discoveredCompleteExchanges = 0;
  let discoveredMessagePositions = 0;
  let populatedLanguages = 0;

  for (const languageColumn of languageColumns(row)) {
    const outer = row[languageColumn];
    if (outer.length > 0) populatedLanguages += 1;
    for (let pathIndex = 0; pathIndex < outer.length; pathIndex += 1) {
      discoveredPaths += 1;
      const inspected = inspectPath(outer[pathIndex]);
      discoveredCompleteExchanges += inspected.interactions.length;
      discoveredMessagePositions += inspected.messagePositions;
      const id = stableConversationId({
        component,
        sourceIndex,
        docId: row.doc_id,
        languageColumn,
        pathIndex,
      });
      const provenance = {
        schema_version: "era-multilingual-path-v1",
        component,
        source_row_index: sourceIndex,
        original_source_index:
          typeof row._era_global_source_index === "number"
            ? row._era_global_source_index
            : Number(row.__index_level_0__ ?? sourceIndex),
        doc_id: row.doc_id ?? null,
        language_column: languageColumn,
        path_index: pathIndex,
        source_num_turns: Number(row.num_turns ?? 0),
        original_message_positions: inspected.messagePositions,
      };
      if (inspected.interactions.length > 0) {
        candidates.push({
          score: sha256Text(`${id}\u001fbounded-pilot-v1`),
          row: {
            id,
            interactions: inspected.interactions,
            num_turns: inspected.interactions.length,
            _era_provenance: provenance,
          },
        });
      }
      if (inspected.issues.length > 0) {
        structural.push({
          id,
          disposition: "structural_holdout",
          reasons: inspected.issues,
          unmatched_user_suffix: inspected.suffix,
          retained_complete_exchange_count: inspected.interactions.length,
          _era_provenance: provenance,
        });
      }
    }
  }
  candidates.sort((left, right) => left.score.localeCompare(right.score));
  return {
    selected: candidates[0]?.row ?? null,
    structural,
    metrics: {
      populatedLanguages,
      discoveredPaths,
      discoveredCompleteExchanges,
      discoveredMessagePositions,
      materializablePaths: candidates.length,
    },
  };
}

export async function runAdapter(options) {
  const input = path.resolve(options.input);
  const output = path.resolve(options.output);
  const structuralHoldout = path.resolve(options.structuralHoldout);
  const reportPath = path.resolve(options.report);
  const sourceManifest = JSON.parse(
    fs.readFileSync(path.resolve(options.sourceManifest), "utf8"),
  );
  const sampleManifest = JSON.parse(
    fs.readFileSync(path.resolve(options.sampleManifest), "utf8"),
  );
  if (sourceManifest.revision !== sampleManifest.revision) {
    throw new Error("Source and sample manifest revisions differ.");
  }
  const actualSha256 = await sha256File(input);
  if (actualSha256 !== sampleManifest.sample_parquet_sha256) {
    throw new Error("Sample Parquet SHA-256 does not match its manifest.");
  }
  const descriptor = fs.openSync(input, "r");
  const header = Buffer.alloc(4);
  const footer = Buffer.alloc(4);
  try {
    const size = fs.fstatSync(descriptor).size;
    fs.readSync(descriptor, header, 0, 4, 0);
    fs.readSync(descriptor, footer, 0, 4, size - 4);
  } finally {
    fs.closeSync(descriptor);
  }
  if (header.toString() !== "PAR1" || footer.toString() !== "PAR1") {
    throw new Error("Sample is not a complete Parquet file.");
  }
  const rows = await parquetReadObjects({
    file: await asyncBufferFromFile(input),
    compressors,
  });
  if (rows.length !== sampleManifest.sample_rows) {
    throw new Error(
      `Manifest declares ${sampleManifest.sample_rows} rows; Parquet has ${rows.length}.`,
    );
  }

  fs.mkdirSync(path.dirname(output), { recursive: true });
  const valid = fs.createWriteStream(output, { encoding: "utf8" });
  const holdout = fs.createWriteStream(structuralHoldout, { encoding: "utf8" });
  const counts = {
    source_rows: rows.length,
    source_rows_with_pilot_unit: 0,
    source_rows_without_complete_exchange: 0,
    populated_language_columns: 0,
    discovered_paths: 0,
    materializable_paths: 0,
    discovered_complete_exchanges: 0,
    discovered_message_positions: 0,
    pilot_materialized_units: 0,
    structural_holdout_findings: 0,
    structural_holdout_examples_written: 0,
  };
  const languageCounts = {};

  for (let sourceIndex = 0; sourceIndex < rows.length; sourceIndex += 1) {
    const result = adaptSourceRow(rows[sourceIndex], sourceIndex, options.component);
    for (const [key, value] of Object.entries(result.metrics)) {
      const reportKey = {
        populatedLanguages: "populated_language_columns",
        discoveredPaths: "discovered_paths",
        materializablePaths: "materializable_paths",
        discoveredCompleteExchanges: "discovered_complete_exchanges",
        discoveredMessagePositions: "discovered_message_positions",
      }[key];
      counts[reportKey] += value;
    }
    if (result.selected) {
      counts.source_rows_with_pilot_unit += 1;
      counts.pilot_materialized_units += 1;
      const language = result.selected._era_provenance.language_column;
      languageCounts[language] = (languageCounts[language] ?? 0) + 1;
      await writeLine(valid, result.selected);
    } else {
      counts.source_rows_without_complete_exchange += 1;
    }
    counts.structural_holdout_findings += result.structural.length;
    for (const item of result.structural) {
      if (
        counts.structural_holdout_examples_written >=
        options.maximumHoldoutExamples
      ) {
        break;
      }
      await writeLine(holdout, item);
      counts.structural_holdout_examples_written += 1;
    }
  }
  await Promise.all([close(valid), close(holdout)]);
  const report = {
    schema_version: "era-multilingual-path-adapter-report-v1",
    component: options.component,
    status: "PILOT_ADAPTER_COMPLETE",
    production_release_eligible: false,
    source: {
      repository_id: sourceManifest.repository_id,
      revision: sourceManifest.revision,
      full_source_rows: sourceManifest.source_rows,
      sampled_source_rows: sampleManifest.sample_rows,
      sample_sha256: actualSha256,
    },
    sampling: {
      method: options.samplingMode,
      explanation:
        "One deterministic complete language/path is selected per sampled source row; all paths are still structurally counted.",
    },
    counts,
    pilot_language_distribution: languageCounts,
    structural_policy: {
      complete_exchanges_retained: true,
      unmatched_final_user_message: "structural_holdout",
      malformed_or_blank_messages: "structural_holdout",
      paths_merged: false,
    },
    outputs: {
      pilot_jsonl: path.basename(output),
      pilot_sha256: await sha256File(output),
      structural_holdout_jsonl: path.basename(structuralHoldout),
      structural_holdout_sha256: await sha256File(structuralHoldout),
    },
  };
  fs.writeFileSync(reportPath, `${json(report, 2)}\n`);
  return report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const options = parseArguments(process.argv.slice(2));
  console.log(json(await runAdapter(options), 2));
}
