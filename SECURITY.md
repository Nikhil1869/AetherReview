# Security policy

## Report a vulnerability

Use GitHub's private vulnerability reporting for the repository if it is available. If the option is unavailable, open an issue asking the maintainer for a private contact channel. Keep credentials, private source, and sensitive reproduction material out of public issues. [Repository security](https://github.com/Nikhil1869/AetherReview/security)

## Data and execution boundaries

- The configured reviewer receives diff text and selected repository context. Use a loopback endpoint for local inference. Hosted reviewers receive the same inputs over HTTPS. GitHub and GitLab workflows also contact the chosen forge.
- AetherReview writes its credential files and GitHub App key inside the app store using owner-only file modes on Unix. Windows permissions depend on the user's profile ACL. Stored credentials are scoped to their configured origin when using endpoint overrides. Set environment variables for credentials in CI and give preview tokens read access to the selected repositories.
- Local reviews use the Git executable from outside the reviewed repository, with the worktree pinned to the discovered root. Git external diff, text conversion, filesystem monitor, and named clean filters are disabled for local extraction. Extra working-tree context is limited to regular files in the repository.
- Repository norms are limited to declarative review preferences. Only globally activated local `.mjs` transforms execute, with the same privileges as the CLI. Treat a transform as installed code.
- The reviewer treats repository content as input data. Findings require source evidence at the reported added line. Provider error text is kept out of review logs. Source anchoring cannot establish that a model's behavioral interpretation is correct.
- Remote posting requires explicit authorization. Verify the account and repository scope before enabling automatic publishing. Local previews and exported reports may contain snippets of proprietary source.

The [production audit](docs/production-audit.md) tracks unresolved security and release work, including native pending-review ownership, live adapter verification, and stronger secret detection.
