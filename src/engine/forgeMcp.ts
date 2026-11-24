/** GitHub via the official remote MCP server. Inline findings accumulate on a
 * pending review; submitReview publishes them with the summary as ONE native
 * GitHub review. No comment-edit tool exists on this server, so the sticky
 * status note ("reviewing… " → "complete") goes through a REST companion
 * client with the same token — notes/status are REST, the review flow is MCP. */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { resolveToken } from "./config.js";
import { auditMutation } from "./publicationAudit.js";
import { safeSourcePath } from "./sourcePath.js";
import { MAX_SOURCE_BYTES } from "./sourceBody.js";
import {
  GitHubRestClient,
  readDiffPages,
  REVIEW_MARKER,
  type ForgeClient,
  type Note,
} from "./forge.js";
import type { DiffRefs, FileDiff, MrInfo } from "./types.js";

const MCP_URL = "https://api.githubcopilot.com/mcp/";

export class GitHubMcpClient implements ForgeClient {
  constructor(private readonly readOnly = false) {}

  private readonly token = resolveToken("github");
  private client: Client | null = null;
  private drafts = new Map<string, number>();
  private guard?: () => Promise<void>;
  set beforeWrite(check: () => Promise<void>) {
    this.guard = check;
    this.rest().beforeWrite = check;
  }
  private restCompanion: GitHubRestClient | null = null;

  /** REST with the same token — covers what the MCP server can't (comment edits)
   * and unifies note listing (issue + review comments) for marker dedup. */
  private rest(): GitHubRestClient {
    return (this.restCompanion ??= new GitHubRestClient(this.token));
  }

