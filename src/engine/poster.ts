/** Posting: inline findings (deduped vs existing markers, ±3 line tolerance for
 * LLM line jitter), final summary as a formal review where supported. */

import { reviewerSettings } from "./config.js";
import {
  findingMarker,
  recheckMarker,
  REVIEW_MARKER,
  STATUS_MARKER,
  type ForgeClient,
} from "./forge.js";
import { listCommitCommentBodies, postCommitComment } from "./forgeCommits.js";
import { markdownText } from "./report.js";
import type { DiffRefs, FileDiff, Finding, Forge, ReviewResult, Severity } from "./types.js";

const LABEL: Record<Severity, string> = {
  critical: "aether-review/critical",
  warning: "aether-review/warning",
  info: "aether-review/info",
};
const RANK: Record<Severity, number> = { info: 0, warning: 1, critical: 2 };
const EMOJI: Record<Severity, string> = { critical: "🛑", warning: "⚠️", info: "💡" };

const MARKER_RE = /^<!-- ct:f:(.+?):(\d+) -->$/gm;
function artifactHeader(body: string) {
  const [first, blank, third] = body.split("\n", 3);
  // Older unanchored findings put their marker below a one-line fallback notice.
  return /^_\(couldn't anchor inline — .+:\d+\)_$/.test(first) && blank === ""
    ? (third ?? "")
    : first;
}
const LINE_TOLERANCE = 3;

function commentBody(f: Finding, botName: string): string {
  const emoji = botName.toLowerCase().includes("turtle") ? "🐢" : "🤖";
  let body =
    `${findingMarker(f.file, f.line)}\n` +
    `${EMOJI[f.severity]} **${markdownText(f.title)}** · \`${f.category}\` · confidence ${f.confidence.toFixed(2)}\n\n${markdownText(f.comment)}`;
  if (f.suggestedCode) {
    body += "\n\n```suggestion\n" + f.suggestedCode + "\n```";
  } else if (f.suggestion) {
    body += `\n\n**Suggestion**\n\n${markdownText(f.suggestion)}`;
  }
  return body + `\n\n---\n_${emoji} ${botName}_`;
}

export async function finalize(
  gl: ForgeClient,
  projectId: string,
  prNumber: number,
  refs: DiffRefs,
  result: ReviewResult,
  kept: Finding[],
  statusId: number | string,
  log: (msg: string) => void = () => {},
  oldPaths?: ReadonlyMap<string, string>,
): Promise<void> {
  const botName = reviewerSettings().botName;
  const botEmoji = botName.toLowerCase().includes("turtle") ? "🐢" : "🤖";
  const existing = (await gl.listNotes(projectId, prNumber))
    .map((n) => artifactHeader(n.body))
    .join("\n");
  const existingMarkers = [...existing.matchAll(MARKER_RE)].map(
    (m) => [m[1], Number(m[2])] as const,
  );
  const alreadyPosted = (file: string, line: number) =>
    existingMarkers.some(([f, l]) => f === file && Math.abs(l - line) <= LINE_TOLERANCE);

  let maxSev: Severity | null = null;
  let posted = 0;
  for (const f of kept) {
    // severity counts every kept finding (not just newly posted ones) so the
    // label reflects the full review even when dedup skips the comments
    if (maxSev === null || RANK[f.severity] > RANK[maxSev]) maxSev = f.severity;
    if (alreadyPosted(f.file, f.line)) continue;
    posted++;
    const ok = await gl.postInlineNote(
      projectId,
      prNumber,
      f.file,
      f.line,
      commentBody(f, botName),
      refs,
      oldPaths?.get(f.file) || f.file,
    );
    if (!ok) {
      await gl.createNote(
        projectId,
        prNumber,
        `_(couldn't anchor inline — ${markdownText(f.file)}:${f.line})_\n\n${commentBody(f, botName)}`,
      );
    }
  }

  let summary: string;
  if (kept.length) {
    const counts: Record<Severity, number> = { critical: 0, warning: 0, info: 0 };
    for (const f of kept) counts[f.severity]++;
    const rows = [...kept]
      .sort(
        (a, b) =>
          RANK[b.severity] - RANK[a.severity] || a.file.localeCompare(b.file) || a.line - b.line,
      )
      .map(
        (f) =>
          `| ${EMOJI[f.severity]} ${f.severity} | ${markdownText(f.file)}:${f.line} | ${markdownText(f.title)} |`,
      )
      .join("\n");
    summary =
      `## ${botEmoji} ${botName}\n\n${markdownText(result.summary)}\n\n` +
      `### Findings\n\n` +
      `| severity | location | finding |\n|---|---|---|\n${rows}\n\n` +
      `**${counts.critical} critical · ${counts.warning} warning · ${counts.info} info**`;
  } else {
    summary = `## ${botEmoji} ${botName}\n\n✅ No issues found above the confidence threshold.`;
  }

  // "Re-review" = earlier finding markers exist on the PR.
  const isReReview = existingMarkers.length > 0;

  // A re-review that added nothing new must not repost an identical summary
  // review (MCP can't edit reviews, so each submit is a new conversation
  // entry) — the recheck note below covers it instead.
  if (posted > 0 || !isReReview) {
    if (await gl.submitReview(projectId, prNumber, summary, refs)) {
      await gl.editNote(
        projectId,
        prNumber,
        statusId,
        `${STATUS_MARKER}\n${botEmoji} Review complete — see the review summary below.`,
      );
    } else {
      await gl.editNote(projectId, prNumber, statusId, `${STATUS_MARKER}\n${summary}`);
    }
  } else {
    await gl.editNote(
      projectId,
      prNumber,
      statusId,
      `${STATUS_MARKER}\n${botEmoji} Re-checked — no new findings; the earlier review summary still applies.`,
    );
  }

  // labels are mutually exclusive: one aether-review/* label reflects the
  // current state, stale ones (e.g. clean → critical) are removed
  const allCtLabels = ["aether-review/clean", ...Object.values(LABEL)];
  const want = kept.length && maxSev ? LABEL[maxSev] : !kept.length ? "aether-review/clean" : null;
  if (want) {
    await gl.addLabels(projectId, prNumber, [want]);
    await gl.removeLabels(
      projectId,
      prNumber,
      allCtLabels.filter((l) => l !== want),
    );
  }
  if (
    isReReview &&
    posted === 0 &&
    refs.head_sha &&
    !existing.split("\n").includes(recheckMarker(refs.head_sha))
  ) {
    const short = refs.head_sha.slice(0, 8);
    const msg = kept.length
      ? `${botEmoji} ${botName} re-checked \`${short}\` — no new issues; ${kept.length} earlier finding(s) still apply.`
      : `${botEmoji} ${botName} re-checked \`${short}\` — ✅ no issues found.`;
    await gl.createNote(projectId, prNumber, `${recheckMarker(refs.head_sha)}\n${msg}`);
    log(`recheck note posted for ${short}`);
  }

  log(`posted: ${posted} new, ${kept.length - posted} already on PR`);
}

/** Push-review posting: findings as commit comments on the head commit. Same
 * marker format and ±3 dedup as the PR path — never change either (invariant 1).
 * No status note / labels: those are PR concepts. One summary per commit. */
export async function finalizeCommit(
  forge: Forge,
  projectId: string,
  branch: string,
  headSha: string,
  diffs: FileDiff[],
  result: ReviewResult,
  kept: Finding[],
  log: (msg: string) => void = () => {},
  beforeWrite?: () => Promise<void>,
): Promise<void> {
  const botName = reviewerSettings().botName;
  const botEmoji = botName.toLowerCase().includes("turtle") ? "🐢" : "🤖";
  const existing = (await listCommitCommentBodies(forge, projectId, headSha))
    .map(artifactHeader)
    .join("\n");
  const existingMarkers = [...existing.matchAll(MARKER_RE)].map(
    (m) => [m[1], Number(m[2])] as const,
  );
  const alreadyPosted = (file: string, line: number) =>
    existingMarkers.some(([f, l]) => f === file && Math.abs(l - line) <= LINE_TOLERANCE);
  const patchByFile = new Map(diffs.map((d) => [d.newPath, d.diff]));

  let posted = 0;
  for (const f of kept) {
    if (alreadyPosted(f.file, f.line)) continue;
    posted++;
    await beforeWrite?.();
    const ok = await postCommitComment(forge, projectId, headSha, commentBody(f, botName), {
      path: f.file,
      line: f.line,
      patch: patchByFile.get(f.file) ?? "",
    });
    if (!ok) {
      await beforeWrite?.();
      await postCommitComment(
        forge,
        projectId,
        headSha,
        `_(couldn't anchor inline — ${markdownText(f.file)}:${f.line})_\n\n${commentBody(f, botName)}`,
      );
    }
  }

  if (!existing.split("\n").includes(REVIEW_MARKER)) {
    let summary: string;
    if (kept.length) {
      const counts: Record<Severity, number> = { critical: 0, warning: 0, info: 0 };
      for (const f of kept) counts[f.severity]++;
      const rows = [...kept]
        .sort(
          (a, b) =>
            RANK[b.severity] - RANK[a.severity] || a.file.localeCompare(b.file) || a.line - b.line,
        )
        .map(
          (f) =>
            `| ${EMOJI[f.severity]} ${f.severity} | ${markdownText(f.file)}:${f.line} | ${markdownText(f.title)} |`,
        )
        .join("\n");
      summary =
        `## ${botEmoji} ${botName} — push to ${markdownText(branch)}\n\n${markdownText(result.summary)}\n\n` +
        `### Findings\n\n` +
        `| severity | location | finding |\n|---|---|---|\n${rows}\n\n` +
        `**${counts.critical} critical · ${counts.warning} warning · ${counts.info} info**`;
    } else {
      summary =
        `## ${botEmoji} ${botName} — push to ${markdownText(branch)}\n\n` +
        `✅ No issues found above the confidence threshold.`;
    }
    await beforeWrite?.();
    await postCommitComment(forge, projectId, headSha, `${REVIEW_MARKER}\n${summary}`);
  }

  log(`posted: ${posted} new, ${kept.length - posted} already on commit`);
}

export async function markFailed(
  gl: ForgeClient,
  projectId: string,
  prNumber: number,
  statusId: number | string,
): Promise<void> {
  const botName = reviewerSettings().botName;
  await gl.editNote(
    projectId,
    prNumber,
    statusId,
    `${STATUS_MARKER}\n⚠️ ${botName} hit an error reviewing this MR.`,
  );
}

export { REVIEW_MARKER };
