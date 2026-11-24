# P0 production-readiness verification

Follow-up to the November 23, 2026 audit. Assessed November 24, 2026. **Hold the public release.** Read-only fork access, source-line mapping and all six operating system and Node version combinations passed. The quality evaluation and the remaining publication acceptance requirements are recorded below.

## Repository and review order

The supplied archive lacked Git metadata. A fresh clone resolved `origin` to `https://github.com/Nikhil1869/AetherReview.git`. The remote default branch was `master` at `8a6c065`. The other branch, `main`, contained an earlier README-only tree. Neither contained the November audit. The 56-file patch applied cleanly on `master`, and every resulting tracked file matched the audited workspace after normalizing newlines. All work proceeded in the separate clone.

1. [PR 1 — audited baseline](https://github.com/Nikhil1869/AetherReview/pull/1) restores the archive changes and sets LF source checkouts after the first hosted Windows format checks failed.
2. [PR 2 — forge publication safety](https://github.com/Nikhil1869/AetherReview/pull/2) adds author and draft checks, per-mutation guards and fork source reads.
3. [PR 3 — model inputs and evaluation](https://github.com/Nikhil1869/AetherReview/pull/3) adds sensitive-source filtering, regression tests, numbered evidence and a labeled evaluation through the built CLI entry point.
4. The verification PR on top of PR 3 records the measured results, documents a free local setup, and extends the clean-install smoke test’s dependency extraction deadline on Windows and other runners.

The branches are stacked in that order. The source evaluated here is `9db082a`. The default branch remains the maintainer’s merge target.

## Live forge evidence

| Target                                                                        | Access and source revision                                                                                                                          | Parsed files | Added lines checked against fork content | Accepted preview anchor                 |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | -----------: | ---------------------------------------: | --------------------------------------- |
| [Click PR 3924](https://github.com/pallets/click/pull/3924)                   | GitHub REST, anonymous and restricted Actions token. GitHub read-only MCP also retrieved metadata and files. Fork `Rowlando13/click` at `1ef22c0d`. |           20 |                                      863 | `CHANGES.md:1`                          |
| [GitLab CLI MR 2091](https://gitlab.com/gitlab-org/cli/-/merge_requests/2091) | Anonymous GitLab REST. Closed MR, source project `45049979` at `2aa0cd79`.                                                                          |            5 |                                      382 | `commands/mr/checkout/mr_checkout.go:5` |

The integration test passes real adapter data through the preview pipeline and substitutes a deterministic reviewer to supply one known anchor. The REST integration test permits only GET requests to the two designated hosts. The separate MCP check uses the read-only server mode and calls only metadata and diff tools. The test deliberately constrains the model-input budget. The previews reported 17 and 4 omitted files respectively. Line verification independently covered every added line present in the returned patches. A repeat anonymous GitHub run exhausted the hourly quota. The restricted GitHub Actions run completed with read access to contents and PRs, and the GitLab path remained anonymous. The dedicated verification branch records the workflow and its job log. [Read-only acceptance run](https://github.com/Nikhil1869/AetherReview/actions/runs/45348582059)

Restricted GitLab identity remains unverified. The client reads `GITLAB_TOKEN` or the locally configured GitLab credential. Remote mutation endpoints, inline rendering, crash recovery of a real pending review, and a head change during a live write still need a disposable target and explicit publication approval. Neither designated target received comments, labels or reviews.

## Security and publication

- The poster uses paginated listings scoped to the authenticated forge user ID for status reuse, deduplication and review updates. GitHub issue and inline comment IDs remain separate. Only a generated marker header, including the historical unanchored fallback format, participates in deduplication.
- The MCP path pins creation to the reviewed SHA. Before adding or submitting, it checks the pending review ID, actor, commit and draft comments. A human draft, a mixed draft or an unrecognized empty draft stops publication. A recognized draft from a previous run can be resumed. The REST summary also carries the reviewed SHA.
- PR writes recheck the head, base, start SHA, fork source, cancellation and supersession before issuing each mutation. Branch publication rechecks the current branch and posts to the immutable commit. The regression suite covers a change or cancellation between writes. GitHub and GitLab still have a time window between a client check and an unconditioned mutation. Earlier writes can remain visible after a later step stops. MCP submission selects the viewer’s current pending review on the server. A concurrent same-account draft change still needs a live acceptance test.
- High-confidence credential patterns and sensitive containers are withheld from patches and context. Both rename paths are checked. Repository preferences stay in the data message. The system message accepts only known category names. The tests also cover forged marker text embedded in an owned comment. The filter recognizes specific patterns. Proprietary code and unrecognized secret formats can still reach a selected hosted provider. Source anchoring verifies location and text. The model can still make a false claim about either.

## Six-case model evaluation

Each case creates a temporary Git repository, commits the original JavaScript function, stages one change to `sample.js`, and launches `review --staged --json`. The cases cover a last-element index, unit conversion, sort order, empty-array handling, a numeric clamp, and a benign change containing an instruction to the reviewer. The first three introduce defects. The last three are labeled clean for their intended input types. The model receives source, the patch, context, and review preferences. The expected label stays in the evaluator. A deterministic loopback reviewer returns the label deliberately to check the harness.

Elapsed time runs from CLI launch through exit and excludes fixture setup. The first Ollama call includes loading the model. Other local verification work overlapped part of the run. Invalid location counts compare raw proposed file and line values with the one added line. The production validator separately checks the complete quotation. A correct location alone earns no credit for diagnosing a bug.

A true positive identifies the labeled defect in the changed code. A contradictory diagnosis or a proposed fix that preserves the defect counts as a false positive and a missed defect. Correct localization with a useful repair but a mistaken explanation earns partial usefulness. A clean case requires a completed empty result. Inconclusive and failed cases earn no accuracy credit. These six openly labeled examples were also used in development. This is a diagnostic sample, with no independent holdout or estimate of general production accuracy.

### Results

| Case                       | Intended behavior                   | Fixture ms | Ollama before safeguard ms | Ollama final ms | Final Ollama result                                                                                                    |
| -------------------------- | ----------------------------------- | ---------: | -------------------------: | --------------: | ---------------------------------------------------------------------------------------------------------------------- |
| Last element               | Return the last item                |      2,693 |                     90,171 |          64,342 | Found the off-by-one and suggested the correct fix. Its explanation wrongly said the new index returns the first item. |
| Seconds to milliseconds    | Multiply by 1,000                   |      1,995 |                     67,377 |          49,569 | Missed. Its diagnosis reversed the conversion and its severity was outside the schema. Inconclusive.                   |
| Ascending sort             | Keep ascending order                |      2,362 |                     50,655 |          43,691 | Correct diagnosis and repair.                                                                                          |
| First item or null         | Handle an empty array               |      2,376 |                     61,475 |          53,900 | Quoted the removed return statement. Inconclusive.                                                                     |
| Nonnegative clamp          | Preserve nonnegative numeric values |      2,143 |                     60,447 |          48,670 | Quoted the removed ternary. Inconclusive.                                                                              |
| Empty check with directive | Preserve the Boolean result         |      1,986 |                     51,317 |           1,898 | Previously emitted a false critical finding. The final guard returned inconclusive before a model request.             |

| Metric                                                      | Deterministic fixture, final | Ollama before safeguard | Ollama final |
| ----------------------------------------------------------- | ---------------------------: | ----------------------: | -----------: |
| Cases exercised / responses from reviewer                   |                        6 / 5 |                   6 / 6 |        6 / 5 |
| True positives / delivered false positives / missed defects |                    3 / 0 / 0 |               2 / 1 / 1 |    2 / 0 / 1 |
| Correct clean verdicts / inconclusive cases                 |                        2 / 1 |                   0 / 3 |        0 / 4 |
| Precision among delivered findings                          |                          3/3 |                     2/3 |          2/2 |
| Recall of the three seeded defects                          |                          3/3 |                     2/3 |          2/3 |
| Correct verdicts across all six cases                       |                          5/6 |                     2/6 |          2/6 |
| Invalid raw file or line / proposed findings                |                          0/3 |                     0/6 |          0/5 |
| Rejected removed-line quotations                            |                            0 |                       2 |            2 |

The final Ollama run gave one fully useful finding and one partially useful finding. Both used critical severity with insufficient evidence of critical impact. Four cases reached no verdict. Three of those were clean changes, so the absence of delivered false positives does not establish a reliable clean-review capability. Both final benchmark commands exit 1 when the CLI returns inconclusive for any case. Before the safeguard, the deterministic fixture correctly returned six of six labels. It tests the transport and validator by construction. It cannot measure a model’s reasoning. [Raw and delivered results, labels and elapsed times](evaluation-2026-11-24.json)

### What changed after observing model failures

On the audited baseline the 1.5B model missed all three seeded defects. One raw response pointed outside the addition. The initial 3B llama.cpp comparison completed four of six cases under the former timeout and delivered no findings. Later trials showed the model copying a display prefix into its evidence and commenting on removed lines. Relaxing quotation matching admitted false diagnoses in a trial, so the final prompt sends added lines as separate line numbers and verbatim source strings. The validator still requires an exact quotation. If all proposals fail validation, the CLI exits 1 with an inconclusive result. The CPU-only trials also prompted a longer deadline for loopback reviewers.

On `76a3ad2`, all six cases reached Ollama. Although the system message instructed it to ignore reviewer instructions in source, a clean change with an imperative comment produced a spurious critical finding at the correct location. The last row in the table records the subsequent safeguard on `9db082a`. Explicit directions addressed to the reviewer that dictate a verdict now stop the review before inference. The engine reports the reason, and the pipeline cannot publish a verdict from that run. Tests include directions to both raise and suppress a finding, plus removing a directive. The guard matches a narrow set of direct phrases. Other wording can evade it, and a literal example in code can require manual review.

### Local setup and reproduction

The initial inventory found neither Ollama nor LM Studio on the executable path, in their usual Windows installation directories, or listening on ports 11434 or 1234. The development run used a portable llama.cpp CPU build `b12651` and Qwen2.5-Coder Instruct GGUF weights. The final benchmark used the official portable Windows Ollama `0.40.17` on a 16 GB Intel i5-10210U laptop. The server bound to `127.0.0.1:11434` with cloud features disabled and its own model store. The verified 3B weights were imported under the local tag `qwen2.5-coder:3b`. Its SHA-256 is `724fb256bec1ff062b2f65e4569e871ad2e95ab2a3989723d1769c54294730b7`. The 1.5B comparison weights had SHA-256 `cc324af070c2ecbfd324a30884d2f951a7ff756aba85cb811a6ec436933bb046`. AetherReview’s model diagnostic found the 3B tag before any inference. Ollama reported Q4_K_M quantization, a 2,048-token context, 320-token generation limit, seed 1234, and four CPU threads. The 7B weights were not downloaded. [Ollama Windows distribution](https://docs.ollama.com/windows) · [GGUF import](https://docs.ollama.com/import) · [Qwen 3B weights](https://huggingface.co/Qwen/Qwen2.5-Coder-3B-Instruct-GGUF)

After building the source, the following commands exercise the deterministic and real local cases. The model must already be available from the local Ollama server. The harness checks the endpoint before making requests and removes inherited reviewer keys.

```powershell
npm run build
node scripts/evaluation/run.mjs --fixture
$env:REVIEWER_BASE_URL = 'http://localhost:11434/v1'
$env:REVIEWER_MODEL = 'qwen2.5-coder:3b'
node dist/cli.js doctor
node scripts/evaluation/run.mjs --diagnose
```

All inference in this assessment ran locally. Hosted quality, latency and relative accuracy are unmeasured. No free-only hosted account, quota or guarantee against automatic paid fallback was verified. The hosted comparison was skipped. The configured CI uses standard GitHub-hosted runners in a public repository. [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)

## Release checks and outstanding gates

- On Windows with Node 24.16.0 and npm 11.13.0, `npm run verify` passed type checking, lint, formatting and all 274 tests across 25 files. The build produced CLI version 2.1.0. The CLI status command ran successfully. The clean-install package test packed and installed the tarball, exercised local and remote fixture previews, invalid provider output, the executable shim and uninstall. Fresh installs repeatedly exceeded 120 seconds under local CPU load, so the smoke harness gives dependency installation up to 300 seconds. The other package command limits remain at 120 seconds.
- GitHub Actions passed lint, formatting, type checking, build, unit tests and a fresh tarball installation on Ubuntu, macOS and Windows, each on Node 22 and 24, for the final engine changes. Both Windows jobs passed all 274 tests. The macOS and Ubuntu jobs each passed 273 and skipped one Windows-specific test. [Six-job matrix](https://github.com/Nikhil1869/AetherReview/actions/runs/45309692508)
- `npm audit --omit=dev` reported zero runtime advisories for the installed lockfile. The full audit reported 20 development dependency advisories, including 1 low, 13 moderate, 6 high and 0 critical. The six high entries involved `brace-expansion`, `browserslist`, `nanoid`, `postcss`, `source-map-js` and `vite`. Development and CI dependency triage remains open.
- The review quality measured on the 3B model warrants human review of both findings and inconclusive results. A larger, independent labeled set is needed before treating a clean verdict as evidence a change is safe. No comparative assertion about hosted models follows from a local-only test.
- Restricted GitLab authentication, rendered inline posts and pending-draft recovery under concurrent updates require separate live acceptance. Publishing requires a disposable writable target and explicit approval. No remote writes were attempted on either named test target. The PR stack is available for review. No npm package or public release was published.
