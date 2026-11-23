# Contributing

Use Node 22.12 or later and Git. Run `npm ci` from the repository root. Read the [architecture guide](docs/architecture.md) and [review invariants](docs/invariants.md) before editing the engine.

```bash
npm run verify
npm run build
npm run test:package
npm audit --omit=dev
```

Put engine regression tests next to the code in `src/engine/__tests__`. Test new forge and model behavior with controlled responses, and exercise Git changes with a disposable repository. The package smoke test uses a loopback fixture and a fresh install. Live tests require separate credentials and authorization for any posting.

Describe the affected workflow, the compatibility implications, and which environments you tested in your pull request. For security reports, follow the [security policy](SECURITY.md).
