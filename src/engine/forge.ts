/** Forge clients. GitHub default backend is MCP (see forgeMcp.ts); REST
 * clients here cover GitLab and the GITHUB_BACKEND=rest escape hatch. */

import { ForgeSession } from "./forgeSession.js";
import { gitlabUrl, resolveToken } from "./config.js";
import type { DiffRefs, FileDiff, MrInfo } from "./types.js";

export const STATUS_MARKER = "<!-- ct:status -->";
export const REVIEW_MARKER = "<!-- ct:review -->";

export const findingMarker = (file: string, line: number) => `<!-- ct:f:${file}:${line} -->`;
// posted once per re-reviewed head commit that produced nothing new
export const recheckMarker = (sha: string) => `<!-- ct:recheck:${sha} -->`;

export interface Note {
  id: number | string | null;
  body: string;
}

/** Error → log line. undici buries the real reason ("fetch failed") in
 * error.cause — surface it so network failures are diagnosable. */
export function describeError(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const cause = e.cause instanceof Error ? e.cause.message : e.cause ? String(e.cause) : "";
  return cause && !e.message.includes(cause) ? `${e.message} (${cause})` : e.message;
}

export async function readDiffPages<T>(
  readPage: (page: number) => Promise<{ files: T[]; more: boolean }>,
): Promise<T[]> {
  const diffs: T[] = [];
  for (let page = 1; page <= 30; page++) {
    const { files, more } = await readPage(page);
    diffs.push(...files);
    if (!more) return diffs;
  }
  throw new Error("The forge diff exceeded the review pagination limit.");
}

export interface ForgeClient {
  beforeWrite?: () => Promise<void>;
  close(): Promise<void>;
  getMr(projectId: string, prNumber: number): Promise<MrInfo>;
  getDiffs(projectId: string, prNumber: number): Promise<FileDiff[]>;
  getFile(projectId: string, path: string, ref: string): Promise<string | null>;
  searchBlobs(projectId: string, query: string, ref: string): Promise<{ path: string }[]>;
  createNote(projectId: string, prNumber: number, body: string): Promise<number | string>;
  editNote(
    projectId: string,
    prNumber: number,
    noteId: number | string,
    body: string,
  ): Promise<void>;
  listNotes(projectId: string, prNumber: number): Promise<Note[]>;
  postStatus(projectId: string, prNumber: number, body: string): Promise<number | string>;
  postInlineNote(
    projectId: string,
    prNumber: number,
    filePath: string,
    newLine: number,
    body: string,
    refs: DiffRefs,
    oldPath?: string,
  ): Promise<boolean>;
  addLabels(projectId: string, prNumber: number, labels: string[]): Promise<void>;
  removeLabels(projectId: string, prNumber: number, labels: string[]): Promise<void>;
  submitReview(projectId: string, prNumber: number, body: string, refs: DiffRefs): Promise<boolean>;
  listOpenPrs(projectId: string): Promise<{ iid: number; headSha: string }[]>;
}

// ---- GitLab (REST) -------------------------------------------------------------

export class GitLabClient implements ForgeClient {
  private base: string;
  private headers: Record<string, string>;

  readonly session: ForgeSession;
  set beforeWrite(guard: () => Promise<void>) {
    this.session.beforeWrite = guard;
  }

  constructor() {
    this.base = `${gitlabUrl()}/api/v4`;
    const token = resolveToken("gitlab");
    this.headers = token ? { "PRIVATE-TOKEN": token } : {};
    this.session = new ForgeSession(this.base, this.headers, false);
  }

  async close() {}

  private enc(projectId: string): string {
    return encodeURIComponent(projectId);
  }

  async getMr(projectId: string, prNumber: number): Promise<MrInfo> {
    const r = await this.session.request(
      `${this.base}/projects/${this.enc(projectId)}/merge_requests/${prNumber}`,
      { headers: this.headers },
    );
    if (!r.ok) throw new Error(`gitlab get_mr ${r.status}`);
    const d = (await r.json()) as any;
    return {
      sourceProjectId: Number.isSafeInteger(d.source_project_id)
        ? String(d.source_project_id)
        : undefined,
      sourceBranch: d.source_branch,
      targetBranch: d.target_branch,
      headSha: d.sha ?? d.diff_refs?.head_sha ?? "",
      changedFiles: /^\d+\+?$/.test(d.changes_count ?? "")
        ? Number(String(d.changes_count).replace(/\+$/, ""))
        : undefined,
      diffRefs: d.diff_refs,
    };
  }

