import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const project = dirname(dirname(fileURLToPath(import.meta.url)));
const temp = await mkdtemp(join(tmpdir(), "aetherreview-package-"));
const installed = join(temp, "install");
const repo = join(temp, "fixture repo");
const appHome = join(temp, "app-home");
const npm = process.env.npm_execpath;

if (!npm) throw new Error("Run this via npm run test:package.");
const requests = [];
const promptBytes = [];
let invalidModelOutput = false;
const file = "sample.ts";
const evidence = "export const count = -1;";
const patch = `@@ -1 +1 @@\n-export const count = 1;\n+${evidence}\n`;
const finding = {
  file,
  line: 1,
  evidence,
  category: "bug",
  severity: "warning",
  confidence: 0.9,
  title: "Invalid initial count",
  comment: "The counter now starts below zero.",
};
const server = createServer(async (req, res) => {
  requests.push(`${req.method} ${req.url}`);
  const json = (payload, status = 200) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
  };
  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    let body = "";
    for await (const chunk of req) body += chunk.toString();
    const payload = JSON.parse(body);
    promptBytes.push(
      payload.messages.reduce((size, message) => size + Buffer.byteLength(message.content), 0),
    );
    if (!body.includes(evidence)) return json({ error: { message: "fixture diff missing" } }, 400);
    const content = invalidModelOutput
      ? "PRIVATE_PROVIDER_BODY"
      : JSON.stringify({ findings: [finding], summary: "fixture" });
    return json({ choices: [{ message: { content }, finish_reason: "stop" }] });
  }
  if (req.method === "GET" && req.url === "/repos/fixture/project/pulls/1") {
    return json({
      head: { ref: "feature", sha: "fixture-head" },
      base: { ref: "main", sha: "fixture-base" },
    });
  }
  if (req.method === "GET" && req.url === "/v1/models") return json({ data: [{ id: "fixture" }] });
  if (req.method === "GET" && req.url?.startsWith("/repos/fixture/project/pulls/1/files")) {
    return json([{ filename: file, status: "modified", patch }]);
  }
  return json({}, 404);
});

