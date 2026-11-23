# Release verification

The npm package name is `aether-review`, and the executable is `aetherreview`. The source project currently uses version 2.1.0. Use a tarball while public distribution and package ownership are being verified.

```bash
npm ci
npm run verify
npm audit --omit=dev
npm run test:package
npm pack
```

Install the generated tarball from a separate directory. Run `aetherreview --version`, `aetherreview doctor`, and a local review. Remove a global tarball installation with `npm uninstall --global aether-review`. Separately use `aetherreview reset` if you want to remove saved app configuration.

Before publishing, verify the registry namespace under the owner account, reconcile the version with tagged releases and the packaged executable, and obtain maintainer approval. Verify GitHub and GitLab with least-privilege credentials, confirm at least one supported real local and hosted reviewer, and retain CI results for each supported operating system. See the [production audit](production-audit.md) for the current evidence.
