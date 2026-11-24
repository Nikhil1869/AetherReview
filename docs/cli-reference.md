# CLI reference

| Command                  | Behavior                                                                               |
| ------------------------ | -------------------------------------------------------------------------------------- |
| `aetherreview`           | Open the forge dashboard in an interactive terminal                                    |
| `aetherreview --version` | Print the executable version                                                           |
| `aetherreview status`    | Show credential sources and the selected model                                         |
| `aetherreview doctor`    | Check the reviewer's `/models` endpoint and look for the selected model                |
| `aetherreview reset`     | Remove the app's saved credentials, model settings, logs, and locks after confirmation |

Use `reset --yes` to confirm a reset from a noninteractive shell. Custom norm files live in a separate subdirectory of the app store and are retained.

## Free local review with Ollama

With Ollama installed and running, download the local model once. In PowerShell, select the loopback endpoint for this session and run the diagnostic before reviewing staged changes.

```powershell
ollama pull qwen2.5-coder:3b
$env:REVIEWER_BASE_URL = 'http://localhost:11434/v1'
$env:REVIEWER_MODEL = 'qwen2.5-coder:3b'
aetherreview doctor
aetherreview review --staged
```

The model download requires internet access. Inference for this local tag runs on your machine without a provider API key. To disable Ollama cloud features, set `OLLAMA_NO_CLOUD=1` in the environment that starts the Ollama server. The AetherReview benchmark accepts only loopback endpoints. A review whose proposed findings all fail validation returns exit code 1. [Ollama FAQ](https://docs.ollama.com/faq) · [Measured results](p0-verification.md)

## Review targets

```bash
aetherreview review                           # working tree relative to HEAD
aetherreview review --staged                  # index relative to HEAD
aetherreview review --unstaged                # tracked working tree relative to index
aetherreview review --base main               # main tip compared directly with HEAD
aetherreview review --base SHA1 --head SHA2    # compare any two commit revisions
aetherreview review --include-untracked       # working tree plus non-ignored untracked text
aetherreview review https://github.com/owner/repo/pull/42
aetherreview review --forge gitlab --repo group/project --pr 12
```

Branch comparisons use the two selected tips. Pass their merge-base commit with `--base` when you want a merge-base comparison. Use a GitLab link on the server configured with `GITLAB_URL`. Use `--publish` to authorize a remote review. The CLI reports the model endpoint on stderr, and remote previews still need permission to read the request and its patch.

Git reviews skip binary and metadata-only patches, submodule contents, and oversized untracked files. Unmerged index entries require conflict resolution before working-tree or staged review. Only the added side of source hunks can produce findings. The engine reports omitted patches in completed previews and declines publication when it knows the patch set is incomplete.

## Reports and exit codes

```bash
aetherreview review --staged --json > review.json
aetherreview review --base main --format markdown > review.md
aetherreview review --staged --format sarif --fail-on critical > review.sarif
```

Terminal output is the default. Use `--quiet` for a terminal summary or `--verbose` for progress on stderr. JSON has `schemaVersion: 1`, a `status` of `completed`, `skipped`, or `failed`, and either a `message` or these fields.

- `headSha` is the reviewed commit for a remote request or commit comparison. It is `index` or `working-tree` for a mutable local snapshot.
- `omittedFiles` counts unavailable or over-budget patches known to the engine, excluding files deliberately omitted by norms.
- `result` contains the summary and findings. Each finding includes a stable hash for the file, line, category, and evidence, plus severity, confidence, title, and explanation. Suggested remediation is optional.

| Exit | Meaning                                                                    |
| ---- | -------------------------------------------------------------------------- |
| 0    | Completed or skipped review. Findings alone leave the exit status at zero. |
| 1    | Invalid options, provider or forge failure, or a failed diagnostic         |
| 2    | Completed review with a finding meeting the opt-in `--fail-on` threshold   |
| 130  | Interrupted with Ctrl+C                                                    |

Treat the results as review leads. Matching evidence verifies a source location. The model's explanation and suggested fix still need engineering judgment.
