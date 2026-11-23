# Glossary

[← Docs index](./README.md)

Domain terms used throughout the code and these docs.

| Term                    | Meaning                                                                                                                                                                                                                                                          |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **forge**               | A git host: `github` or `gitlab` (`bitbucket` is declared but not yet wired).                                                                                                                                                                                    |
| **projectId**           | The repo identifier. GitHub: `owner/repo`. GitLab: URL-encoded path or numeric ID.                                                                                                                                                                               |
| **PR / MR**             | Pull request (GitHub) / merge request (GitLab). Used interchangeably; internally `prNumber`.                                                                                                                                                                     |
| **job**                 | The unit of work for a review: `{ forge, projectId, prNumber, headSha }`.                                                                                                                                                                                        |
| **norms**               | The review rules, resolved in layers: built-in defaults → global norms & packs → the target repo's `.aetherreview.yml` (project wins). See [Configuration](./configuration.md#custom-norms-global--packs--plugins).                                              |
| **pack**                | A named, reusable declarative norm set (`~/.aetherreview/norms/<name>.yml`). Activated globally via `norms.use` or per-repo via `extends:` (by name only). See [Custom norms](./configuration.md#packs--reusable-declarative-rule-sets).                         |
| **transform**           | A code plugin (`~/.aetherreview/norms/<name>.mjs`) that adjusts merged norms programmatically. Runs only when the **global** config activates it — never on a repo's say-so. See [Custom norms](./configuration.md#transforms--code-plugins-power-users).        |
| **context bundle**      | The files the LLM sees beyond the diff: changed files + their imports + callers + tests, ranked `changed > import > caller > test` and budgeted. Built by [`bundler.ts`](./engine-reference.md#bundlerts).                                                       |
| **finding**             | One review comment: `file`, `line`, `severity` (critical/warning/info), `category` (security/bug/perf/style/maintainability), `confidence` (0–1), title, comment, optional suggestion. Findings below the norms confidence threshold are dropped before posting. |
| **marker**              | A hidden HTML comment that tags a bot artifact for idempotent dedup: `<!-- ct:f:FILE:LINE -->`, `<!-- ct:review -->`, `<!-- ct:status -->`. See [Invariant 1](./invariants.md#1-markers-are-the-idempotency-system).                                             |
| **source evidence**     | A quote of the full added line at a finding's reported file and line. The reviewer checks it before displaying or publishing a finding.                                                                                                                          |
| **backend**             | The forge transport: GitHub MCP (default), GitHub REST (`GITHUB_BACKEND=rest`), or GitLab REST. All implement the same [`ForgeClient`](./engine-reference.md#the-forgeclient-interface).                                                                         |
| **MCP**                 | [Model Context Protocol](https://modelcontextprotocol.io/) — the official GitHub remote server AetherReview uses for GitHub I/O by default.                                                                                                                      |
| **pending review**      | The GitHub MCP flow where inline findings accumulate (`create` → `add_comment_to_pending_review`) and publish together as one review (`submit_pending`).                                                                                                         |
| **watch / auto-review** | The polling loop that reviews on new PR / new push. The first cycle _baselines_ open PRs without reviewing. See [`watch.ts`](./engine-reference.md#watchts).                                                                                                     |
| **superseding**         | When a newer head SHA arrives, an in-flight review for an older SHA is skipped. Enforced by [`state.ts`](./engine-reference.md#statets).                                                                                                                         |
| **diff refs**           | `{ head_sha, base_sha, start_sha }` — the commit triple GitLab needs to anchor an inline comment.                                                                                                                                                                |
| **status note**         | The "🐢 reviewing…" / result note. Editable (sticky) on GitLab & GitHub REST; absent on GitHub MCP (no edit tool).                                                                                                                                               |

---

[← Docs index](./README.md)
