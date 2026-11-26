import ts from "typescript";

type Emit = (anchor: ts.Node, rule: string, title: string, comment: string) => boolean | undefined;

function unwrap(node: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(node)) node = node.expression;
  return node;
}

// With no libraries or module resolution, a resolved symbol is a declaration in
// this snapshot. A with statement can also supply a name at runtime.
function globalName(node: ts.Expression, name: string, program: ts.Program): boolean {
  if (!ts.isIdentifier(node) || node.text !== name) return false;
  for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
    if (ts.isWithStatement(parent)) return false;
  }
  return !program.getTypeChecker().getSymbolAtLocation(node);
}

function nanLiteral(expression: ts.Expression, program: ts.Program): ts.Node | undefined {
  let node = unwrap(expression);
  while (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.CommaToken)
    node = unwrap(node.right);
  if (globalName(node, "NaN", program)) return node;
  if (
    ts.isPropertyAccessExpression(node) &&
    node.name.text === "NaN" &&
    globalName(unwrap(node.expression), "Number", program)
  )
    return node.name;
  return undefined;
}

const comparisons = new Set([
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
]);

function jumps(statement: ts.Statement, depth = 0): boolean {
  if (depth > 16) return false;
  if (
    ts.isReturnStatement(statement) ||
    ts.isThrowStatement(statement) ||
    ts.isBreakStatement(statement) ||
    ts.isContinueStatement(statement)
  )
    return true;
  if (ts.isBlock(statement)) return statement.statements.some((s) => jumps(s, depth + 1));
  return (
    ts.isIfStatement(statement) &&
    !!statement.elseStatement &&
    jumps(statement.thenStatement, depth + 1) &&
    jumps(statement.elseStatement, depth + 1)
  );
}

/** Each rule identifies its anchor in the full AST. The caller checks the diff. */
export function checkBehavior(node: ts.Node, program: ts.Program, emit: Emit): void {
  if (
    ts.isNewExpression(node) &&
    node.arguments?.length &&
    globalName(unwrap(node.expression), "Promise", program)
  ) {
    const executor = unwrap(node.arguments[0]);
    if (ts.isArrowFunction(executor) || ts.isFunctionExpression(executor)) {
      const modifier = executor.modifiers?.find((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
      if (modifier && !(ts.isFunctionExpression(executor) && executor.asteriskToken))
        emit(
          modifier,
          "async-promise-executor",
          "Async function used as a Promise executor",
          "The built-in Promise constructor ignores its executor’s return value. A throw inside an async executor rejects its own promise and can leave the constructed promise pending.",
        );
    }
  }
  if (ts.isBinaryExpression(node) && comparisons.has(node.operatorToken.kind)) {
    const anchor = nanLiteral(node.left, program) ?? nanLiteral(node.right, program);
    if (anchor)
      emit(
        anchor,
        "nan-comparison",
        "Comparison against NaN has a fixed result",
        "With the standard NaN value, equality and ordering comparisons are false and inequality comparisons are true whenever the operands finish evaluating. Use Number.isNaN when testing a value.",
      );
  }
  if (ts.isSwitchStatement(node) && node.caseBlock.clauses.some(ts.isCaseClause)) {
    const anchor = nanLiteral(node.expression, program);
    if (anchor)
      emit(
        anchor,
        "nan-comparison",
        "NaN cannot select a switch case",
        "Switch uses strict equality. With the standard NaN value, no case label can match; a default clause can still run.",
      );
  }
  if (ts.isFunctionLike(node) && "body" in node && node.body) {
    const seen = new Set<string>(),
      reported = new Set<string>();
    for (const { name } of node.parameters) {
      if (!ts.isIdentifier(name)) continue;
      if (
        seen.has(name.text) &&
        !reported.has(name.text) &&
        emit(
          name,
          "duplicate-parameter",
          "Formal parameter name is repeated",
          "Two parameters bind the same name. Strict functions reject this declaration; in a non-strict simple parameter list the later binding hides the earlier argument.",
        )
      )
        reported.add(name.text);
      seen.add(name.text);
    }
  }
  if (
    ts.isBlock(node) ||
    ts.isSourceFile(node) ||
    ts.isCaseClause(node) ||
    ts.isDefaultClause(node)
  ) {
    let exited = false;
    for (const statement of node.statements) {
      // Function declarations and bare var declarations may still be hoisted.
      if (
        exited &&
        ts.isExpressionStatement(statement) &&
        emit(
          statement.getFirstToken() ?? statement,
          "unreachable-statement",
          "Statement follows unconditional control transfer",
          "Every path through the preceding transfer leaves this statement list before this expression can execute.",
        )
      )
        break;
      if (!exited) exited = jumps(statement);
    }
  }
}
