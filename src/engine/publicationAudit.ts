import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { HOME } from "./config.js";
import type { Forge } from "./types.js";

const scope = new AsyncLocalStorage<{ run: string; target: string; forge: Forge }>();
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

export function withPublicationAudit<T>(
  forge: Forge,
  project: string,
  ref: string | number,
  sha: string,
  publish: () => Promise<T>,
): Promise<T> {
  return scope.run(
    { run: randomUUID(), forge, target: digest(JSON.stringify([forge, project, ref, sha])) },
    publish,
  );
}

/** Pair each outgoing mutation with its reply. A missing reply is ambiguous. */
export async function auditMutation<T>(
  operation: string,
  destination: string,
  send: () => Promise<T>,
  status: (result: T) => number | boolean,
): Promise<T> {
  const run = scope.getStore();
  if (!run) return send();
  const id = randomUUID();
  const record = (phase: string, result?: number | boolean) => {
    mkdirSync(HOME, { recursive: true, mode: 0o700 });
    const event = {
      ...run,
      id,
      at: new Date().toISOString(),
      operation,
      destination: digest(destination),
      phase,
      result,
    };
    appendFileSync(join(HOME, "publication.jsonl"), JSON.stringify(event) + "\n", { mode: 0o600 });
  };
  record("attempt");
  let response: T;
  try {
    response = await send();
  } catch (error) {
    record("unknown");
    throw error;
  }
  record("reply", status(response));
  return response;
}

export function forgeRequest(url: string, init: RequestInit): Promise<Response> {
  const method = init.method ?? "GET";
  const send = () => fetch(url, init);
  return method === "GET" ? send() : auditMutation(method, url, send, (r) => r.status);
}
