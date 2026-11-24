/** Explicit opt-in. Only GETs to the two named public forges may leave this process. */
import { afterEach, expect, it, vi } from "vitest";
import { getForgeClient } from "../forge.js";
import { newSideLines, reviewDiff } from "../diff.js";
import { runReview } from "../pipeline.js";

const provider = vi.hoisted(() => ({ content: "" }));
vi.mock("openai", () => ({
  default: class {
    chat = {
      completions: {
        create: async () => ({ choices: [{ message: { content: provider.content } }] }),
      },
    };
  },
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it.each([
  ["github", "pallets/click", 3924, 1400],
  ["gitlab", "gitlab-org/cli", 2091, 3000],
] as const)(
  "maps real %s fork lines and previews with zero forge writes",
  async (forge, projectId, prNumber, budget) => {
    vi.stubEnv("GITHUB_URL", "https://api.github.com");
    vi.stubEnv("GITLAB_URL", "https://gitlab.com");
    vi.stubEnv("MAX_DIFF_CHARS", String(budget));
    vi.stubEnv("REVIEWER_BASE_URL", "http://127.0.0.1:1234/v1");
    const jobToken = forge === "github" ? process.env.AETHER_CI_READ_TOKEN : undefined;
    if (jobToken) {
      vi.stubEnv("GITHUB_TOKEN", jobToken);
      vi.stubEnv("GITHUB_BACKEND", "rest");
    }
    const nativeFetch = globalThis.fetch;
    const cache = new Map<string, Response>();
    const blocked: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const host = new URL(url).hostname;
      const headers = new Headers(init?.headers);
      if (
        (init?.method ?? "GET") !== "GET" ||
        !["api.github.com", "gitlab.com"].includes(host) ||
        (headers.has("authorization") &&
          (host !== "api.github.com" ||
            !jobToken ||
            headers.get("authorization") !== "Bearer " + jobToken)) ||
        headers.has("private-token")
      ) {
        blocked.push(host);
        throw Error("Unexpected network request");
      }
      const cached = cache.get(url);
      if (cached) return cached.clone();
      const r = await nativeFetch(url, { ...init, redirect: "error" });
      if (!/\/pulls\/\d+$|\/merge_requests\/\d+$/.test(new URL(url).pathname))
        cache.set(url, r.clone());
      return r;
    });
    const client = await getForgeClient(forge);
    try {
      const mr = await client.getMr(projectId, prNumber);
      expect(mr.sourceProjectId).toBeTruthy();
      const diffs = await client.getDiffs(projectId, prNumber);
      let added = 0;
      for (const d of diffs) {
        const lines = [...newSideLines(d.diff)].filter((l) => l.added);
        if (!lines.length) continue;
        const body = await client.getFile(mr.sourceProjectId!, d.newPath, mr.headSha);
        expect(body, d.newPath).toBeTypeOf("string");
        const source = body!.split(/\r?\n/);
        for (const l of lines)
          expect(source[l.line - 1], d.newPath + " line " + l.line).toBe(l.text);
        added += lines.length;
      }
      const file = reviewDiff(diffs, budget).files.find((d) =>
        [...newSideLines(d.diff)].some((l) => l.added && l.text.trim()),
      )!;
      const line = [...newSideLines(file.diff)].find((l) => l.added && l.text.trim())!;
      provider.content = JSON.stringify({
        findings: [
          {
            file: file.newPath,
            line: line.line,
            evidence: line.text,
            severity: "info",
            category: "testing",
            confidence: 1,
            title: "Integration anchor",
            comment: "Synthetic preview anchor.",
          },
        ],
        summary: "integration",
      });
      const outcome = await runReview({ forge, projectId, prNumber }, () => {});
      expect(outcome, outcome.status === "failed" ? outcome.message : undefined).toMatchObject({
        status: "completed",
        result: { findings: [{ file: file.newPath, line: line.line }] },
      });
      expect(blocked).toEqual([]);
      console.log(
        JSON.stringify({
          forge,
          projectId,
          auth: jobToken ? "read-only Actions token" : "anonymous",
          sourceProject: mr.sourceProjectId,
          head: mr.headSha,
          files: diffs.length,
          verifiedAddedLines: added,
          anchor: [file.newPath, line.line],
          omitted: outcome.status === "completed" ? outcome.omittedFiles : null,
        }),
      );
    } finally {
      await client.close();
    }
  },
  180000,
);