  private async ensure(): Promise<Client> {
    if (this.client) return this.client;
    const token = this.token;
    if (!token)
      throw new Error("GitHub not connected. Run: aetherreview (setup) or set GITHUB_TOKEN");
    const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
      requestInit: {
        redirect: "error",
        headers: {
          Authorization: `Bearer ${token}`,
          ...(this.readOnly ? { "X-MCP-Readonly": "true" } : {}),
        },
      },
    });
    const client = new Client({ name: "aether-review", version: "2.1.0" });
    await client.connect(transport);
    this.client = client;
    return client;
  }

  async close() {
    await this.client?.close().catch(() => {});
    this.client = null;
  }

  private split(projectId: string): { owner: string; repo: string } {
    const [owner, repo] = projectId.split("/");
    if (!owner || !repo) throw new Error(`GitHub projectId must be owner/repo, got ${projectId}`);
    return { owner, repo };
  }

  private async call(
    tool: string,
    args: Record<string, unknown>,
    opts?: { soft?: boolean },
  ): Promise<any> {
    const client = await this.ensure();
    const mutation = [
      "pull_request_review_write",
      "add_comment_to_pending_review",
      "add_issue_comment",
    ].includes(tool);
    if (mutation) await this.guard?.();
    const send = () => client.callTool({ name: tool, arguments: args });
    const res = mutation
      ? await auditMutation(tool, String(args.method ?? tool), send, (r) => !r.isError)
      : await send();
    const text = ((res.content as any[]) ?? [])
      .map((c) => (typeof c?.text === "string" ? c.text : ""))
      .join("");
    if (res.isError) {
      if (opts?.soft) return null;
      throw new Error(`MCP ${tool} failed`);
    }
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  async getMr(projectId: string, prNumber: number): Promise<MrInfo> {
    const { owner, repo } = this.split(projectId);
    const d = await this.call("pull_request_read", {
      method: "get",
      owner,
      repo,
      pullNumber: prNumber,
    });
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
    const { owner, repo } = this.split(projectId);
    const perPage = 30;
    const items = await readDiffPages(async (page) => {
      const d = await this.call("pull_request_read", {
        method: "get_files",
        owner,
        repo,
        pullNumber: prNumber,
        perPage,
        page,
      });
      const files: any[] | undefined = Array.isArray(d) ? d : d?.files;
      if (!Array.isArray(files)) throw new Error("MCP get_files returned an unexpected shape");
      return { files, more: files.length === perPage };
    });
    return items.map((f) => ({
      newPath: f.filename ?? "",
      oldPath: f.previous_filename ?? f.filename ?? "",
      diff: f.patch ?? "",
      newFile: f.status === "added",
      deletedFile: f.status === "removed",
    }));
  }

  async getFile(projectId: string, path: string, ref: string): Promise<string | null> {
    if (!safeSourcePath(path)) return null;
    const { owner, repo } = this.split(projectId);
    const client = await this.ensure();
    const res = await client.callTool({
      name: "get_file_contents",
      arguments: { owner, repo, path, sha: ref },
    });
    if (res.isError) return null;
    // File body arrives as an EmbeddedResource; TextContent is just a status line.
    for (const item of (res.content as any[]) ?? []) {
      const text = item?.resource?.text;
      if (typeof text === "string" && Buffer.byteLength(text) <= MAX_SOURCE_BYTES) return text;
    }
    return null;
  }

  async searchBlobs(projectId: string, query: string): Promise<{ path: string }[]> {
    const d = await this.call(
      "search_code",
      { query: `${query} repo:${projectId}`, perPage: 20 },
      { soft: true },
    );
    return (d?.items ?? []).filter((i: any) => i?.path).map((i: any) => ({ path: i.path }));
  }

  async listNotes(projectId: string, prNumber: number): Promise<Note[]> {
    // REST sees both issue comments and submitted review comments — the MCP
    // tools miss some, which let already-posted findings repost (broken dedup).
    return this.rest().listNotes(projectId, prNumber);
  }

  async createNote(projectId: string, prNumber: number, body: string) {
    const { owner, repo } = this.split(projectId);
    const d = await this.call("add_issue_comment", { owner, repo, issue_number: prNumber, body });
    return d?.id ?? 0;
  }

  async editNote(projectId: string, prNumber: number, noteId: number | string, body: string) {
    return this.rest().editNote(projectId, prNumber, noteId, body);
  }

  async postStatus(projectId: string, prNumber: number, body: string) {
    // visible progress in the PR conversation; finalize edits it on completion
    return this.rest().postStatus(projectId, prNumber, body);
  }

  private async draft(projectId: string, prNumber: number, head: string, justCreated = false) {
    const rest = this.rest();
    const reviews = await rest.ownedReviews(projectId, prNumber);
    const pending = reviews.filter((r) => r.state === "PENDING");
    const key = projectId + "#" + prNumber;
    const known = this.drafts.get(key);
    if (!pending.length && !known && !justCreated) return { id: null, comments: [], reviews };
    const [draft] = pending;
    if (
      pending.length !== 1 ||
      typeof draft.id !== "number" ||
      !Number.isSafeInteger(draft.id) ||
      draft.commit_id !== head ||
      (known && known !== draft.id) ||
      (draft.body && draft.body !== REVIEW_MARKER)
    ) {
      throw Error(
        "The pending review changed or belongs to another revision. Publication stopped.",
      );
    }
    const comments = await rest.draftComments(projectId, prNumber, draft.id);
    const actor = await rest.session.actorId();
    if (
      (!comments.length && !justCreated && !known && draft.body !== REVIEW_MARKER) ||
      comments.some(
        (c) =>
          c.user?.id !== actor ||
          c.commit_id !== head ||
          typeof c.body !== "string" ||
          c.body.split("\n", 1)[0] !== "<!-- ct:f:" + c.path + ":" + c.line + " -->",
      )
    )
      throw Error("The pending review contains an unrecognized draft. Publication stopped.");
    this.drafts.set(key, draft.id);
    return { id: draft.id, comments, reviews };
  }

  async postInlineNote(
    projectId: string,
    prNumber: number,
    filePath: string,
    newLine: number,
    body: string,
    refs: DiffRefs,
  ) {
    const args = { ...this.split(projectId), pullNumber: prNumber };
    let pending = await this.draft(projectId, prNumber, refs.head_sha);
    if (pending.id == null) {
      await this.call("pull_request_review_write", {
        ...args,
        method: "create",
        commitID: refs.head_sha,
      });
      pending = await this.draft(projectId, prNumber, refs.head_sha, true);
    }
    if (
      pending.comments.some(
        (c) => c.path === filePath && typeof c.line === "number" && Math.abs(c.line - newLine) <= 3,
      )
    )
      return true;
    await this.call("add_comment_to_pending_review", {
      ...args,
      path: filePath,
      line: newLine,
      side: "RIGHT",
      subjectType: "LINE",
      body,
    });
    return true;
  }

  async needsSummaryRecovery(projectId: string, prNumber: number, refs: DiffRefs) {
    return this.rest().needsSummaryRecovery(projectId, prNumber, refs);
  }

  async submitReview(projectId: string, prNumber: number, body: string, refs: DiffRefs) {
    const { id, reviews } = await this.draft(projectId, prNumber, refs.head_sha);
    const args = {
      ...this.split(projectId),
      pullNumber: prNumber,
      event: "COMMENT",
      body: REVIEW_MARKER + "\n" + body,
    };
    if (id != null) {
      await this.call("pull_request_review_write", { ...args, method: "submit_pending" });
      this.drafts.delete(projectId + "#" + prNumber);
    } else if (
      !reviews.some(
        (r) => r.commit_id === refs.head_sha && r.body?.split("\n", 1)[0] === REVIEW_MARKER,
      )
    ) {
      await this.call("pull_request_review_write", {
        ...args,
        method: "create",
        commitID: refs.head_sha,
      });
    }
    return true;
  }

  async addLabels(projectId: string, prNumber: number, labels: string[]) {
    return this.rest().addLabels(projectId, prNumber, labels);
  }

  async removeLabels(projectId: string, prNumber: number, labels: string[]) {
    return this.rest().removeLabels(projectId, prNumber, labels);
  }

  async listOpenPrs(projectId: string) {
    const { owner, repo } = this.split(projectId);
    const d = await this.call(
      "list_pull_requests",
      {
        owner,
        repo,
        state: "open",
        perPage: 100,
      },
      { soft: true },
    );
    const items: any[] = Array.isArray(d) ? d : (d?.pull_requests ?? []);
    return items
      .filter((pr) => pr?.number && (pr?.state === "open" || !pr?.state))
      .map((pr) => ({ iid: pr.number, headSha: pr.head?.sha ?? "" }));
  }
}
