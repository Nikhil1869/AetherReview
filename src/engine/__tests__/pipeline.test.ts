import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { recordLatest } from "../state.js";
import type { FileDiff } from "../types.js";
import { makeFakeForge, type FakeForge } from "./helpers/fakeForge.js";

// shared fake forge + mocked engine deps
const ph = vi.hoisted(() => ({ fake: null as any }));
vi.mock("../forge.js", async (orig) => ({
  ...(await orig()),
  getForgeClient: vi.fn(async () => ph.fake),
}));
vi.mock("../bundler.js", () => ({ buildContext: vi.fn(async () => ({ files: [], notes: [] })) }));
vi.mock("../reviewer.js", () => ({ review: vi.fn() }));

const { runReview } = await import("../pipeline.js");
const { getForgeClient } = await import("../forge.js");
const { review } = await import("../reviewer.js");

const diff: FileDiff = {
  newPath: "a.ts",
  oldPath: "a.ts",
  diff: "@@ -1,1 +1,2 @@\n ctx\n+added\n",
  newFile: false,
  deletedFile: false,
};

let pid = 0;
const job = (over: Partial<{ projectId: string; headSha: string }> = {}) => ({
  forge: "github" as const,
  projectId: over.projectId ?? `o/r-${pid}`,
  prNumber: 1,
  headSha: over.headSha ?? "headsha",
});

beforeEach(() => {
  pid++;
  vi.mocked(getForgeClient).mockClear();
  vi.mocked(review).mockReset();
});
afterEach(() => vi.clearAllMocks());

