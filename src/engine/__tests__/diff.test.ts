import { describe, expect, it } from "vitest";

import { newSideLines, reviewDiff } from "../diff.js";
import type { FileDiff } from "../types.js";

describe("newSideLines", () => {
  it("tracks additions and context across hunks, excluding deleted lines and metadata", () => {
    const patch = [
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,2 +1,2 @@",
      " context",
      "-old",
      "+++source",
      "\\ No newline at end of file",
      "@@ -11,0 +12 @@",
      "+new",
      "+unexpected trailing line",
      "",
    ].join("\r\n");
    expect([...newSideLines(patch)]).toEqual([
      { line: 1, position: 1, added: false, text: "context" },
      { line: 2, position: 3, added: true, text: "++source" },
      { line: 12, position: 6, added: true, text: "new" },
    ]);
  });

  it("has no new-side lines for a deleted file", () => {
    expect([...newSideLines("@@ -1 +0,0 @@\n-old\n")]).toEqual([]);
  });
});

describe("reviewDiff", () => {
  it("selects only patches that fit and keeps the file list aligned with model input", () => {
    const file = (name: string, diff: string): FileDiff => ({
      newPath: name,
      oldPath: name,
      newFile: false,
      deletedFile: false,
      diff,
    });
    const small = file("small.ts", "@@ -0,0 +1 @@\n+one");
    const result = reviewDiff([file("binary", ""), file("large.ts", "x".repeat(1024)), small], 50);
    expect(result.files).toEqual([small]);
    expect(result.text).toBe(`### FILE: small.ts\n${small.diff}\n`);
  });
});
