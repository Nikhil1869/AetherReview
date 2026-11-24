import { describe, expect, it, vi } from "vitest";
import { analyzeStatic } from "../staticReview.js";
import { renderRdjson } from "../report.js";

function reviewSource(source: string, name = "sample.ts", body = source) {
  const lines = source.split("\n");
  const file = {
    newPath: name,
    oldPath: name,
    newFile: true,
    deletedFile: false,
    diff: "@@ -0,0 +1," + lines.length + " @@\n" + lines.map((l) => "+" + l).join("\n"),
  };
  return analyzeStatic([file], async () => body, "reviewed-revision");
}

describe("isolated TypeScript parser", () => {
  it("records rule evidence at the added line and exports linewise diagnostics", async () => {
    const r = await reviewSource("const a: string[] = [];\nif (a === []) process.exit(1);");
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({
      line: 2,
      revision: "reviewed-revision",
      verification: "rule-verified",
      rule: "fresh-literal-comparison",
    });
    const exported = renderRdjson({
      status: "completed",
      headSha: "reviewed-revision",
      result: { summary: "", findings: r.findings },
      omittedFiles: 0,
    });
    expect(exported.diagnostics[0].location.range.start.line).toBe(2);
  });
  it("distinguishes equal case labels from different primitive types", async () => {
    const r = await reviewSource(
      'switch (x) {\ncase 1: break;\ncase "1": break;\ncase 1: break;\n}',
    );
    expect(r.findings.map((f) => f.line)).toEqual([4]);
  });
  it("skips changed snapshots, unsupported files and comments containing code", async () => {
    expect((await reviewSource("if (x === []) f();", "sample.ts", "bar();")).analyzed).toBe(0);
    expect((await reviewSource("if (x === []) f();", "sample.py")).analyzed).toBe(0);
    expect((await reviewSource("// if (x === []) f();")).findings).toEqual([]);
  });
  it("does not read arbitrary paths or execute source", async () => {
    const read = vi.fn(async () => "");
    await analyzeStatic(
      [
        {
          oldPath: "../elsewhere.ts",
          newPath: "../elsewhere.ts",
          newFile: false,
          deletedFile: false,
          diff: "",
        },
      ],
      read,
      "sha",
    );
    expect(read).not.toHaveBeenCalled();
    await reviewSource('throw new Error("should never execute");', "sample.js");
  });
});
