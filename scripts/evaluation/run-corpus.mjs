import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import console from "node:console";
import { URL, fileURLToPath } from "node:url";
import { promisify } from "node:util";
const run = promisify(execFile);
const [mode, split] = process.argv.slice(2);
if (
  !["static", "ai", "hybrid"].includes(mode) ||
  !["development", "heldOut", "all"].includes(split)
)
  throw Error(
    "Usage: node scripts/evaluation/run-corpus.mjs <static|ai|hybrid> <development|heldOut|all>",
  );
const endpoint = process.env.REVIEWER_BASE_URL ?? "";
if (mode !== "static") {
  const u = new URL(endpoint);
  if (
    !["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) ||
    u.protocol !== "http:" ||
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    !process.env.REVIEWER_MODEL
  )
    throw Error("Select an explicit loopback model.");
}
const { cases } = JSON.parse(
  await readFile(new URL("./eslint-corpus.json", import.meta.url), "utf8"),
);
const root = await mkdtemp(join(tmpdir(), "aether-corpus-"));
const cli = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));
const capture = new URL("./capture.mjs", import.meta.url).href;
const resource = new URL("./resource-usage.mjs", import.meta.url).href;
const env = {
  ...process.env,
  AETHERREVIEW_HOME: join(root, "settings"),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
  REVIEWER_PASSES: "1",
};
for (const key of Object.keys(env))
  if (
    /^(?:GITHUB_|GITLAB_|GEMINI_|REVIEWER_API_KEY|OPENAI_|GIT_CONFIG_(?:KEY|VALUE|COUNT)|NODE_OPTIONS)/i.test(
      key,
    )
  )
    delete env[key];
try {
  for (const row of cases) {
    if (split !== "all" && row.split !== split) continue;
    const cwd = join(root, row.id);
    await mkdir(cwd);
    await run("git", ["init", "-q", "--template="], { cwd, env });
    await writeFile(join(cwd, "sample.js"), row.code + "\n");
    await run("git", ["-c", "core.autocrlf=false", "add", "--", "sample.js"], { cwd, env });
    const usage = join(cwd, "usage.json"),
      raw = join(cwd, "raw.json");
    const started = performance.now();
    let stdout;
    try {
      ({ stdout } = await run(
        process.execPath,
        [
          "--import",
          resource,
          "--import",
          capture,
          cli,
          "review",
          "--staged",
          "--analysis",
          mode,
          "--json",
        ],
        {
          cwd,
          env: { ...env, AETHER_EVAL_RESOURCE: usage, AETHER_EVAL_CAPTURE: raw },
          timeout: 240000,
          maxBuffer: 2 ** 20,
        },
      ));
    } catch (e) {
      stdout = e.stdout;
    }
    const elapsedMs = Math.round(performance.now() - started);
    let result;
    try {
      result = JSON.parse(stdout);
    } catch {
      result = { status: "failed", message: "CLI exited without a JSON verdict." };
    }
    const stats = await readFile(usage, "utf8").then(JSON.parse, () => null);
    const proposals = await readFile(raw, "utf8").then(JSON.parse, () => null);
    console.log(
      JSON.stringify({
        id: row.id,
        split: row.split,
        mode,
        status: result.status,
        elapsedMs,
        stats,
        findings: result.result?.findings,
        proposals,
        message: result.message,
      }),
    );
  }
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
}
