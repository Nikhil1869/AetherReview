import { createHash } from "node:crypto";
import { stripVTControlCharacters } from "node:util";

import type { ReviewOutcome } from "./pipeline.js";
import type { Finding, Severity } from "./types.js";

const severityRank: Record<Severity, number> = { info: 0, warning: 1, critical: 2 };

export function meetsGate(findings: Finding[], threshold: Severity): boolean {
  return findings.some((finding) => severityRank[finding.severity] >= severityRank[threshold]);
}

export function findingId(finding: Finding): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        finding.file,
        finding.line,
        finding.category,
        finding.evidence,
        ...(finding.rule ? [finding.rule] : []),
      ]),
    )
    .digest("hex");
}

export function markdownText(text: string): string {
  return stripVTControlCharacters(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/@/g, "&#64;")
    .replace(/[\\`*_{}[\]()#!|~]/g, "\\$&");
}

export function renderMarkdown(outcome: ReviewOutcome): string {
  if (outcome.status !== "completed") return `# AetherReview\n\n${markdownText(outcome.message)}`;
  const lines = ["# AetherReview", "", markdownText(outcome.result.summary)];
  if (outcome.omittedFiles)
    lines.push("", `${outcome.omittedFiles} changed file(s) unavailable or over budget.`);
  for (const finding of outcome.result.findings) {
    lines.push(
      "",
      `## ${markdownText(finding.title)}`,
      "",
      `${finding.severity} · ${finding.category} · ${markdownText(finding.file)}:${finding.line} · confidence ${finding.confidence}`,
      "",
      markdownText(finding.comment),
    );
    if (finding.evidence) lines.push("", `Evidence — ${markdownText(finding.evidence)}`);
    if (finding.suggestion) lines.push("", `Suggested fix — ${markdownText(finding.suggestion)}`);
  }
  return lines.join("\n");
}

export function renderSarif(outcome: ReviewOutcome) {
  const results =
    outcome.status === "completed"
      ? outcome.result.findings.map((finding) => ({
          ruleId: finding.rule ?? finding.category,
          level: { critical: "error", warning: "warning", info: "note" }[finding.severity],
          message: { text: `${finding.title}\n\n${finding.comment}` },
          partialFingerprints: { aetherReviewFinding: finding.id ?? findingId(finding) },
          locations: [
            {
              physicalLocation: {
                artifactLocation: {
                  uri: finding.file.split("/").map(encodeURIComponent).join("/"),
                },
                region: { startLine: finding.line, endLine: finding.endLine ?? finding.line },
              },
            },
          ],
          properties: {
            confidence: finding.confidence,
            evidence: finding.evidence,
            suggestion: finding.suggestion,
            tool: finding.tool,
            verification: finding.verification,
            revision: finding.revision,
          },
        }))
      : [];
  return {
    version: "2.1.0",
    $schema: "https://docs.oasis-open.org/sarif/sarif/v2.1.0/cs01/schemas/sarif-schema-2.1.0.json",
    runs: [
      {
        tool: { driver: { name: "AetherReview" } },
        invocations: [{ executionSuccessful: outcome.status !== "failed" }],
        properties:
          outcome.status === "completed"
            ? {
                status: outcome.status,
                headSha: outcome.headSha,
                omittedFiles: outcome.omittedFiles,
              }
            : { status: outcome.status, message: outcome.message },
        results,
      },
    ],
  };
}

export function renderRdjson(outcome: ReviewOutcome) {
  return {
    source: { name: "AetherReview" },
    diagnostics:
      outcome.status === "completed"
        ? outcome.result.findings.map((f) => ({
            message: f.title + "\n" + f.comment,
            severity: { critical: "ERROR", warning: "WARNING", info: "INFO" }[f.severity],
            source: { name: f.tool ?? "AetherReview" },
            code: { value: f.rule ?? f.category },
            location: {
              path: f.file,
              range: { start: { line: f.line }, end: { line: f.endLine ?? f.line } },
            },
          }))
        : [],
  };
}