  async getDiffs(projectId: string, prNumber: number): Promise<FileDiff[]> {
    const items = await readDiffPages(async (page) => {
      const r = await this.session.request(
        `${this.base}/projects/${this.enc(projectId)}/merge_requests/${prNumber}/diffs?per_page=100&page=${page}`,
        { headers: this.headers },
      );
      if (!r.ok) throw new Error(`gitlab get_diffs ${r.status}`);
      const files = (await r.json()) as any[];
      const nextPage = r.headers.get("x-next-page");
      const more = nextPage ? Number(nextPage) > page : files.length === 100;
      return { files, more };
    });
    return items.map((d) => ({
      newPath: d.new_path,
      oldPath: d.old_path,
      diff: d.collapsed || d.too_large ? "" : (d.diff ?? ""),
      newFile: !!d.new_file,
      deletedFile: !!d.deleted_file,
    }));
  }

  async getFile(projectId: string, path: string, ref: string): Promise<string | null> {
    const r = await this.session.request(
      `${this.base}/projects/${this.enc(projectId)}/repository/files/${encodeURIComponent(path)}/raw?ref=${encodeURIComponent(ref)}`,
      { headers: this.headers },
    );
    return r.ok ? r.text() : null;
  }

  async searchBlobs(projectId: string, query: string, ref: string) {
    const r = await this.session.request(
      `${this.base}/projects/${this.enc(projectId)}/search?scope=blobs&search=${encodeURIComponent(query)}&ref=${encodeURIComponent(ref)}&per_page=20`,
      { headers: this.headers },
    );
    if (!r.ok) return [];
    return ((await r.json()) as any[]).map((h) => ({ path: h.path }));
  }

