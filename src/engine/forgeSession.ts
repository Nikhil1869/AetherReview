import { forgeRequest } from "./publicationAudit.js";

interface ForgeArtifact {
  id?: number;
  user?: { id: number };
  author?: { id: number };
  body?: string;
  note?: string;
  state?: string;
  commit_id?: string;
  path?: string;
  line?: number;
}

/** Authenticated REST reads shared by note, review and commit-comment ownership checks. */
export class ForgeSession {
  beforeWrite?: () => Promise<void>;
  private identity?: Promise<number>;

  constructor(
    private readonly base: string,
    private readonly headers: Record<string, string>,
    private readonly github: boolean,
  ) {}

  async request(url: string, init: RequestInit = {}) {
    if (init.method && init.method !== "GET") await this.beforeWrite?.();
    return forgeRequest(url, {
      ...init,
      headers: { ...this.headers, ...init.headers },
      redirect: "error",
      signal: AbortSignal.timeout(30000),
    });
  }

  actorId() {
    return (this.identity ??= this.readIdentity());
  }

  private async readIdentity(): Promise<number> {
    const user = await this.request(this.base + "/user");
    let id: unknown;
    if (user.ok) id = (await user.json()).id;
    else if (this.github && user.status === 403) {
      // An installation token has a GraphQL viewer but cannot use GET /user.
      const response = await fetch(this.base + "/graphql", {
        method: "POST",
        headers: { ...this.headers, "Content-Type": "application/json" },
        body: JSON.stringify({ query: "query { viewer { databaseId } }" }),
        redirect: "error",
        signal: AbortSignal.timeout(30000),
      });
      if (response.ok) id = (await response.json()).data?.viewer?.databaseId;
    }
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0)
      throw Error("Could not verify the authenticated forge identity.");
    return id;
  }

  async pages(url: string): Promise<ForgeArtifact[]> {
    const rows: ForgeArtifact[] = [];
    for (let page = 1; page <= 100; page++) {
      const response = await this.request(url + "?per_page=100&page=" + page);
      if (!response.ok)
        throw Error("Could not verify existing forge artifacts (HTTP " + response.status + ").");
      const items: unknown = await response.json();
      if (!Array.isArray(items)) throw Error("Invalid forge artifact listing.");
      rows.push(...items);
      if (
        !response.headers.get("x-next-page") &&
        !/rel="next"/.test(response.headers.get("link") ?? "") &&
        items.length < 100
      )
        return rows;
    }
    throw Error("Forge artifact listing exceeded the pagination limit.");
  }
}
