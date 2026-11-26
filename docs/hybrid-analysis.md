# Local analysis and evaluation

The CLI can review JavaScript and TypeScript without inference. With no configured reviewer, local and remote CLI previews select static analysis. Explicitly choose a mode with `--analysis static`, `--analysis ai` or `--analysis hybrid`. The TUI continues to use its configured reviewer. Static and hybrid modes currently support previews. Running these modes does not authorize external writes.

```sh
npm ci
npm run build
node dist/cli.js review --staged --analysis static --format rdjson
node dist/cli.js review --staged --analysis hybrid --format sarif
```

The static adapter receives source text via the existing Git or forge client. It calls the pinned TypeScript 6.0.3 parser and checks syntax using an in-memory compiler host with no libraries, project discovery, module resolution or filesystem reads. It inspects up to 32 portable JS/TS files of at most 256 KiB. Every eligible added line must match the snapshot. A parse failure, unsupported language, missing body or mismatched snapshot reduces coverage. The implemented rules recognize repeated literal switch labels, strict identity comparisons with a fresh empty object or array, and holes in a variable’s array-literal initializer. The array check points to the comma that creates a hole. A single trailing comma preserves a dense array. A static result establishes only the stated rule property. It can miss defects outside these rules.

Findings include producer, verification status and revision. Static diagnostics add rule ID and end line. Source-anchored model findings still require semantic inspection. In a staged or working review, the revision is an index or working-tree label. Comparing immutable Git revisions supplies a commit SHA. JSON preserves provenance. SARIF and RDJSON export locations and rule identifiers. [Reviewdog diagnostic format](https://github.com/reviewdog/reviewdog/blob/master/proto/rdf/reviewdog.proto)

When the model cannot complete a hybrid preview, a successfully parsed static result is available in JSON with `status: "partial"` and exit code 1. SARIF marks the invocation unsuccessful while retaining verified diagnostics. An empty partial result leaves the semantic verdict inconclusive. Cancellation still stops the review.

## Independent corpus

The frozen corpus contains 120 JavaScript examples from ESLint’s own rule tests. There are 30 rule-positive and 30 rule-negative cases in each split. Whole rule families are separated. Exact normalized duplicates are removed, and held-out samples with a token-shingle Jaccard index of at least 0.8 against a development sample are excluded. Cases are selected by source hash under a fixed per-rule quota. The labels come from upstream valid/invalid declarations, independently of AetherReview, and each label is checked with the pinned upstream rule in ESLint’s in-process Linter. Each fixture includes its expected line, source location and upstream diagnostic. The fixtures are treated as text, never imported as programs. [Upstream source revision](https://github.com/eslint/eslint/tree/4a3d15a99c452c4db2fd56b577fa7597e98ab0c2/tests/lib/rules) · [License](../scripts/evaluation/ESLint-LICENSE.txt)

Rule-negative means valid for the named rule. It does not certify a whole snippet is free of unrelated defects. The examples predominantly exercise JavaScript and are staged as new files. The original behavioral changes and prompt-injection case remain a separate evaluation. Use both sets when interpreting results. A finding on the expected line is insufficient to credit its semantic diagnosis.

```sh
node scripts/evaluation/import-eslint.mjs
node scripts/evaluation/run-corpus.mjs static all
node scripts/evaluation/run-corpus.mjs ai development
node scripts/evaluation/run-corpus.mjs hybrid heldOut
```

The importer fetches data only from the pinned upstream revision. The checked-in corpus supports offline evaluation. The semantic modes require an explicitly configured loopback endpoint and local model. The runner starts each case with an empty app store, no inherited provider key and no repository-controlled hooks. It measures CLI wall time, CPU use and peak resident memory. The server process has its own memory and CPU usage. Its costs are outside the CLI resource counters. A missing JSON verdict is recorded as failure.

Runtime attribution for the parser is TypeScript, Microsoft and contributors, Apache-2.0. The compiler ships unmodified as an exact npm dependency with its upstream license. [TypeScript license](https://github.com/microsoft/TypeScript/blob/main/LICENSE.txt)
