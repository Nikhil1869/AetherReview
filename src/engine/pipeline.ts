/** Core review loop: superseding check, lock, context bundle, LLM call, post. */

import { buildContext } from "./bundler.js";
import { reviewLimits } from "./config.js";
import { newSideLines, reviewDiff } from "./diff.js";
import { describeError, getForgeClient, getRestForgeClient, type ForgeClient } from "./forge.js";
import { branchHead, compareDiffs } from "./forgeCommits.js";
import { readLocalChanges, type LocalTarget } from "./localGit.js";
import { applyExcludes, loadNorms } from "./norms.js";
import { finalize, finalizeCommit, markFailed } from "./poster.js";
import { review } from "./reviewer.js";
import * as state from "./state.js";
import type { FileDiff, Job, MrInfo, Norms, PushJob, ReviewResult } from "./types.js";

class PublicationStopped extends Error {}

export type Logger = (msg: string) => void;

export interface ReviewOptions {
  publish?: boolean;
  signal?: AbortSignal;
}

export type ReviewOutcome =
  | { status: "completed"; headSha: string; result: ReviewResult; omittedFiles: number }
  | { status: "skipped" | "failed"; message: string };

export type ReviewTarget =
  | (Omit<Job, "headSha"> & Partial<Pick<Job, "headSha">>)
  | { cwd: string; local: LocalTarget };

function acceptedFindings(result: ReviewResult, norms: Norms) {
  return result.findings
    .filter((f) => f.confidence >= norms.confidenceThreshold)
    .slice(0, norms.maxFindings);
}

function completedReview(
  headSha: string,
  findings: ReviewResult["findings"],
  omittedFiles: number,
): Extract<ReviewOutcome, { status: "completed" }> {
  const summary = findings.length
    ? `${findings.length} finding(s) above the confidence threshold.`
    : "No findings above the confidence threshold in the reviewed diff.";
  return { status: "completed", headSha, result: { findings, summary }, omittedFiles };
}

async function reviewWorkingTree(
  target: Extract<ReviewTarget, { local: LocalTarget }>,
  log: Logger,
  options: ReviewOptions,
): Promise<ReviewOutcome> {
  if (options.publish === true)
    return { status: "failed", message: "Local reviews have no publication target." };
  try {
    const source = await readLocalChanges(target.cwd, target.local, options.signal);
    if (!source.diffs.length) return { status: "skipped", message: "No changes to review." };
    const mr: MrInfo = {
      headSha: source.headSha,
      sourceBranch: "",
      targetBranch: "",
      diffRefs: { head_sha: source.headSha, base_sha: "", start_sha: "" },
    };
    const norms = await loadNorms(source, source.root, mr, {
      diffLines: countAddedLines(source.diffs),
    });
    const files = applyExcludes(source.diffs, norms);
    const diff = reviewDiff(files, reviewLimits().maxDiffChars);
    if (!diff.files.length)
      return {
        status: "skipped",
        message: files.length
          ? "No text patches available within the review budget."
          : "All changed files excluded by norms.",
      };
    const context = await buildContext(source, source.root, source.headSha, diff.files, norms, log);
    const result = await review(diff, context, norms, log, options.signal);
    return completedReview(
      source.headSha,
      acceptedFindings(result, norms),
      files.length - diff.files.length,
    );
  } catch (error) {
    return {
      status: "failed",
      message: options.signal?.aborted
        ? "Review cancelled."
        : error instanceof Error
          ? error.message
          : "Local review failed.",
    };
  }
}

/** Count added lines across a diff set — a cheap signal for norm code transforms. */
function countAddedLines(diffs: FileDiff[]): number {
  let n = 0;
  for (const d of diffs) {
    for (const line of newSideLines(d.diff)) {
      if (line.added) n++;
    }
  }
  return n;
}

