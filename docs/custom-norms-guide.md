# AetherReview — Custom Norms Guide

A practical guide to customizing how AetherReview reviews your code. Share this with your team.

> **TL;DR** — "Norms" are the rules the reviewer follows. You can now set them at **three levels**:
> built-in defaults, your **personal global** norms (every repo), and a **per-repo** `.aetherreview.yml`.
> You can also package reusable rule sets as **packs** (`.yml`) and, for power users, write **code
> transforms** (`.mjs`). The more specific level wins.

---

## 1. What are "norms"?

Norms control the reviewer:

| Field                  | Meaning                                                          | Default                                                           |
| ---------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------- |
| `confidence_threshold` | drop findings below this (0–1)                                   | `0.7`                                                             |
| `max_findings`         | hard cap per review                                              | `25`                                                              |
| `exclude`              | glob patterns to skip (`**`, `*`, `?`)                           | lockfiles, `*.min.js`, generated, `node_modules`, `dist`, `build` |
| `categories`           | toggle `security` / `bug` / `perf` / `style` / `maintainability` | all on                                                            |
| `guidelines`           | free text injected into the prompt                               | senior-engineer baseline                                          |
| `examples`             | concrete anti-patterns this team cares about                     | none                                                              |

---

## 2. The three layers (and who wins)

Norms are merged **lowest → highest**. The project wins on any overlapping value:

```
1. built-in DEFAULTS                         (ship with AetherReview)
2. GLOBAL norms        ~/.aetherreview/config.json → "norms"     ← your personal baseline, every repo
3. PACKS               ~/.aetherreview/norms/*.yml                ← reusable, activated by name
4. REPO norms          <repo>/.aetherreview.yml                   ← travels with the repo, WINS
   then TRANSFORMS      ~/.aetherreview/norms/*.mjs               ← code, runs last (global only)
```

**How each field combines across layers:**

