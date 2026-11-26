import ts from "typescript";
import { newSideLines } from "./diff.js";
import { safeSourcePath } from "./sourcePath.js";
import { sensitivePath, sensitiveText } from "./sensitiveSource.js";
import { findingId } from "./report.js";
import { MAX_SOURCE_BYTES } from "./sourceBody.js";
import type { FileDiff, Finding } from "./types.js";
import { checkBehavior } from "./staticRules.js";

const freshLiteral = (node: ts.Expression) =>
  (ts.isArrayLiteralExpression(node) && !node.elements.length) ||
  (ts.isObjectLiteralExpression(node) && !node.properties.length);

/** Parser-only adapter. The compiler receives in-memory source and never loads a project. */
export async function analyzeStatic(
  files: FileDiff[],
  read: (path: string) => Promise<string | null>,
  revision: string,
  signal?: AbortSignal,
) {
  const findings: Finding[] = [];
  let analyzed = 0;
  let attempted = 0;
  for (const file of files) {
    signal?.throwIfAborted();
    const path = file.newPath;
    if (
      !/\.[cm]?[jt]sx?$/i.test(path) ||
      file.deletedFile ||
      !safeSourcePath(path) ||
      sensitivePath(path) ||
      sensitivePath(file.oldPath) ||
      sensitiveText(file.diff) ||
      attempted >= 32
    )
      continue;
    attempted++;
    const text = await read(path);
    signal?.throwIfAborted();
    if (text === null || Buffer.byteLength(text) > MAX_SOURCE_BYTES || sensitiveText(text))
      continue;
    const lines = text.split(/\r?\n/);
    const additions = new Map(
      [...newSideLines(file.diff)].filter((l) => l.added).map((l) => [l.line, l.text]),
    );
    if ([...additions].some(([line, value]) => lines[line - 1] !== value)) continue;
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    const program = ts.createProgram(
      [path],
      {
        allowJs: true,
        noLib: true,
        noResolve: true,
        types: [],
        target: ts.ScriptTarget.Latest,
        jsx: ts.JsxEmit.Preserve,
      },
      {
        getSourceFile: (name) => (name === path ? source : undefined),
        getDefaultLibFileName: () => "",
        writeFile: () => {},
        getCurrentDirectory: () => "",
        getCanonicalFileName: (name) => name,
        useCaseSensitiveFileNames: () => true,
        getNewLine: () => "\n",
        fileExists: (name) => name === path,
        readFile: (name) => (name === path ? text : undefined),
      },
    );
    // A recovered AST may contain synthetic nodes. Abstain on malformed inputs.
    if (program.getSyntacticDiagnostics(source).length) continue;
    const emit = (node: ts.Node, rule: string, title: string, comment: string) => {
      const start = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      const end =
        source.getLineAndCharacterOfPosition(Math.max(node.getStart(source), node.end - 1)).line +
        1;
      if (!additions.has(start)) return;
      const finding: Finding = {
        file: path,
        line: start,
        endLine: end,
        category: "bug",
        severity: "warning",
        confidence: 1,
        title,
        comment,
        evidence: lines[start - 1],
        tool: "aetherreview/typescript",
        rule,
        verification: "rule-verified",
        revision,
      };
      finding.id = findingId(finding);
      findings.push(finding);
      return true;
    };
    const stack: ts.Node[] = [source];
    while (stack.length) {
      const node = stack.pop()!;
      checkBehavior(node, program, emit);
      if (
        ts.isVariableDeclaration(node) &&
        node.initializer &&
        ts.isArrayLiteralExpression(node.initializer) &&
        node.initializer.elements.some(ts.isOmittedExpression)
      ) {
        // Omitted expressions have zero width. Anchor the diagnostic on the
        // following comma, which may be on a different line after trivia.
        const list = node.initializer
          .getChildren(source)
          .find((n) => n.kind === ts.SyntaxKind.SyntaxList);
        const tokens = list?.getChildren(source) ?? [];
        for (let i = 1; i < tokens.length; i++) {
          if (
            ts.isOmittedExpression(tokens[i - 1]) &&
            tokens[i].kind === ts.SyntaxKind.CommaToken &&
            emit(
              tokens[i],
              "sparse-array-initializer",
              "Array initializer contains an empty slot",
              "This comma creates a hole in the array. Array methods such as map skip empty slots. Check whether a missing element is intended.",
            )
          )
            break;
        }
      }
      if (
        ts.isBinaryExpression(node) &&
        (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
          node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken) &&
        (freshLiteral(node.left) || freshLiteral(node.right))
      ) {
        emit(
          node,
          "fresh-literal-comparison",
          "Comparison with a fresh object or array",
          "Strict equality with a newly allocated empty literal is always false. Strict inequality is always true if both operands finish evaluating.",
        );
      }
      if (ts.isCaseBlock(node)) {
        const seen = new Set<string>();
        for (const clause of node.clauses) {
          if (!ts.isCaseClause(clause)) continue;
          const e = clause.expression;
          const key = ts.isStringLiteral(e)
            ? "s:" + e.text
            : ts.isNumericLiteral(e)
              ? "n:" + Number(e.text)
              : null;
          if (key === null) continue;
          if (seen.has(key))
            emit(
              e,
              "duplicate-case",
              "Duplicate switch case",
              "An earlier case matches the same literal. The switch cannot select this label directly, although execution may fall through to it.",
            );
          seen.add(key);
        }
      }
      ts.forEachChild(node, (child) => {
        stack.push(child);
      });
    }
    analyzed++;
  }
  return { findings, analyzed, total: files.length };
}