describe("runReview", () => {
  it.each([
    ["const matches = input === [];", 1],
    ["const matches = input.length === 0;", 0],
  ] as const)(
    "retains static diagnostics and signals incomplete inference for %s",
    async (line, count) => {
      const fake = makeFakeForge({ diffs: [{ ...diff, diff: "@@ -0,0 +1 @@\n+" + line }] });
      ph.fake = fake;
      vi.mocked(fake.getFile).mockImplementation(async (_, path) =>
        path === "a.ts" ? line : null,
      );
      vi.mocked(review).mockRejectedValue(new Error("private model response"));
      const outcome = await runReview(job(), () => {}, { analysis: "hybrid" });
      expect(outcome.status).toBe("partial");
      if (!("result" in outcome)) throw Error("Missing static analysis result");
      expect(outcome.result.findings).toHaveLength(count);
      expect(outcome.result.summary).toContain("Model review inconclusive");
      expect(JSON.stringify(outcome)).not.toContain("private model response");
      const { renderSarif, renderRdjson } = await import("../report.js");
      expect(renderSarif(outcome).runs[0].invocations[0].executionSuccessful).toBe(false);
      expect(renderRdjson(outcome).diagnostics).toHaveLength(count);
      expect(fake.submitReview).not.toHaveBeenCalled();
    },
    30_000,
  );
  it("reads publication policy at the target base while bundling source from the fork", async () => {
    const fake = makeFakeForge({ diffs: [diff], mr: { sourceProjectId: "contributor/fork" } });
    ph.fake = fake;
    vi.mocked(fake.getFile).mockImplementation(async (project, path, ref) =>
      project === "contributor/fork" && path === ".aetherreview.yml" && ref === "headsha"
        ? "max_findings: 0"
        : null,
    );
    vi.mocked(review).mockResolvedValue({ findings: [], summary: "ok" });
    expect((await runReview(job(), () => {}, { publish: true })).status).toBe("completed");
    expect(fake.getFile).toHaveBeenCalledWith(job().projectId, ".aetherreview.yml", "basesha");
    expect(fake.getFile).not.toHaveBeenCalledWith(
      "contributor/fork",
      ".aetherreview.yml",
      "headsha",
    );
    const { buildContext } = await import("../bundler.js");
    expect(buildContext).toHaveBeenCalledWith(
      fake,
      "contributor/fork",
      "headsha",
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });
  it("runs end-to-end and posts findings + a summary review", async () => {
    const fake: FakeForge = makeFakeForge({ diffs: [diff] });
    ph.fake = fake;
    vi.mocked(review).mockResolvedValue({
      findings: [
        {
          file: "a.ts",
          line: 2,
          severity: "warning",
          category: "bug",
          confidence: 0.9,
          title: "t",
          comment: "c",
        },
      ],
      summary: "looks risky",
    });

    await runReview(job(), () => {}, { publish: true });
    expect(fake.inline).toHaveLength(1);
    expect(fake.inline[0]).toMatchObject({ filePath: "a.ts", newLine: 2 });
    expect(fake.submitted).toHaveLength(1);
    expect(fake.labels.length).toBeGreaterThan(0);
  });

  it("returns preview results without performing any forge writes by default", async () => {
    const fake = makeFakeForge({ diffs: [diff] });
    ph.fake = fake;
    vi.mocked(review).mockResolvedValue({ findings: [], summary: "from provider" });
    const outcome = await runReview(job(), () => {});
    expect(outcome).toMatchObject({
      status: "completed",
      headSha: "headsha",
      result: { findings: [] },
    });
    for (const write of [
      fake.postStatus,
      fake.postInlineNote,
      fake.createNote,
      fake.editNote,
      fake.submitReview,
      fake.addLabels,
      fake.removeLabels,
    ]) {
      expect(write).not.toHaveBeenCalled();
    }
  });

  it("skips publishing if the head changes during analysis", async () => {
    const fake = makeFakeForge({ diffs: [diff] });
    ph.fake = fake;
    vi.mocked(review).mockResolvedValue({ findings: [], summary: "from provider" });
    vi.mocked(fake.getMr).mockResolvedValueOnce(await fake.getMr("o/r", 1));
    vi.mocked(fake.getMr).mockResolvedValueOnce({
      headSha: "different-head",
      sourceBranch: "feature",
      targetBranch: "main",
      diffRefs: { head_sha: "different-head", base_sha: "basesha", start_sha: "startsha" },
    });
    expect(await runReview(job(), () => {}, { publish: true })).toMatchObject({
      status: "skipped",
    });
    expect(fake.postStatus).not.toHaveBeenCalled();
    expect(fake.submitReview).not.toHaveBeenCalled();
  });

  it.each(["cancel", "base"])(
    "stops remaining mutations after the status note when the %s guard fires",
    async (reason) => {
      const controller = new AbortController();
      const fake = makeFakeForge({ diffs: [diff] });
      ph.fake = fake;
      vi.mocked(review).mockResolvedValue({ findings: [], summary: "ok" });
      vi.mocked(fake.postStatus).mockImplementationOnce(async () => {
        await fake.beforeWrite!();
        if (reason === "cancel") controller.abort();
        else
          vi.mocked(fake.getMr).mockResolvedValue({
            ...(await fake.getMr("o/r", 1)),
            diffRefs: { head_sha: "headsha", base_sha: "new", start_sha: "startsha" },
          });
        return 1;
      });
      vi.mocked(fake.submitReview).mockImplementationOnce(async () => {
        await fake.beforeWrite!();
        return true;
      });
      expect(
        await runReview(job(), () => {}, { publish: true, signal: controller.signal }),
      ).toMatchObject({ status: "skipped" });
      expect(fake.edited).toEqual([]);
      expect(fake.labels).toEqual([]);
    },
  );

  it("fails a provider failure without writing a clean label or summary", async () => {
    const fake = makeFakeForge({ diffs: [diff] });
    ph.fake = fake;
    vi.mocked(review).mockRejectedValue(new Error("Reviewer returned an invalid response."));
    expect(await runReview(job(), () => {}, { publish: true })).toMatchObject({ status: "failed" });
    expect(fake.addLabels).not.toHaveBeenCalled();
    expect(fake.submitReview).not.toHaveBeenCalled();
  });

  it("skips a superseded head sha before opening a forge client", async () => {
    const j = job();
    recordLatest(j.projectId, j.prNumber, "newer-sha"); // newer than j.headSha
    await runReview(j);
    expect(getForgeClient).not.toHaveBeenCalled();
    expect(review).not.toHaveBeenCalled();
  });

  it("reports nothing to review when there are no diffs", async () => {
    ph.fake = makeFakeForge({ diffs: [] });
    const logs: string[] = [];
    await runReview(job(), (m) => logs.push(m));
    expect(review).not.toHaveBeenCalled();
    // terminal log line — the TUI uses it to clear the "reviewing…" status
    expect(logs.some((m) => /pr=1 nothing to review/.test(m))).toBe(true);
  });

  it("releases the lock when the forge client can't even be constructed", async () => {
    const j = job();
    vi.mocked(getForgeClient).mockRejectedValueOnce(new Error("token refresh failed"));
    const logs: string[] = [];
    await runReview(j, (m) => logs.push(m));
    expect(
      logs.some((m) => m.includes("review failed") && m.includes("token refresh failed")),
    ).toBe(true);
    // lock must be free again — a second run reaches the forge stage
    ph.fake = makeFakeForge({ diffs: [] });
    const logs2: string[] = [];
    await runReview(j, (m) => logs2.push(m));
    expect(logs2.some((m) => m.includes("nothing to review"))).toBe(true);
    expect(logs2.some((m) => m.includes("already locked"))).toBe(false);
  });

  it("drops findings below the confidence threshold", async () => {
    const fake = makeFakeForge({ diffs: [diff] });
    ph.fake = fake;
    vi.mocked(review).mockResolvedValue({
      findings: [
        {
          file: "a.ts",
          line: 2,
          severity: "info",
          category: "style",
          confidence: 0.1,
          title: "t",
          comment: "c",
        },
      ],
      summary: "ok",
    });
    await runReview(job(), () => {}, { publish: true });
    expect(fake.inline).toHaveLength(0); // below default threshold 0.7
    expect(fake.labels).toContain("aether-review/clean");
  });
});
