/** aetherreview — bare command opens the TUI; subcommands for scripting. */

import { Command, Option } from "commander";
import { stripVTControlCharacters } from "node:util";

import {
  HOME,
  gitlabUrl,
  loadCredentials,
  parseReviewerEndpoint,
  resetAll,
  reviewerConfigured,
  reviewerSettings,
} from "../engine/config.js";
import { runReview, type ReviewTarget } from "../engine/pipeline.js";
import { parsePrLink, validProjectId } from "../engine/prLink.js";
import { diagnoseReviewer } from "../engine/providers.js";
import { meetsGate, renderMarkdown, renderSarif, renderRdjson } from "../engine/report.js";
import type { Severity } from "../engine/types.js";

interface ReviewCliOptions {
  forge?: string;
  repo?: string;
  pr?: string;
  publish?: boolean;
  json?: boolean;
  format?: "terminal" | "json" | "markdown" | "sarif" | "rdjson";
  analysis?: "ai" | "static" | "hybrid";
  failOn?: Severity;
  verbose?: boolean;
  quiet?: boolean;
  staged?: boolean;
  unstaged?: boolean;
  base?: string;
  head?: string;
  includeUntracked?: boolean;
}

const program = new Command();
program.name("aetherreview").description("Local-first AI code reviewer").version("2.1.0");

program
  .command("review")
  .description("Review local Git changes, or preview a PR/MR review")
  .argument("[link]", "PR/MR URL, e.g. https://github.com/owner/repo/pull/42")
  .option("--forge <forge>", "github | gitlab")
  .option("--repo <repo>", "'owner/repo' or GitLab project path/ID")
  .option("--pr <number>", "PR / MR number")
  .option("--staged", "review only the Git index")
  .option("--unstaged", "review only unstaged tracked changes")
  .option("--base <revision>", "compare this commit or branch with HEAD or --head")
  .option("--head <revision>", "select the comparison head when using --base")
  .option("--include-untracked", "include non-ignored untracked files in a working-tree review")
  .option("--publish", "authorize posting this review to the forge")
  .addOption(
    new Option(
      "--analysis <mode>",
      "analysis engine (defaults to static when no reviewer is configured)",
    ).choices(["static", "ai", "hybrid"]),
  )
  .option("--json", "write the review outcome as JSON")
  .addOption(
    new Option("--format <format>", "report format").choices([
      "terminal",
      "json",
      "markdown",
      "sarif",
      "rdjson",
    ]),
  )
  .addOption(
    new Option("--fail-on <severity>", "exit 2 when a finding meets this severity").choices([
      "info",
      "warning",
      "critical",
    ]),
  )
  .option("--verbose", "write progress to stderr")
  .option("--quiet", "omit finding details from terminal output")
  .action(async (link: string | undefined, opts: ReviewCliOptions) => {
    const flagTarget = opts.forge || opts.repo || opts.pr;
    if (link && flagTarget) throw new Error("Use a PR/MR link or target flags for a review.");
    const localFlags =
      opts.staged || opts.unstaged || opts.base || opts.head || opts.includeUntracked;
    if ((link || flagTarget) && localFlags)
      throw new Error("Use local Git options or a remote review target.");
    if (opts.quiet && opts.verbose) throw new Error("Choose quiet or verbose output.");
    if (opts.json && opts.format && opts.format !== "json")
      throw new Error("--json conflicts with the requested report format.");
    const format = opts.format ?? (opts.json ? "json" : "terminal");
    let target: ReviewTarget | null = null;
    if (link) {
      target = parsePrLink(link);
      if (target?.forge === "gitlab") {
        const configured = new URL(gitlabUrl());
        const pasted = new URL(link);
        if (
          configured.origin !== pasted.origin ||
          !pasted.pathname.startsWith(`${configured.pathname.replace(/\/$/, "")}/`)
        ) {
          throw new Error(
            "The MR link does not match the configured GitLab server. Set GITLAB_URL to that server.",
          );
        }
        const prefix = configured.pathname.replace(/\/$/, "");
        if (prefix) target = parsePrLink(`${pasted.origin}${pasted.pathname.slice(prefix.length)}`);
      }
    } else if (opts.repo && (opts.forge === "github" || opts.forge === "gitlab")) {
      const prNumber = Number(opts.pr);
      if (
        validProjectId(opts.forge, opts.repo) &&
        /^\d+$/.test(opts.pr ?? "") &&
        Number.isSafeInteger(prNumber) &&
        prNumber > 0
      ) {
        target = { forge: opts.forge, projectId: opts.repo, prNumber };
      }
    }
    if (!target && (link || flagTarget))
      throw new Error("Pass a valid PR/MR link or all of --forge --repo --pr.");
    if (!target) {
      if (opts.publish) throw new Error("--publish requires a PR or MR target.");
      if (Number(!!opts.staged) + Number(!!opts.unstaged) + Number(opts.base !== undefined) > 1) {
        throw new Error("Choose one of --staged, --unstaged, or --base.");
      }
      if (opts.head !== undefined && opts.base === undefined)
        throw new Error("--head requires --base.");
      if (opts.includeUntracked && (opts.staged || opts.unstaged || opts.base !== undefined)) {
        throw new Error("--include-untracked is available for working-tree reviews.");
      }
      const local =
        opts.base !== undefined
          ? { mode: "compare" as const, base: opts.base, head: opts.head }
          : {
              mode: opts.staged
                ? ("staged" as const)
                : opts.unstaged
                  ? ("unstaged" as const)
                  : ("working" as const),
              includeUntracked: opts.includeUntracked,
            };
      target = { cwd: process.cwd(), local };
    }

    const settings = reviewerSettings();
    const analysis = opts.analysis ?? (reviewerConfigured() ? "ai" : "static");
    const endpoint = parseReviewerEndpoint(settings.baseUrl);
    if (analysis !== "static" && endpoint)
      console.error(`Reviewer endpoint for repository content: ${endpoint.origin}`);
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.once("SIGINT", cancel);
    const outcome = await runReview(target, opts.verbose ? console.error : () => {}, {
      publish: opts.publish,
      analysis,
      signal: controller.signal,
    }).finally(() => process.off("SIGINT", cancel));
    if (controller.signal.aborted) process.exitCode = 130;
    else if (outcome.status === "failed" || outcome.status === "partial") process.exitCode = 1;
    else if (
      outcome.status === "completed" &&
      opts.failOn &&
      meetsGate(outcome.result.findings, opts.failOn)
    )
      process.exitCode = 2;
    if (outcome.status === "partial" && format === "rdjson") console.error(outcome.result.summary);
    if (format === "json") console.log(JSON.stringify({ schemaVersion: 1, ...outcome }));
    else if (format === "sarif") console.log(JSON.stringify(renderSarif(outcome), null, 2));
    else if (format === "rdjson") console.log(JSON.stringify(renderRdjson(outcome)));
    else if (format === "markdown") console.log(renderMarkdown(outcome));
    else if (!("result" in outcome)) console.error(stripVTControlCharacters(outcome.message));
    else {
      console.log(`${opts.publish ? "Published" : "Preview"} · ${outcome.headSha.slice(0, 12)}`);
      console.log(outcome.result.summary);
      if (outcome.omittedFiles)
        console.log(`${outcome.omittedFiles} changed file(s) unavailable or over budget.`);
      for (const finding of opts.quiet ? [] : outcome.result.findings) {
        console.log(
          stripVTControlCharacters(
            `\n${finding.severity} ${finding.file}:${finding.line} ${finding.title}\n${finding.comment}`,
          ),
        );
      }
    }
  });

