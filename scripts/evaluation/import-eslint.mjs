import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";
import { URL } from "node:url";
import ts from "typescript";
import { Linter } from "eslint";

const revision = "4a3d15a99c452c4db2fd56b577fa7597e98ab0c2";
const base = "https://raw.githubusercontent.com/eslint/eslint/" + revision + "/";
const rules = {
  development: [
    "no-duplicate-case",
    "no-self-assign",
    "use-isnan",
    "no-sparse-arrays",
    "no-unreachable",
    "no-async-promise-executor",
    "no-prototype-builtins",
    "require-atomic-updates",
    "no-dupe-args",
  ],
  heldOut: [
    "no-fallthrough",
    "no-unsafe-finally",
    "no-dupe-keys",
    "no-constant-binary-expression",
    "valid-typeof",
    "no-await-in-loop",
    "no-unreachable-loop",
    "no-unsafe-optional-chaining",
    "no-loss-of-precision",
  ],
};
const linter = new Linter();
const seen = new Set();
const cases = [];
const hash = (s) => createHash("sha256").update(s).digest("hex");
async function pinned(path) {
  const r = await globalThis.fetch(base + path, { redirect: "error" });
  if (!r.ok) throw Error("Corpus download failed: " + path + " " + r.status);
  return r.text();
}
for (const [split, names] of Object.entries(rules)) {
  for (const rule of names) {
    const path = "tests/lib/rules/" + rule + ".js";
    const src = ts.createSourceFile(path, await pinned(path), ts.ScriptTarget.Latest, true);
    const choices = [];
    function load(node) {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "run"
      ) {
        const group = node.arguments[2];
        if (group && ts.isObjectLiteralExpression(group))
          for (const prop of group.properties) {
            if (!ts.isPropertyAssignment(prop) || !ts.isArrayLiteralExpression(prop.initializer))
              continue;
            const label = prop.name.getText(src);
            if (label !== "valid" && label !== "invalid") continue;
            for (const element of prop.initializer.elements) {
              let literal = element;
              if (ts.isObjectLiteralExpression(element)) {
                if (
                  element.properties.some(
                    (p) =>
                      !ts.isPropertyAssignment(p) ||
                      !["code", "errors", "output", "name"].includes(p.name.getText(src)),
                  )
                )
                  continue;
                literal = element.properties.find(
                  (p) => p.name.getText(src) === "code",
                )?.initializer;
              }
              if (
                !literal ||
                !(ts.isStringLiteral(literal) || ts.isNoSubstitutionTemplateLiteral(literal))
              )
                continue;
              const code = literal.text.trim();
              if (!code || code.length > 800 || code.includes("eslint-")) continue;
              const diagnostics = linter.verify(
                code,
                {
                  languageOptions: { ecmaVersion: "latest", sourceType: "script" },
                  rules: { [rule]: "error" },
                },
                { filename: "fixture.js", allowInlineConfig: false },
              );
              if (
                diagnostics.some((d) => d.fatal || d.ruleId !== rule) ||
                diagnostics.length !== (label === "valid" ? 0 : 1)
              )
                continue;
              const id = hash(code);
              choices.push({
                id: id.slice(0, 12),
                split,
                rule,
                label,
                code,
                expectedLine: diagnostics[0]?.line ?? null,
                explanation: diagnostics[0]?.message ?? null,
                source:
                  path + "#L" + (src.getLineAndCharacterOfPosition(literal.getStart(src)).line + 1),
              });
            }
          }
      }
      ts.forEachChild(node, load);
    }
    load(src);
    for (const label of ["valid", "invalid"]) {
      let n = 0;
      for (const item of choices
        .filter((c) => c.label === label)
        .sort((a, b) => a.id.localeCompare(b.id))) {
        const signature = item.code.replace(/\s+/g, "");
        if (seen.has(signature)) continue;
        seen.add(signature);
        cases.push(item);
        if (++n === 5) break;
      }
    }
  }
}
// Group entire rule families in one split. Additionally drop near duplicates
// using identifier-normalized token shingles before selecting the held-out rows.
function shingles(code) {
  const scan = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, code);
  const tokens = [];
  for (let k = scan.scan(); k !== ts.SyntaxKind.EndOfFileToken; k = scan.scan()) tokens.push(k);
  const width = Math.min(tokens.length, 4);
  return new Set(
    tokens.slice(0, tokens.length - width + 1).map((_, i) => tokens.slice(i, i + width).join(".")),
  );
}
function similar(a, b) {
  let common = 0;
  for (const token of a) if (b.has(token)) common++;
  return common / (a.size + b.size - common) >= 0.8;
}
const selected = [];
const devTokens = [];
for (const [split, names] of Object.entries(rules)) {
  for (const label of ["valid", "invalid"]) {
    const pool = cases.filter((c) => c.split === split && c.label === label);
    let count = 0;
    for (let offset = 0; offset < 5 && count < 30; offset++)
      for (const rule of names) {
        const row = pool.filter((c) => c.rule === rule)[offset];
        if (!row) continue;
        const tokens = shingles(row.code);
        if (split === "heldOut" && devTokens.some((t) => similar(t, tokens))) continue;
        selected.push(row);
        if (split === "development") devTokens.push(tokens);
        if (++count === 30) break;
      }
    if (count !== 30) throw Error("Insufficient distinct fixtures for " + split + " " + label);
  }
}
const corpusFile = new URL("./eslint-corpus.json", import.meta.url);
const licenseFile = new URL("./ESLint-LICENSE.txt", import.meta.url);
const corpus = { revision, cases: selected };
const license = await pinned("LICENSE");
if (process.argv.includes("--check")) {
  assert.deepEqual(JSON.parse(await readFile(corpusFile, "utf8")), corpus);
  assert.equal(
    (await readFile(licenseFile, "utf8")).replaceAll("\r\n", "\n"),
    license.replaceAll("\r\n", "\n"),
  );
} else {
  await writeFile(corpusFile, JSON.stringify(corpus, null, 2) + "\n");
  await writeFile(licenseFile, license);
}
