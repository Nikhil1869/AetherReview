import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { URL } from "node:url";
import process from "node:process";
import console from "node:console";

const [folder, filename, ...options] = process.argv.slice(2);
if (!filename) throw Error("Usage: score-corpus.mjs <evidence-directory> <raw.jsonl> [--list]");
const read = (name) => readFileSync(join(folder, name), "utf8");
const raw = read(filename)
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
const dataset = JSON.parse(readFileSync(new URL("./eslint-corpus.json", import.meta.url), "utf8"));
const cases = new Map(dataset.cases.map((c) => [c.id, c]));
const oracleRules = new Map([
  ["duplicate-case", "no-duplicate-case"],
  ["sparse-array-initializer", "no-sparse-arrays"],
  ["duplicate-parameter", "no-dupe-args"],
  ["unreachable-statement", "no-unreachable"],
  ["nan-comparison", "use-isnan"],
  ["async-promise-executor", "no-async-promise-executor"],
]);
const list = options.includes("--list");
const grades = list ? {} : JSON.parse(read("adjudication.json"));
const seen = new Set();
const single = new Map(
  read("static-individual.jsonl")
    .trim()
    .split("\n")
    .map((line) => {
      const row = JSON.parse(line);
      return [row.id, row.status];
    }),
);
const percentile = (items, p) =>
  items.length ? [...items].sort((a, b) => a - b)[Math.ceil(items.length * p) - 1] : null;
const ratio = (a, b) => (b ? Number((a / b).toFixed(4)) : null);

for (const split of ["development", "heldOut"]) {
  const rows = raw.filter((r) => r.split === split);
  if (!rows.length) continue;
  const m = {
    cases: 0,
    positives: 0,
    negatives: 0,
    abstained: 0,
    correctVerdicts: 0,
    correctNegative: 0,
    negativeWithFinding: 0,
    defectsFound: 0,
    findings: 0,
    creditedFindings: 0,
    rawProposals: 0,
    rawInvalidLocations: 0,
    rawEvidenceMismatches: 0,
    capturedResponses: 0,
    invalidDeliveredLocations: 0,
    deliveredEvidenceMismatches: 0,
  };
  for (const r of rows) {
    const files = r.files ?? { "sample.js": r.id };
    const counts = new Map();
    for (const id of Object.values(files)) {
      assert(!seen.has(id), "Duplicate case: " + id);
      assert.equal(cases.get(id)?.split, split);
      seen.add(id);
      counts.set(id, { delivered: 0, credit: false });
    }
    const inspect = (f) => {
      const c = cases.get(files[f?.file]);
      const n = Number(f?.line);
      const lines = c?.code.split("\n") ?? [];
      const valid = Number.isSafeInteger(n) && n >= 1 && n <= lines.length;
      return {
        c,
        valid,
        evidence:
          valid && typeof f?.evidence === "string" && lines[n - 1].trim() === f.evidence.trim(),
      };
    };
    if (Array.isArray(r.proposals)) {
      m.capturedResponses++;
      for (const f of r.proposals) {
        const loc = inspect(f);
        m.rawProposals++;
        if (!loc.valid) m.rawInvalidLocations++;
        else if (!loc.evidence) m.rawEvidenceMismatches++;
      }
    }
    for (const f of r.findings ?? []) {
      const { c, valid, evidence } = inspect(f);
      m.findings++;
      if (!valid) m.invalidDeliveredLocations++;
      else if (!evidence) m.deliveredEvidenceMismatches++;
      if (!c) continue;
      const entry = counts.get(c.id);
      entry.delivered++;
      let matched;
      if (f.tool === "aetherreview/typescript") {
        matched = oracleRules.get(f.rule) === c.rule;
      } else {
        const key = createHash("sha256")
          .update(JSON.stringify([c.id, f.title, f.comment, f.suggestion ?? ""]))
          .digest("hex")
          .slice(0, 16);
        if (list) {
          console.log(
            JSON.stringify({
              key,
              id: c.id,
              rule: c.rule,
              label: c.label,
              code: c.code,
              expected: c.explanation,
              finding: f.title,
              comment: f.comment,
              repair: f.suggestion,
            }),
          );
          continue;
        }
        assert.equal(typeof grades[key]?.matches, "boolean", "Missing adjudication for " + key);
        matched = grades[key].matches;
      }
      if (
        valid &&
        evidence &&
        c.label === "invalid" &&
        c.expectedLine === f.line &&
        matched &&
        !entry.credit
      ) {
        entry.credit = true;
        m.creditedFindings++;
      }
    }
    for (const [id, entry] of counts) {
      const positive = cases.get(id).label === "invalid";
      const abstained =
        r.status !== "completed" || (r.mode === "static" && single.get(id) !== "completed");
      m.cases++;
      if (positive) m.positives++;
      else m.negatives++;
      if (abstained) m.abstained++;
      if (entry.credit) m.defectsFound++;
      if (!positive && entry.delivered) m.negativeWithFinding++;
      if (!abstained && !positive && !entry.delivered) m.correctNegative++;
      if (!abstained && (positive ? entry.credit && entry.delivered === 1 : !entry.delivered))
        m.correctVerdicts++;
    }
  }
  if (list) continue;
  const missed = m.positives - m.defectsFound;
  const falseFindings = m.findings - m.creditedFindings;
  console.log(
    JSON.stringify({
      split,
      batches: rows.length,
      ...m,
      missed,
      falseFindings,
      precision: ratio(m.creditedFindings, m.findings),
      recall: ratio(m.defectsFound, m.positives),
      f1: ratio(2 * m.creditedFindings, 2 * m.creditedFindings + falseFindings + missed),
      falsePositiveRate: ratio(m.negativeWithFinding, m.negatives),
      strictAccuracy: ratio(m.correctVerdicts, m.cases),
      coverage: ratio(m.cases - m.abstained, m.cases),
      p50BatchMs: percentile(
        rows.map((r) => r.elapsedMs),
        0.5,
      ),
      p95BatchMs: percentile(
        rows.map((r) => r.elapsedMs),
        0.95,
      ),
      maxCliRssKiB: Math.max(...rows.map((r) => r.stats?.peakRssKiB ?? 0)),
      userCpuUs: rows.reduce((n, r) => n + (r.stats?.userCpuUs ?? 0), 0),
      systemCpuUs: rows.reduce((n, r) => n + (r.stats?.systemCpuUs ?? 0), 0),
    }),
  );
}
