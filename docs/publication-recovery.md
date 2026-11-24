# Publication recovery and release gates

This branch starts at the November 24 verification commit `c72910b`. The remote default is `master` at `8a6c065`. Draft PRs 1–4 still form the baseline stack. A fresh Windows run reproduced all 274 baseline tests, lint, formatting, type checks and build. The runtime audit reported zero vulnerabilities. The full lockfile audit reported 1 low, 13 moderate and 6 high development entries. The earlier six-case Ollama scores and the fork line counts remain historical measurements. [Baseline evidence](p0-verification.md)

## Publication protocol

1. Register a uniquely named ticket under the target’s local lock directory, then check for competing live owners. When two simultaneous attempts both see a competitor they can both stop. A later attempt can retry. Release removes only the ticket held by this instance. Terminated processes’ tickets can be reclaimed after the OS reports that their PID no longer exists. A recycled PID conservatively blocks progress until that process exits. This scheme assumes one host and a local filesystem. An old-format lock after a crash requires stopping all reviewers before manually removing the individual stale lock file.
2. Fetch the fork head, base and diff references. Validate the proposed findings against additions. Compare the revision again before each write. Stop after a rejected or uncertain write. An explicit inline validation rejection can fall back to a plain note. A denied, rate-limited or server-error response cannot trigger that fallback.
3. Re-read owned comments and reviews on a subsequent run. Reuse matching markers and finish a missing summary even if the findings were already posted. GitLab restores the full sticky summary. GitHub reconciles pending reviews and existing summaries with the reviewed head.
4. Inspect `publication.jsonl` under the trusted AetherReview home. Each mutation has a run ID, attempt ID, timestamp, operation, hashed destination and hashed target including revision. A reply records the HTTP status or MCP tool success. An unknown outcome or attempt without a reply requires checking the forge before retrying. The log excludes URLs, source, request bodies, response bodies and credentials. Users control the file’s retention. It provides operational evidence, not a tamper-proof external ledger.

The forge can change between the preflight and the write. A network error can follow server-side success. Separate hosts and separate app homes have independent locks. Duplicate detection also depends on when the forge makes new artifacts visible. Same-account human drafts with ambiguous ownership stop publication.

## Implementation and coverage

| Files                                                                                           | Change                                                                                                                        |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `publicationLock.ts`, `state.ts`, `config.ts`                                                   | Process-owned tickets, crash recovery and reset behavior                                                                      |
| `publicationAudit.ts`, `forgeSession.ts`, `forgeMcp.ts`, `forgeCommits.ts`                      | Correlated REST and MCP mutation records and commit-comment error classification                                              |
| `forge.ts`, `poster.ts`, `pipeline.ts`                                                          | Missing-summary recovery and stopping after publication failures                                                              |
| `publicationLock.test.ts`, `publicationAudit.test.ts`, `forgeCommits.test.ts`, `poster.test.ts` | Independent processes, crashed ownership, reset, concurrent audit scopes, unknown delivery, rate limits and missing summaries |
| `src/cli/index.ts`, CLI, configuration and engine references                                    | Reset instructions and lock lifecycle                                                                                         |

## Remaining gates in dependency order

- Exercise authenticated publication on a disposable PR and MR with dedicated restricted accounts. The maintainer must supply each target URL, the credential profile or environment variable name, and authorization for the specific create, edit, submit and label operations. Validate fork positioning, a change of head between steps, refusal to change human drafts, and recovery from partial publication. The existing public acceptance targets remain read-only.
- Establish independent quality evidence. The historic 3B sample had two correct verdicts in six attempts and four abstentions. Mechanically verified diagnostics, semantic-candidate verification and a separated development/held-out evaluation precede release claims. The requested 90% precision, 85% recall and 90% verdict accuracy remain targets.
- Triage development dependencies by actual CI exposure. Continue to run the six supported OS/Node combinations and pack/install the generated CLI.
- Extend language support, indexing, evaluation and the dashboard after the production safety gates. A public release and npm publication require separate maintainer approval.