try {
  await mkdir(installed);
  await mkdir(repo);
  await new Promise((resolve, reject) =>
    server.once("error", reject).listen(0, "127.0.0.1", resolve),
  );
  const origin = `http://127.0.0.1:${server.address().port}`;
  const env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !/^(?:REVIEWER_|MAX_(?:CONTEXT|DIFF)|GITLAB_|GITHUB_|GIT_|GEMINI_)/i.test(key),
      ),
    ),
    AETHERREVIEW_HOME: appHome,
    GITHUB_TOKEN: "fixture-token",
    GITHUB_BACKEND: "rest",
    GITHUB_URL: origin,
    REVIEWER_BASE_URL: `${origin}/v1`,
    REVIEWER_MODEL: "fixture",
  };
  const npmRun = (cwd, ...args) =>
    // A fresh global-style install can spend several minutes extracting dependencies on Windows.
    run(process.execPath, [npm, ...args], {
      cwd,
      env,
      timeout: args[0] === "install" ? 300_000 : 120_000,
    });
  const git = (...args) => run("git", args, { cwd: repo, env, timeout: 60_000 });
  const expectedVersion = JSON.parse(await readFile(join(project, "package.json"), "utf8")).version;
  const packed = await npmRun(project, "pack", "--json", "--pack-destination", temp);
  const jsonStart = packed.stdout.search(/^\[$/m);
  assert(jsonStart >= 0, "npm pack did not return a JSON manifest");
  const [{ filename, files }] = JSON.parse(packed.stdout.slice(jsonStart));
  for (const required of ["dist/cli.js", "package.json", "LICENSE", "README.md"]) {
    assert(
      files.some(({ path }) => path === required),
      `missing from tarball: ${required}`,
    );
  }
  await npmRun(
    installed,
    "install",
    "--no-audit",
    "--no-fund",
    "--ignore-scripts",
    join(temp, filename),
  );
  const binary = join(installed, "node_modules", "aether-review", "dist", "cli.js");
  const cli = (...args) =>
    run(process.execPath, [binary, ...args], { cwd: repo, env, timeout: 15_000 });
  const shim = await npmRun(installed, "exec", "--no", "--", "aetherreview", "--version");
  assert.equal(shim.stdout.trim(), expectedVersion);
  assert.match((await cli("--help")).stdout, /review|status/);
  assert.match((await cli("review", "--help")).stdout, /--staged/);
  assert.match((await cli("status")).stdout, /fixture/);
  assert.match((await cli("doctor")).stdout, /lists the configured model/);
  await assert.rejects(
    cli(),
    (error) => error.code === 1 && /interactive terminal/.test(error.stderr),
  );
  await assert.rejects(
    cli("review", "--publish"),
    (error) => error.code === 1 && /requires a PR or MR/.test(error.stderr),
  );
  await assert.rejects(
    cli("review", "--staged", "--unstaged"),
    (error) => error.code === 1 && /Choose one/.test(error.stderr),
  );

  await git("init", "-q");
  await writeFile(join(repo, file), "export const count = 1;\n");
  await git("add", file);
  await git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "baseline",
  );
  await writeFile(join(repo, file), `${evidence}\n`);
  await git("add", file);
  const reviewed = JSON.parse((await cli("review", "--staged", "--json")).stdout);
  assert.equal(reviewed.schemaVersion, 1);
  assert.equal(reviewed.status, "completed");
  assert.equal(reviewed.headSha, "index");
  assert.equal(reviewed.result.findings[0].evidence, evidence);
  assert.match(reviewed.result.findings[0].id, /^[a-f0-9]{64}$/);
  const beforeStatic = requests.length;
  const staticReport = JSON.parse(
    (await cli("review", "--staged", "--analysis", "static", "--format", "rdjson")).stdout,
  );
  assert.deepEqual(staticReport.diagnostics, []);
  assert.equal(requests.length, beforeStatic);
  const hybridReport = JSON.parse(
    (await cli("review", "--staged", "--analysis", "hybrid", "--json")).stdout,
  );
  assert.equal(hybridReport.result.findings[0].verification, "source-anchored");
  const sarif = JSON.parse((await cli("review", "--staged", "--format", "sarif")).stdout);
  assert.equal(sarif.runs[0].results[0].locations[0].physicalLocation.region.startLine, 1);
  assert.match(
    (await cli("review", "--staged", "--format", "markdown")).stdout,
    /Invalid initial count/,
  );
  await assert.rejects(cli("review", "--staged", "--fail-on", "warning"), { code: 2 });

  const remote = JSON.parse((await cli("review", "fixture/project#1", "--json")).stdout);
  assert.equal(remote.status, "completed");
  assert.equal(remote.result.findings[0].line, 1);
  assert(!requests.some((request) => /^(?:POST|PUT|PATCH|DELETE) \/repos\//.test(request)));

  invalidModelOutput = true;
  await assert.rejects(cli("review", "--staged", "--analysis", "hybrid", "--json"), (error) => {
    const result = JSON.parse(error.stdout);
    return error.code === 1 && result.status === "partial" && result.result.findings.length === 0;
  });
  await assert.rejects(cli("review", "--staged", "--json", "--verbose"), (error) => {
    const result = JSON.parse(error.stdout);
    return (
      error.code === 1 &&
      result.status === "failed" &&
      !`${error.stdout}${error.stderr}`.includes("PRIVATE_PROVIDER_BODY")
    );
  });
  if (process.argv.includes("--benchmark")) {
    invalidModelOutput = false;
    const resourceTrace =
      "data:text/javascript," +
      encodeURIComponent(
        'import process from "node:process"; process.once("exit", () => process.stderr.write("benchmark-rss=" + process.resourceUsage().maxRSS + "\\n"));',
      );
    const percentile = (values, fraction) =>
      [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];
    for (const [total, changed] of [
      [12, 1],
      [250, 5],
      [2000, 20],
    ]) {
      const generated = join(repo, "generated");
      await mkdir(generated, { recursive: true });
      for (let i = 1; i < total; i++) {
        await writeFile(join(generated, `file-${i}.ts`), `export const value${i} = ${i};\n`);
      }
      await writeFile(join(repo, file), "export const count = 1;\n");
      await git("add", ".");
      await git(
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--allow-empty",
        "-qm",
        "size baseline",
      );
      await writeFile(join(repo, file), `${evidence}\n`);
      for (let i = 1; i < changed; i++) {
        await writeFile(join(generated, `file-${i}.ts`), `export const value${i} = ${i + 1};\n`);
      }
      const times = [];
      const rss = [];
      const bytes = [];
      for (let i = 0; i < 7; i++) {
        const start = performance.now();
        const response = await run(
          process.execPath,
          ["--import", resourceTrace, binary, "review", "--json"],
          { cwd: repo, env, timeout: 30_000 },
        );
        times.push(Math.round(performance.now() - start));
        const memory = /benchmark-rss=(\d+)/.exec(response.stderr);
        assert(memory);
        rss.push(Number(memory[1]));
        bytes.push(promptBytes.at(-1));
        const output = JSON.parse(response.stdout);
        assert.equal(output.status, "completed");
        assert.equal(output.result.findings.length, 1);
        assert.equal(output.result.findings[0].evidence, evidence);
        assert.equal(output.omittedFiles, 0);
      }
      process.stdout.write(
        JSON.stringify({
          files: total,
          changed,
          completed: times.length,
          p50Ms: percentile(times, 0.5),
          p95Ms: percentile(times, 0.95),
          maxCliRssKiB: Math.max(...rss),
          maxPromptBytes: Math.max(...bytes),
        }) + "\n",
      );
    }
  }
  await cli("reset", "--yes");
  await npmRun(installed, "uninstall", "--no-audit", "--no-fund", "aether-review");
  await assert.rejects(readFile(binary), { code: "ENOENT" });
  process.stdout.write(
    "Packed CLI installed, ran local and read-only remote reviews, handled invalid output, and uninstalled.\n",
  );
} finally {
  server.close();
  await rm(temp, { recursive: true, force: true, maxRetries: 6, retryDelay: 250 });
}
