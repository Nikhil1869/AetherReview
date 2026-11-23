/** Parse a pasted PR/MR link into a reviewable target. Accepts:
 *  https://github.com/owner/repo/pull/123
 *  https://gitlab.com/group/sub/proj/-/merge_requests/45  (any GitLab host)
 *  owner/repo#123  (GitHub shorthand)
 */

import type { Forge } from "./types.js";

export interface PrRef {
  forge: Forge;
  projectId: string;
  prNumber: number;
  label: string;
}

export function validProjectId(forge: "github" | "gitlab", projectId: string): boolean {
  const segments = projectId.split("/");
  if (!segments.every((part) => /^[\w.-]+$/.test(part) && part !== "." && part !== ".."))
    return false;
  return forge === "github"
    ? segments.length === 2
    : segments.length >= 2 || /^\d+$/.test(projectId);
}

function ref(forge: "github" | "gitlab", projectId: string, number: string): PrRef | null {
  const prNumber = Number(number);
  if (!validProjectId(forge, projectId) || !Number.isSafeInteger(prNumber) || prNumber < 1)
    return null;
  return {
    forge,
    projectId,
    prNumber,
    label: `${projectId}${forge === "github" ? "#" : "!"}${number}`,
  };
}

export function parsePrLink(input: string): PrRef | null {
  const raw = input.trim();
  const short = raw.match(/^([\w.-]+\/[\w.-]+)#(\d+)$/);
  if (short) return ref("github", short[1], short[2]);

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) return null;
  if (url.hostname === "github.com") {
    const gh = /^\/([^/]+\/[^/]+)\/pull\/(\d+)(?:\/|$)/.exec(url.pathname);
    return gh ? ref("github", gh[1], gh[2]) : null;
  }
  const gl = /^\/(.+)\/-\/merge_requests\/(\d+)(?:\/|$)/.exec(url.pathname);
  if (gl) return ref("gitlab", gl[1], gl[2]);

  return null;
}
