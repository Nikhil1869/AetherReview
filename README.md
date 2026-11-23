## AetherReview

AetherReview reviews local Git changes, GitHub pull requests, and GitLab merge requests from your terminal. It sends a bounded diff and selected context to the OpenAI-compatible endpoint you configure and checks each finding's evidence against an added line. You can use a model running on your machine or a hosted provider.

## Install from source

Use Node.js 22.12 or later and Git.

```bash
git clone https://github.com/Nikhil1869/AetherReview.git
cd AetherReview
npm ci
npm pack
npm install --global ./aether-review-2.1.0.tgz
aetherreview --version
```

`npm pack` builds the executable. See the [release guide](docs/release.md) for the clean-install test and rollback commands.

## Review local changes

Start a local OpenAI-compatible model server and set its base URL and an installed model ID. This example uses Ollama and assumes the model is already available.

```bash
export REVIEWER_BASE_URL=http://127.0.0.1:11434/v1
export REVIEWER_MODEL=qwen2.5-coder
aetherreview doctor
aetherreview review --staged
```

In PowerShell, use `$env:REVIEWER_BASE_URL = "http://127.0.0.1:11434/v1"` and `$env:REVIEWER_MODEL = "qwen2.5-coder"`. Local Git reviews need no forge credentials. Use the [configuration guide](docs/configuration.md) for hosted endpoints, model settings, and repository rules.

## Preview a pull request

Configure your GitHub or GitLab credentials first. The bare command opens an interactive dashboard with forge and model setup.

```bash
aetherreview review https://github.com/owner/repo/pull/42 --json
```

Add `--publish` to authorize inline comments, the summary, and status or label updates for that review. In the dashboard, Enter previews an open request, `p` posts a review, and `a` opens the authorization screen for session-wide automatic posting to the listed repositories. A compatible hosted model receives review content even in preview mode.

## Documentation

- [CLI reference](docs/cli-reference.md) covers Git targets, reports, quality gates, and exit codes.
- [Configuration](docs/configuration.md) covers local and hosted endpoints, credentials, and norms.
- [Architecture](docs/architecture.md) and [engine reference](docs/engine-reference.md) describe the review pipeline.
- [Security policy](SECURITY.md) describes where data goes and how to report vulnerabilities.
- [Contributing](CONTRIBUTING.md) and the [release audit](docs/production-audit.md) cover verification and remaining release work.

AetherReview is licensed under the [MIT License](LICENSE).
