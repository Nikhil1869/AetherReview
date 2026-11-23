# Getting Started

[← Docs index](./README.md)

This page gets you from a fresh clone to a working review.

## Prerequisites

- **Node.js ≥ 22.12** (floor set by `commander@15`/`ink@7`; native `fetch` and `AbortSignal.timeout` are used)
- A package manager (`npm`)
- An API key for at least one LLM provider, **or** a local server (Ollama / LM Studio)
- Git for local reviews. Remote reviews require a forge credential or a logged-in `gh` session.

## Install (as a user)

```bash
npm ci
npm pack
npm install -g ./aether-review-2.1.0.tgz
aetherreview              # bare command opens the TUI; first run walks you through setup
```

## Develop (from source)

```bash
git clone https://github.com/Nikhil1869/AetherReview.git
cd AetherReview
npm ci

# build the executable and its runtime chunks
npm run build           # tsup → dist/cli.js  (shebang banner added automatically)

# type-check without emitting (covers src + co-located tests)
npm run typecheck

# run the test suite (Vitest)
npm test                # add `npm run test:cov` for a coverage report

# run the built CLI
node dist/cli.js status
```

> `package.json` scripts: `build` → `tsup`, `typecheck` → `tsc --noEmit`, `test` → `vitest run`,
> `test:watch`, `test:cov`. See the [Testing](#testing) section below and
> [Agent Guide](../AGENTS.md) for the layout and conventions.

### Test locally with `npm link`

To use your local build as a global `aetherreview` command (instead of `node dist/cli.js ...`):

```bash
npm run build        # compile first
npm link             # symlink globally — creates the `aetherreview` command

# now use it like the published package
aetherreview status
aetherreview review <PR-link>

# after more edits, just rebuild — no need to re-link
npm run build

# clean up when done
npm unlink -g aether-review
npm install -g ./aether-review-2.1.0.tgz  # restore a packed build
```

The symlink points at `dist/`, so every `npm run build` immediately reflects in the global
command. This is the easiest way to test end-to-end (TUI, reviews, watcher) against a real
repo without publishing.

## Testing

Specs are **co-located** with the code in `src/**/__tests__/*.test.ts` and run with
[Vitest](https://vitest.dev). The seven hard invariants are locked in
`src/engine/__tests__/invariants.test.ts`; shared fixtures live in
`src/engine/__tests__/helpers/` (`tmpHome`, `fakeForge`, `fetchMock`).

```bash
npm test            # run once
npm run test:watch  # watch mode
npm run test:cov    # with coverage (thresholds enforced)
```

Coverage floors are configured in `vitest.config.ts` and enforced in CI
(`.github/workflows/ci.yml` runs typecheck + build + `test:cov` on every push/PR). When you change
engine logic or touch an invariant, add or update the matching test.

## First-run setup (TUI wizard)

Running `aetherreview` with no config launches the [`Setup`](./tui-reference.md#setuptsx) wizard:

1. **Pick a provider & model** — Gemini, Anthropic, OpenAI, OpenRouter, Groq, Ollama (local),
   LM Studio (local), or a custom OpenAI-compatible endpoint. Local servers get live model
   detection. See [`providers.ts`](./engine-reference.md#providersts).
2. **Connect a forge (once)** — a single menu with every auth method:
   - **Sign in with GitHub (OAuth device flow)** — shown when `GITHUB_CLIENT_ID` is set; you open
     `github.com/login/device`, enter the code, and AetherReview polls for the token (refreshed
     automatically).
   - **GitHub `gh` CLI session** (reuses `gh auth token`) or **a pasted GitHub PAT** (scope: `repo`).
   - **GitHub App (bot identity)** — reviews post as `<app-slug>[bot]` instead of your account.
     Register an app under `github.com/settings/apps` (permissions: pull requests **rw**,
     contents **ro**, issues **rw**), install it on your repos, generate a private key, then
     pick this option and enter the app id + key path. The key is copied to
     `~/.aetherreview/github-app.pem` (0600); installation tokens are minted locally and
     refreshed before each use — still no server, no webhooks.
   - **GitLab token** (scope: `api`; set `GITLAB_URL` for self-hosted).

   You only need **one** of these. GitHub uses the **MCP** backend by default.

3. **Pick a repo to watch** — for a GitHub connection, choose one (stored as `github:owner/repo`).
4. **Finish** — you land on a "connected" screen; press Enter to finish, or choose **Connect
   another forge** if you want both GitHub and GitLab.

Everything is written to `~/.aetherreview/` with `chmod 600`. See [Configuration](./configuration.md).

## CLI subcommands

The bare command opens the dashboard. The CLI can review local Git changes without forge credentials and preview or publish a remote review. See the [CLI reference](./cli-reference.md) for targets, reports, and exit codes.

```bash
# Review staged changes with a configured model
aetherreview review --staged

# Preview a single PR/MR using a link or target flags
aetherreview review https://github.com/owner/repo/pull/42
aetherreview review --forge github --repo owner/repo --pr 42

# Show connection + model status
aetherreview status
aetherreview doctor

# Wipe ALL local config (tokens, model, logs). -y skips the confirm prompt.
aetherreview reset
```

Automatic posting runs during an authorized dashboard session. Open the authorization screen with `a` to see the repository scope.

## Your first review

```bash
node dist/cli.js review https://github.com/owner/repo/pull/42
```

In the dashboard, choose an open request and press Enter to preview it. The CLI uses `--publish` to authorize remote writes. The model endpoint receives the diff and selected context for either mode.

## Next steps

- Understand what happens during a review → [Architecture](./architecture.md)
- Tune the reviewer per-repo → [Configuration › `.aetherreview.yml`](./configuration.md#per-repo-norms-aetherreviewyml)
- Build reusable review rules (global norms, packs, transforms) → [Custom Norms Guide](./custom-norms-guide.md)
- Before you submit a change → [Agent Guide › Verify](../AGENTS.md#verify-before-youre-done)