export async function runReview(
  job: ReviewTarget,
  log: Logger = console.log,
  options: ReviewOptions = {},
): Promise<ReviewOutcome> {
  if ("local" in job) return reviewWorkingTree(job, log, options);
  const { projectId, prNumber, headSha } = job;
  const skip = (message: string): ReviewOutcome => {
    log(`pr=${prNumber} ${message}`);
    return { status: "skipped", message };
  };
  if (options.signal?.aborted) return skip("cancelled");
  if (headSha && !state.isLatest(projectId, prNumber, headSha)) {
    return skip("superseded by a newer head");
  }
  if (!state.acquireLock(projectId, prNumber)) {
    return skip("already locked by another review");
  }

  // client construction can fail (token refresh is a network call) — the lock
  // must still be released, so it happens under the same finally
  let gl: ForgeClient | null = null;
  let statusId: number | string | null = null;
  try {
    gl = await getForgeClient(job.forge);
    const mr = await gl.getMr(projectId, prNumber);
    const refs = mr.diffRefs;
    const headRef = mr.headSha;
    if (!headRef || refs?.head_sha !== headRef) {
      throw new Error("The forge has not supplied diff references for the current head.");
    }
    if (headSha && headSha !== headRef) return skip("superseded by a newer head");
    const diffs = await gl.getDiffs(projectId, prNumber);
    const missingFiles = Math.max(0, (mr.changedFiles ?? diffs.length) - diffs.length);
    if (missingFiles && !diffs.length)
      throw new Error("The forge did not return the changed file patches.");
    if (!diffs.length) {
      return skip("nothing to review");
    }
    const sourceProject = mr.sourceProjectId ?? projectId;
    const norms = await loadNorms(gl, sourceProject, mr, {
      forge: job.forge,
      diffLines: countAddedLines(diffs),
    });
    const filtered = applyExcludes(diffs, norms);
    if (!filtered.length) {
      return skip("all changed files excluded");
    }
    const diff = reviewDiff(filtered, reviewLimits().maxDiffChars);
    if (!diff.files.length) return skip("no patches available within the review budget");
    const omittedFiles = missingFiles + filtered.length - diff.files.length;
    if (omittedFiles && options.publish === true) {
      throw new Error(
        `${omittedFiles} changed file(s) unavailable or over budget. Run a preview for partial results.`,
      );
    }
    const context = await buildContext(gl, sourceProject, headRef, diff.files, norms, log);
    const result = await review(diff, context, norms, log, options.signal);
    const kept = acceptedFindings(result, norms);
    const client = gl;
    const ensureCurrent = async () => {
      const current = await client.getMr(projectId, prNumber);
      if (options.signal?.aborted) throw new PublicationStopped("cancelled");
      if (
        current.headSha !== headRef ||
        current.diffRefs?.head_sha !== headRef ||
        current.diffRefs.base_sha !== refs.base_sha ||
        current.diffRefs.start_sha !== refs.start_sha ||
        current.sourceProjectId !== mr.sourceProjectId ||
        !state.isLatest(projectId, prNumber, headRef)
      ) {
        throw new PublicationStopped("superseded by a newer head or base");
      }
    };
    await ensureCurrent();
    const outcome = completedReview(headRef, kept, omittedFiles);
    if (options.publish === true) {
      gl.beforeWrite = ensureCurrent;
      statusId = await gl.postStatus(
        projectId,
        prNumber,
        "🐢 **AetherReview** is publishing this review…",
      );
      const oldPaths = new Map(diff.files.map((file) => [file.newPath, file.oldPath]));
      await finalize(gl, projectId, prNumber, refs, outcome.result, kept, statusId, log, oldPaths);
    }
    log(`pr=${prNumber} found=${result.findings.length} kept=${kept.length}`);
    return outcome;
  } catch (e) {
    if (options.signal?.aborted || e instanceof PublicationStopped)
      return skip(options.signal?.aborted ? "cancelled" : (e as Error).message);
    const message = describeError(e);
    log(`review failed pr=${prNumber}: ${message}`);
    if (gl && statusId != null) await markFailed(gl, projectId, prNumber, statusId).catch(() => {});
    return { status: "failed", message };
  } finally {
    await gl?.close().catch(() => {});
    state.releaseLock(projectId, prNumber);
  }
}

/** Push-review entrypoint: a branch push with no open PR. Same lock +
 * superseding discipline as runReview, keyed by `branch:<name>` (invariant 7).
 * Findings land as commit comments on the head commit. */
export async function runPushReview(
  job: PushJob,
  log: Logger = console.log,
  options: ReviewOptions = {},
): Promise<void> {
  if (options.publish !== true || options.signal?.aborted) return;
  const { forge, projectId, branch, headSha, baseSha } = job;
  const ref = `branch:${branch}`;
  if (!state.isLatest(projectId, ref, headSha)) {
    log(`branch=${branch} superseded; skipping ${headSha}`);
    return;
  }
  if (!state.acquireLock(projectId, ref)) {
    log(`branch=${branch} already locked; skipping`);
    return;
  }

  let gl: ForgeClient | null = null;
  try {
    gl = await getRestForgeClient(forge);
    const diffs = await compareDiffs(forge, projectId, baseSha, headSha);
    if (!diffs.length) {
      log(`branch=${branch} nothing to review`);
      return;
    }
    // norms loader only needs a ref to read .aetherreview.yml from
    const mrLike: MrInfo = {
      sourceBranch: branch,
      targetBranch: "",
      headSha,
      diffRefs: { head_sha: headSha, base_sha: baseSha, start_sha: baseSha },
    };
    const norms = await loadNorms(gl, projectId, mrLike, {
      forge,
      diffLines: countAddedLines(diffs),
    });
    const filtered = applyExcludes(diffs, norms);
    if (!filtered.length) {
      log(`branch=${branch} all changed files excluded by norms`);
      return;
    }
    const diff = reviewDiff(filtered, reviewLimits().maxDiffChars);
    if (diff.files.length !== filtered.length) {
      log(`branch=${branch} incomplete patch set; skipping publication`);
      return;
    }
    const context = await buildContext(gl, projectId, headSha, diff.files, norms, log);
    const result = await review(diff, context, norms, log, options.signal);
    const kept = acceptedFindings(result, norms);
    if (options.signal?.aborted || !state.isLatest(projectId, ref, headSha)) return;
    log(`branch=${branch} found=${result.findings.length} kept=${kept.length}`);
    const outcome = completedReview(headSha, kept, 0);
    await finalizeCommit(
      forge,
      projectId,
      branch,
      headSha,
      filtered,
      outcome.result,
      kept,
      log,
      async () => {
        const current = await branchHead(forge, projectId, branch);
        if (
          options.signal?.aborted ||
          current !== headSha ||
          !state.isLatest(projectId, ref, headSha)
        )
          throw new PublicationStopped("Branch publication cancelled or superseded.");
      },
    );
  } catch (e) {
    log(`review failed branch=${branch}: ${describeError(e)}`);
  } finally {
    await gl?.close().catch(() => {});
    state.releaseLock(projectId, ref);
  }
}
