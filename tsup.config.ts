import { defineConfig } from "tsup";

export default defineConfig({
  entry: { cli: "src/cli/index.ts" },
  format: ["esm"],
  target: "node22",
  clean: true,
  banner: { js: "#!/usr/bin/env node" },
});
