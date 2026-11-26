import { join } from "node:path";

import { PublicationLocks } from "./publicationLock.js";
import { HOME } from "./config.js";

const seenEvents = new Map<string, number>();
const latestCommit = new Map<string, string>();
const locks = new PublicationLocks(join(HOME, "locks"));

const EVENT_TTL_MS = 60 * 60 * 1000;

// ref: a PR number, or a `branch:<name>` string for push reviews
const key = (projectId: string, ref: number | string) => `${projectId}#${ref}`;

export function seenEvent(uuid: string | null | undefined): boolean {
  if (!uuid) return false;
  const now = Date.now();
  for (const [k, t] of seenEvents) if (now - t > EVENT_TTL_MS) seenEvents.delete(k);
  if (seenEvents.has(uuid)) return true;
  seenEvents.set(uuid, now);
  return false;
}

export function recordLatest(
  projectId: string,
  prNumber: number | string,
  headSha: string | null,
): void {
  if (headSha) latestCommit.set(key(projectId, prNumber), headSha);
}

export function isLatest(
  projectId: string,
  prNumber: number | string,
  headSha: string | null,
): boolean {
  if (!headSha) return true;
  const latest = latestCommit.get(key(projectId, prNumber));
  return latest == null || latest === headSha;
}

export function acquireLock(projectId: string, prNumber: number | string): boolean {
  return locks.acquire(key(projectId, prNumber));
}

export function releaseLock(projectId: string, prNumber: number | string): void {
  locks.release(key(projectId, prNumber));
}
