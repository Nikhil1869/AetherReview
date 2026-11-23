# Changelog

## Unreleased

- Review a local working tree, index, or commit comparison from the CLI.
- Preview remote reviews by default and authorize posting explicitly.
- Require evidence at the reported new-side file and line. Reject invalid reviewer responses without emitting a clean result.
- Export JSON, Markdown, and SARIF, with an optional severity gate for scripts.
- Check model discovery with `aetherreview doctor` and verify the packed CLI with a clean installation.
- Page through PR and MR file lists, preserve renamed paths for GitLab inline comments, and recheck the remote head before posting.