  async createNote(projectId: string, prNumber: number, body: string) {
    const r = await this.session.request(
      `${this.base}/projects/${this.enc(projectId)}/merge_requests/${prNumber}/notes`,
      {
        method: "POST",
        headers: { ...this.headers, "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      },
    );
    if (!r.ok) throw new Error(`gitlab create_note ${r.status}`);
    return ((await r.json()) as any).id as number;
  }

  async editNote(projectId: string, prNumber: number, noteId: number | string, body: string) {
    const r = await this.session.request(
      `${this.base}/projects/${this.enc(projectId)}/merge_requests/${prNumber}/notes/${noteId}`,
      {
        method: "PUT",
        headers: { ...this.headers, "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      },
    );
    if (!r.ok) throw new Error(`gitlab edit_note ${r.status}`);
  }

  async listNotes(projectId: string, prNumber: number): Promise<Note[]> {
    const actor = await this.session.actorId();
    const notes = await this.session.pages(
      `${this.base}/projects/${this.enc(projectId)}/merge_requests/${prNumber}/notes`,
    );
    return notes
      .filter((n) => n.author?.id === actor)
      .map((n) => ({ id: n.id ?? null, body: n.body ?? "" }));
  }

  async postStatus(projectId: string, prNumber: number, body: string) {
    const full = `${STATUS_MARKER}\n${body}`;
    for (const note of await this.listNotes(projectId, prNumber)) {
      if (note.body.split("\n", 1)[0] === STATUS_MARKER && note.id != null) {
        await this.editNote(projectId, prNumber, note.id, full);
        return note.id;
      }
    }
    return this.createNote(projectId, prNumber, full);
  }

  async postInlineNote(
    projectId: string,
    prNumber: number,
    filePath: string,
    newLine: number,
    body: string,
    refs: DiffRefs,
    oldPath = filePath,
  ): Promise<boolean> {
    const params = new URLSearchParams({
      body,
      "position[position_type]": "text",
      "position[base_sha]": refs.base_sha,
      "position[start_sha]": refs.start_sha,
      "position[head_sha]": refs.head_sha,
      "position[new_path]": filePath,
      "position[old_path]": oldPath,
      "position[new_line]": String(newLine),
    });
    const r = await this.session.request(
      `${this.base}/projects/${this.enc(projectId)}/merge_requests/${prNumber}/discussions`,
      {
        method: "POST",
        headers: { ...this.headers, "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString(),
      },
    );
    if (!r.ok && r.status !== 422 && r.status !== 400)
      throw Error("Inline publication failed (HTTP " + r.status + ").");
    return r.ok;
  }

  async addLabels(projectId: string, prNumber: number, labels: string[]) {
    const response = await this.session.request(
      `${this.base}/projects/${this.enc(projectId)}/merge_requests/${prNumber}`,
      {
        method: "PUT",
        headers: { ...this.headers, "Content-Type": "application/json" },
        body: JSON.stringify({ add_labels: labels.join(",") }),
      },
    );
    if (!response.ok) throw Error("Could not update labels (HTTP " + response.status + ").");
  }

  async removeLabels(projectId: string, prNumber: number, labels: string[]) {
    const response = await this.session.request(
      `${this.base}/projects/${this.enc(projectId)}/merge_requests/${prNumber}`,
      {
        method: "PUT",
        headers: { ...this.headers, "Content-Type": "application/json" },
        body: JSON.stringify({ remove_labels: labels.join(",") }),
      },
    );
    if (!response.ok) throw Error("Could not update labels (HTTP " + response.status + ").");
  }

  async submitReview() {
    return false; // GitLab has no formal review object; poster falls back to sticky note
  }

  async listOpenPrs(projectId: string) {
    const r = await this.session.request(
      `${this.base}/projects/${this.enc(projectId)}/merge_requests?state=opened&per_page=100`,
      { headers: this.headers },
    );
    if (!r.ok) return [];
    return ((await r.json()) as any[])
      .filter((mr) => mr && (mr.state === "opened" || !mr.state))
      .map((mr) => ({ iid: mr.iid, headSha: mr.sha ?? "" }));
  }
}

// ---- GitHub (REST fallback) ------------------------------------------------------

export class GitHubRestClient implements ForgeClient {
  private base = process.env.GITHUB_URL ?? "https://api.github.com";
  private headers: Record<string, string>;

  readonly session: ForgeSession;
  set beforeWrite(guard: () => Promise<void>) {
    this.session.beforeWrite = guard;
  }

  constructor(token = resolveToken("github")) {
    this.headers = {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    this.session = new ForgeSession(this.base, this.headers, true);
  }

  async close() {}

  async getMr(projectId: string, prNumber: number): Promise<MrInfo> {
    const r = await this.session.request(`${this.base}/repos/${projectId}/pulls/${prNumber}`, {
      headers: this.headers,
    });
    if (!r.ok) throw new Error(`github get_mr ${r.status}`);
    const d = (await r.json()) as any;
    return {
      sourceProjectId: d.head.repo?.full_name,
      sourceBranch: d.head.ref,
      targetBranch: d.base.ref,
      headSha: d.head.sha,
      changedFiles: typeof d.changed_files === "number" ? d.changed_files : undefined,
      diffRefs: { head_sha: d.head.sha, base_sha: d.base.sha, start_sha: d.base.sha },
    };
  }

  async getDiffs(projectId: string, prNumber: number): Promise<FileDiff[]> {
    const items = await readDiffPages(async (page) => {
      const r = await this.session.request(
        `${this.base}/repos/${projectId}/pulls/${prNumber}/files?per_page=100&page=${page}`,
        {
          headers: this.headers,
        },
      );
      if (!r.ok) throw new Error(`github get_diffs ${r.status}`);
      const files = (await r.json()) as any[];
      return { files, more: /rel="next"/.test(r.headers.get("link") ?? "") };
    });
    return items.map((f) => ({
      newPath: f.filename,
      oldPath: f.previous_filename ?? f.filename,
      diff: f.patch ?? "",
      newFile: f.status === "added",
      deletedFile: f.status === "removed",
    }));
  }

  async getFile(projectId: string, path: string, ref: string): Promise<string | null> {
    const segments = path.split("/");
    if (segments.some((part) => !part || part === "." || part === "..")) return null;
    const encoded = segments.map(encodeURIComponent).join("/");
    const r = await this.session.request(
      `${this.base}/repos/${projectId}/contents/${encoded}?ref=${encodeURIComponent(ref)}`,
      { headers: { ...this.headers, Accept: "application/vnd.github.raw" } },
    );
    return r.ok ? r.text() : null;
  }

  async searchBlobs(projectId: string, query: string) {
    const r = await this.session.request(
      `${this.base}/search/code?q=${encodeURIComponent(`${query} repo:${projectId}`)}`,
      { headers: this.headers },
    );
    if (!r.ok) return [];
    const data = (await r.json()) as any;
    return (data.items ?? []).map((i: any) => ({ path: i.path }));
  }

  async createNote(projectId: string, prNumber: number, body: string) {
    const r = await this.session.request(
      `${this.base}/repos/${projectId}/issues/${prNumber}/comments`,
      {
        method: "POST",
        headers: { ...this.headers, "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      },
    );
    if (!r.ok) throw new Error(`github create_note ${r.status}`);
    return ((await r.json()) as any).id as number;
  }

  async editNote(projectId: string, prNumber: number, noteId: number | string, body: string) {
    const r = await this.session.request(
      `${this.base}/repos/${projectId}/issues/comments/${noteId}`,
      {
        method: "PATCH",
        headers: { ...this.headers, "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      },
    );
    if (!r.ok) throw new Error(`github edit_note ${r.status}`);
  }

  async listNotes(projectId: string, prNumber: number): Promise<Note[]> {
    const actor = await this.session.actorId();
    const root = this.base + "/repos/" + projectId;
    const [issues, inline] = await Promise.all([
      this.session.pages(root + "/issues/" + prNumber + "/comments"),
      this.session.pages(root + "/pulls/" + prNumber + "/comments"),
    ]);
    // Inline IDs belong to a different endpoint and cannot be edited as issue comments.
    return [
      ...issues
        .filter((c) => c.user?.id === actor)
        .map((c) => ({ id: c.id ?? null, body: c.body ?? "" })),
      ...inline.filter((c) => c.user?.id === actor).map((c) => ({ id: null, body: c.body ?? "" })),
    ];
  }

  async ownedReviews(projectId: string, prNumber: number) {
    const actor = await this.session.actorId();
    return (
      await this.session.pages(
        this.base + "/repos/" + projectId + "/pulls/" + prNumber + "/reviews",
      )
    ).filter((r) => r.user?.id === actor);
  }

  async draftComments(projectId: string, prNumber: number, reviewId: number) {
    return this.session.pages(
      this.base +
        "/repos/" +
        projectId +
        "/pulls/" +
        prNumber +
        "/reviews/" +
        reviewId +
        "/comments",
    );
  }

  async postStatus(projectId: string, prNumber: number, body: string) {
    const full = `${STATUS_MARKER}\n${body}`;
    for (const note of await this.listNotes(projectId, prNumber)) {
      if (note.body.split("\n", 1)[0] === STATUS_MARKER && note.id != null) {
        await this.editNote(projectId, prNumber, note.id, full);
        return note.id;
      }
    }
    return this.createNote(projectId, prNumber, full);
  }

  async postInlineNote(
    projectId: string,
    prNumber: number,
    filePath: string,
    newLine: number,
    body: string,
    refs: DiffRefs,
  ): Promise<boolean> {
    const r = await this.session.request(
      `${this.base}/repos/${projectId}/pulls/${prNumber}/comments`,
      {
        method: "POST",
        headers: { ...this.headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          body,
          commit_id: refs.head_sha,
          path: filePath,
          line: newLine,
          side: "RIGHT",
        }),
      },
    );
    if (!r.ok && r.status !== 422 && r.status !== 400)
      throw Error("Inline publication failed (HTTP " + r.status + ").");
    return r.ok;
  }

  async addLabels(projectId: string, prNumber: number, labels: string[]) {
    const response = await this.session.request(
      `${this.base}/repos/${projectId}/issues/${prNumber}/labels`,
      {
        method: "POST",
        headers: { ...this.headers, "Content-Type": "application/json" },
        body: JSON.stringify({ labels }),
      },
    );
    if (!response.ok) throw Error("Could not add labels (HTTP " + response.status + ").");
  }

  async removeLabels(projectId: string, prNumber: number, labels: string[]) {
    // 404 per label (not present) is fine — removal is best-effort
    for (const l of labels) {
      const r = await this.session.request(
        `${this.base}/repos/${projectId}/issues/${prNumber}/labels/${encodeURIComponent(l)}`,
        { method: "DELETE", headers: this.headers },
      );
      if (!r.ok && r.status !== 404)
        throw Error("Could not remove a label (HTTP " + r.status + ").");
    }
  }

  async submitReview(
    projectId: string,
    prNumber: number,
    body: string,
    refs: DiffRefs,
  ): Promise<boolean> {
    const full = `${REVIEW_MARKER}\n${body}`;
    for (const rv of await this.ownedReviews(projectId, prNumber)) {
      if (
        typeof rv.id === "number" &&
        rv.commit_id === refs.head_sha &&
        rv.state !== "PENDING" &&
        rv.body?.split("\n", 1)[0] === REVIEW_MARKER
      ) {
        const upd = await this.session.request(
          `${this.base}/repos/${projectId}/pulls/${prNumber}/reviews/${rv.id}`,
          {
            method: "PUT",
            headers: { ...this.headers, "Content-Type": "application/json" },
            body: JSON.stringify({ body: full }),
          },
        );
        if (!upd.ok) throw Error("Could not update the existing review (HTTP " + upd.status + ").");
        return true;
      }
    }
    const r = await this.session.request(
      `${this.base}/repos/${projectId}/pulls/${prNumber}/reviews`,
      {
        method: "POST",
        headers: { ...this.headers, "Content-Type": "application/json" },
        body: JSON.stringify({ body: full, event: "COMMENT", commit_id: refs.head_sha }),
      },
    );
    if (!r.ok) throw Error("Could not submit the review (HTTP " + r.status + ").");
    return true;
  }

  async listOpenPrs(projectId: string) {
    const r = await this.session.request(
      `${this.base}/repos/${projectId}/pulls?state=open&per_page=100`,
      {
        headers: this.headers,
      },
    );
    if (!r.ok) return [];
    return ((await r.json()) as any[])
      .filter((pr) => pr && (pr.state === "open" || !pr.state))
      .map((pr) => ({ iid: pr.number, headSha: pr.head?.sha ?? "" }));
  }
}

// ---- factory ---------------------------------------------------------------------

export async function getForgeClient(forge: string): Promise<ForgeClient> {
  if (forge === "github") {
    // oauth tokens may have expired — refresh before either client reads it.
    const { ensureFreshGithubToken } = await import("./githubAuth.js");
    await ensureFreshGithubToken();
    if (resolveToken("github") && (process.env.GITHUB_BACKEND ?? "mcp").toLowerCase() !== "rest") {
      const { GitHubMcpClient } = await import("./forgeMcp.js");
      return new GitHubMcpClient();
    }
    return new GitHubRestClient();
  }
  if (forge === "gitlab") return new GitLabClient();
  throw new Error(`Unknown or unsupported forge: ${forge} (bitbucket lands in v2.1)`);
}

/** REST client regardless of GITHUB_BACKEND — push reviews need file reads
 * alongside the commit APIs (forgeCommits.ts), which MCP doesn't expose. */
export async function getRestForgeClient(forge: string): Promise<ForgeClient> {
  if (forge === "github") {
    const { ensureFreshGithubToken } = await import("./githubAuth.js");
    await ensureFreshGithubToken();
    return new GitHubRestClient();
  }
  if (forge === "gitlab") return new GitLabClient();
  throw new Error(`Unknown or unsupported forge: ${forge}`);
}
