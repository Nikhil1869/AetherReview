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

Before publishing, verify the registry namespace under the owner account, reconcile the version with tagged releases and the packaged executable, and obtain maintainer approval. Verify GitHub and GitLab writes with dedicated least-privilege credentials on disposable fixtures. Require passing quality gates, recorded dependency risk decisions and CI results for each supported OS and Node version on the exact release candidate. Local inference has been exercised. A hosted comparison requires a separately authorized zero-charge endpoint. The [November 26 production-readiness report](evaluation/2026-11-26/README.md) records the failed quality gates and live tests still pending.