| Field                                  | Rule                                                  |
| -------------------------------------- | ----------------------------------------------------- |
| `confidence_threshold`, `max_findings` | **last writer wins** (the highest layer that sets it) |
| `categories`                           | **shallow merge** (toggles combine)                   |
| `exclude`                              | **union** (all layers' globs, de-duped)               |
| `examples`                             | **concatenated** (all layers)                         |
| `guidelines`                           | **appended** (each layer's text is kept and labelled) |

So a one-line repo guideline never erases your global baseline — they stack.

---

## 3. Per-repo norms (`.aetherreview.yml`)

Drop this at the **root of the repo being reviewed**. All keys optional:

```yaml
# .aetherreview.yml
extends: [security-strict] # pull in installed global packs by name
confidence_threshold: 0.7
max_findings: 25
exclude:
  - "**/*.snap"
  - "**/vendor/**"
categories:
  style: false # turn off style nits for this repo
guidelines: |
  Prefer composition over inheritance. Flag any new public API without a test.
examples:
  - bad: "catch (e) {}"
    why: "swallowed errors hide failures"
```

Commit it to the repo — every PR in that repo is reviewed with these rules.

---

## 4. Global norms (apply to every repo you review)

Edit `~/.aetherreview/config.json` and add a `norms` section (same keys as `.aetherreview.yml`, plus
`use` to activate packs/transforms by name):

```jsonc
{
  "reviewer": {
    "provider": "gemini",
    "model": "gemini-2.5-flash",
    "api_key": "…",
  },
  "norms": {
    "use": ["security-strict", "scale-by-size"], // packs + transforms to turn on globally
    "confidence_threshold": 0.65,
    "guidelines": "Be terse. Skip formatting nitpicks.",
  },
}
```

This is your personal style — it follows you across every repo, without touching their files.

---

## 5. Packs — reusable rule sets

A **pack** is a named `.yml` file in `~/.aetherreview/norms/`. Same keys as `.aetherreview.yml`, plus an
optional `name:` (the filename is the fallback name).

```yaml
# ~/.aetherreview/norms/security-strict.yml
name: security-strict
confidence_threshold: 0.5
categories: { security: true }
exclude: ["**/*.snap"]
guidelines: |
  Flag any secret in code, injection sink, or missing authz check.
```

**Two ways to activate a pack:**

- **Globally** — add its name to `norms.use` in `config.json` (applies to all repos).
- **Per-repo** — add `extends: [security-strict]` to a repo's `.aetherreview.yml`.

> A repo's `extends` resolves **by name only** to packs already installed on the reviewer's machine.
> A name it doesn't recognize is silently ignored — never fetched.

**Why packs?** Write your team's review style once, share the `.yml`, and every member drops it in
`~/.aetherreview/norms/`. No copy-pasting rules into every repo.

---

## 6. Transforms — code plugins (power users)

A **transform** is a `.mjs` module in `~/.aetherreview/norms/` that adjusts the merged norms
programmatically — for rules you can't express declaratively.

```js
// ~/.aetherreview/norms/scale-by-size.mjs
export default {
  name: "scale-by-size",
  transform(norms, ctx) {
    // be more thorough on large PRs
    if ((ctx.diffLines ?? 0) > 500) norms.maxFindings = 50;
    return norms;
  },
};
```

`ctx` gives you read-only facts: `{ forge, projectId, mr, diffLines }`.

Activate it the same way as a pack — list its name in the **global** `norms.use`.

> ⚠️ **A transform runs code with your privileges.** It lives in the same trusted folder as your
> tokens — treat dropping a `.mjs` there like installing a CLI plugin. (This is exactly why a repo
> can't activate one.)

---

## 7. Worked example (end to end)

**Your machine:**

`~/.aetherreview/config.json`

```jsonc
{
  "norms": {
    "use": ["security-strict", "scale-by-size"],
    "confidence_threshold": 0.65,
  },
}
```

`~/.aetherreview/norms/security-strict.yml` → `confidence_threshold: 0.5`, `exclude: ["**/*.snap"]`
`~/.aetherreview/norms/scale-by-size.mjs` → bumps `max_findings` to 50 when the diff is > 500 lines

**The repo** (`acme/web/.aetherreview.yml`):

```yaml
extends: [security-strict]
max_findings: 12
exclude: ["**/vendor/**"]
guidelines: "Prefer composition over inheritance."
```

**A PR with 700 changed lines resolves to:**

| Field                  | How it was decided                                                                  | Result          |
| ---------------------- | ----------------------------------------------------------------------------------- | --------------- |
| `confidence_threshold` | pack `0.5` is the lowest-precedence-but-most-recent setter below repo (repo silent) | **0.5**         |
| `max_findings`         | repo set `12`, then the transform bumped it (700 > 500)                             | **50**          |
| `exclude`              | defaults + `**/*.snap` (pack) + `**/vendor/**` (repo), unioned                      | **all of them** |
| `guidelines`           | senior-eng baseline + global + pack + repo, appended & labelled                     | **all four**    |
| `categories`           | all defaults on; pack only re-affirms security                                      | **all on**      |

---

## 8. What a repo's config can NOT do (security)

A `.aetherreview.yml` comes from a possibly-untrusted PR author, so it is sandboxed:

- `agent` and `key_ref` are **stripped** — a repo can't redirect the reviewer to another
  model/endpoint or exfiltrate your API key.
- `extends` accepts **safe bare names only** — no `../` path escapes.
- A repo can **never run a transform** — `.mjs` code executes only from your global `norms.use`.

This means your secrets and your machine stay safe no matter what a contributor commits.

---

## 9. Quick start checklist

1. Open `~/.aetherreview/config.json`, add a `norms` section with your personal defaults.
2. (Optional) Create `~/.aetherreview/norms/` and drop in team packs (`.yml`).
3. List the packs you want everywhere in `norms.use`.
4. In a specific repo, add `.aetherreview.yml` to override or `extends: [pack]` to opt in.
5. Run a review — the layers merge automatically.

Questions or a rule that doesn't fit? Ping the maintainers — packs are cheap to add.