program
  .command("status")
  .description("Connections + model")
  .action(() => {
    const creds = loadCredentials();
    for (const forge of ["github", "gitlab"]) {
      const c = creds[forge];
      if (process.env[`${forge.toUpperCase()}_TOKEN`])
        console.log(`${forge.padEnd(10)} ✓ token from env`);
      else if (c?.user) {
        const expired = c.method === "oauth" && c.expires_at != null && c.expires_at < Date.now();
        const note = expired ? " · token expired (refreshes on next use)" : "";
        console.log(`${forge.padEnd(10)} ✓ ${c.user} (${c.method}, ${c.backend})${note}`);
      } else if (c?.token) console.log(`${forge.padEnd(10)} ✓ stored token`);
      else console.log(`${forge.padEnd(10)} ✗ not connected`);
    }
    const rs = reviewerSettings();
    console.log(
      `${"reviewer".padEnd(10)} ${reviewerConfigured() ? `✓ ${rs.model}` : "✗ not configured"}`,
    );
  });

program
  .command("doctor")
  .description("Check the configured reviewer's model endpoint without sending code")
  .action(async () => {
    const diagnostic = await diagnoseReviewer();
    console.log(diagnostic.message);
    if (!diagnostic.ok) process.exitCode = 1;
  });

program
  .command("reset")
  .description("Reset ALL config: tokens, model, logs")
  .option("-y, --yes", "skip confirmation")
  .action(async (opts) => {
    if (!opts.yes) {
      if (!process.stdin.isTTY) throw new Error("Reset requires --yes in a noninteractive shell.");
      const { createInterface } = await import("node:readline/promises");
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await rl.question(
        `This deletes saved tokens, model configuration and watcher logs in ${HOME}. Type "reset" to confirm: `,
      );
      rl.close();
      if (answer.trim().toLowerCase() !== "reset") {
        console.log("Aborted.");
        return;
      }
    }
    resetAll();
    console.log("✓ All config wiped. Run `aetherreview` to set up again.");
  });

// default: TUI
program.action(async () => {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      "The dashboard needs an interactive terminal. Run aetherreview --help for CLI commands.",
    );
  }
  const React = await import("react");
  const { render } = await import("ink");
  const { App } = await import("../tui/App.js");
  render(React.createElement(App));
});

program.parseAsync().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
