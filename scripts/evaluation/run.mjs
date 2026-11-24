import process from "node:process";
import console from "node:console";
import { URL } from "node:url";
import { execFileSync, execFile } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "node:http";

const cases = JSON.parse(readFileSync(new URL("./cases.json", import.meta.url), "utf8"));
const fixture = process.argv.includes("--fixture");
const endpoint = process.env.REVIEWER_BASE_URL;
if (!fixture && (!endpoint || !process.env.REVIEWER_MODEL))
  throw Error("Set REVIEWER_BASE_URL and REVIEWER_MODEL explicitly.");
const root = mkdtempSync(join(tmpdir(), "aether-quality-"));
const cli =
  process.env.AETHER_EVAL_CLI ?? fileURLToPath(new URL("../../dist/cli.js", import.meta.url));
const capture = fileURLToPath(new URL("./capture.mjs", import.meta.url));
const { promisify } = await import("node:util");
const run = promisify(execFile);
let current;
const server = fixture
  ? createServer(async (req, res) => {
      for await (const chunk of req) void chunk;
      const [, , , evidence, label] = current;
      const findings = label
        ? [
            {
              file: "sample.js",
              line: 2,
              evidence,
              category: "bug",
              severity: "warning",
              confidence: 1,
              title: label,
              comment: label,
            },
          ]
        : [];
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ findings, summary: "fixture" }) } }],
        }),
      );
    })
  : null;
try {
  if (server) await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  for (const row of cases) {
    if (process.env.AETHER_EVAL_CASE && process.env.AETHER_EVAL_CASE !== row[0]) continue;
    current = row;
    const [id, header, oldLine, newLine, expected] = row;
    const cwd = join(root, id);
    mkdirSync(cwd);
    const git = (...args) => execFileSync("git", args, { cwd, stdio: "ignore" });
    git("init", "-q");
    const src = join(cwd, "sample.js");
    const put = (line) => writeFileSync(src, [header, line, "}", ""].join("\n"));
    put(oldLine);
    git("add", "sample.js");
    git(
      "-c",
      "user.name=Evaluation",
      "-c",
      "user.email=evaluation@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "baseline",
    );
    put(newLine);
    git("add", "sample.js");
    const locations = join(root, id + ".json");
    const env = {
      ...process.env,
      AETHERREVIEW_HOME: join(root, "settings"),
      AETHER_EVAL_CAPTURE: locations,
      REVIEWER_PASSES: "1",
      REVIEWER_MODEL: fixture ? "fixture" : process.env.REVIEWER_MODEL,
      REVIEWER_BASE_URL: server ? "http://127.0.0.1:" + server.address().port + "/v1" : endpoint,
    };
    delete env.GEMINI_API_KEY;
    if (
      fixture ||
      ["127.0.0.1", "localhost", "[::1]"].includes(new URL(env.REVIEWER_BASE_URL).hostname)
    )
      env.REVIEWER_API_KEY = "local";
    const readRaw = () =>
      existsSync(locations) ? JSON.parse(readFileSync(locations, "utf8")) : null;
    const metrics = (raw) => ({
      rawFindings: raw?.length ?? null,
      invalidLocations:
        raw?.filter((f) => f?.file !== "sample.js" || Number(f?.line) !== 2).length ?? null,
      raw: process.argv.includes("--diagnose") ? raw : undefined,
    });
    try {
      const { stdout } = await run(
        process.execPath,
        ["--import", pathToFileURL(capture).href, cli, "review", "--staged", "--json"],
        { cwd, env, timeout: 210000 },
      );
      const report = JSON.parse(stdout);
      console.log(
        JSON.stringify({
          id,
          expected,
          status: report.status,
          ...metrics(readRaw()),
          findings: report.result.findings,
        }),
      );
    } catch (error) {
      console.log(
        JSON.stringify({
          id,
          expected,
          status: "failed",
          ...metrics(readRaw()),
          message: error.stdout ? JSON.parse(error.stdout).message : "Evaluation failed",
        }),
      );
      process.exitCode = 1;
    }
  }
} finally {
  server?.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 250 });
}
