import type { FileDiff } from "./types.js";

const HUNK = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Yield new-side lines from unified hunks. Respect both hunk counts so a
 * trailing file header, empty terminator, or other metadata never becomes code. */
export function* newSideLines(patch: string) {
  let oldLeft = 0;
  let newLeft = 0;
  let line = 0;
  let position = 0;
  let seenHunk = false;
  for (const text of patch.split("\n")) {
    const hunk = HUNK.exec(text);
    if (hunk) {
      oldLeft = Number(hunk[1] ?? 1);
      line = Number(hunk[2]);
      newLeft = Number(hunk[3] ?? 1);
      if (seenHunk) position++;
      seenHunk = true;
      continue;
    }
    if (!seenHunk) continue;
    position++;
    const prefix = text[0];
    if (prefix === "-" && oldLeft > 0) {
      oldLeft--;
      continue;
    }
    if (newLeft > 0 && (prefix === "+" || (prefix === " " && oldLeft > 0))) {
      newLeft--;
      if (prefix === " ") oldLeft--;
      yield { line, position, added: prefix === "+", text: text.slice(1).replace(/\r$/, "") };
      line++;
    } else if (prefix !== "\\") {
      oldLeft = newLeft = 0;
    }
  }
}

export function reviewDiff(diffs: FileDiff[], maxChars: number) {
  const files: FileDiff[] = [];
  const parts: string[] = [];
  let total = 0;
  for (const file of diffs) {
    if (!/^@@ -\d/m.test(file.diff) || file.diff.includes("\0")) continue;
    const chunk = `### FILE: ${file.newPath || file.oldPath}\n${file.diff}\n`;
    if (total + chunk.length > maxChars) continue;
    files.push(file);
    parts.push(chunk);
    total += chunk.length;
  }
  return { files, text: parts.join("") };
}
