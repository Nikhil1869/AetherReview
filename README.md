## AetherReview

AetherReview previews local Git changes, GitHub pull requests and GitLab merge requests from your terminal. A fresh installation checks JavaScript and TypeScript with three parser rules and requires no model or credentials for staged changes. With an explicitly selected reviewer, the CLI can send a bounded diff and context to a local OpenAI-compatible model and check its reported evidence against added lines. See the [analysis guide](docs/hybrid-analysis.md) for rule coverage and the evaluation corpus.

## Install from source

Use Node.js 22.12 or later and Git.

```bash
git clone --branch quality/local-analysis https://github.com/Nikhil1869/AetherReview.git
cd AetherReview
npm ci
npm pack
npm install --global ./aether-review-2.1.0.tgz
aetherreview --version
```

`npm pack` builds the executable. See the [release guide](docs/release.md) for the clean-install test and rollback commands.

## Review local changes

To try the parser immediately, run `aetherreview review --staged --analysis static` in a Git checkout. For semantic review, start a local OpenAI-compatible model server and select an installed model. The following example uses the Ollama model evaluated on this branch.

```bash
export REVIEWER_BASE_URL=http://127.0.0.1:11434/v1
export REVIEWER_MODEL=qwen2.5-coder:3b
aetherreview doctor
aetherreview review --staged
```

In PowerShell, use `$env:REVIEWER_BASE_URL = "http://127.0.0.1:11434/v1"` and `$env:REVIEWER_MODEL = "qwen2.5-coder:3b"`. Local Git reviews need no forge credentials. Use the [configuration guide](docs/configuration.md) for hosted endpoints, model settings and repository rules.

## Preview a pull request

Configure your GitHub or GitLab credentials first. The bare command opens an interactive dashboard with forge and model setup.

```bash
aetherreview review https://github.com/owner/repo/pull/42 --json
```

Add `--publish` to authorize inline comments, the summary, and status or label updates for that review. In the dashboard, Enter previews an open request, `p` posts a review, and `a` opens the authorization screen for session-wide automatic posting to the listed repositories. A compatible hosted model receives review content even in preview mode.

## Documentation

- [CLI reference](docs/cli-reference.md) covers Git targets, reports, quality gates, and exit codes.
- [Configuration](docs/configuration.md) covers local and hosted endpoints, credentials, and norms.
- [Release decision and benchmark](docs/evaluation/2026-11-26/README.md) records the held-out results, model limitations and outstanding gates.
- [Architecture](docs/architecture.md) and [engine reference](docs/engine-reference.md) describe the review pipeline.
- [Security policy](SECURITY.md) describes where data goes and how to report vulnerabilities.
- [Contributing](CONTRIBUTING.md) and the [release audit](docs/production-audit.md) cover verification and remaining release work.

AetherReview is licensed under the [MIT License](LICENSE).
