/** Stubs globalThis.fetch with a route handler. Each test supplies a function
 * mapping (url, init) → a response spec; we build a minimal Response-like object
 * with the .ok/.status/.json()/.text() the engine actually uses. */
import { vi } from "vitest";

export interface FakeResponseSpec {
  ok?: boolean; // defaults to status < 400
  status?: number; // defaults 200
  json?: unknown;
  text?: string;
  headers?: HeadersInit;
}

export type FetchHandler = (url: string, init?: RequestInit) => FakeResponseSpec;

export function installFetch(handler: FetchHandler) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = vi.fn(async (input: any, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input);
    calls.push({ url, init });
    const spec = handler(url, init);
    const status = spec.status ?? 200;
    return {
      ok: spec.ok ?? status < 400,
      status,
      headers: new Headers(spec.headers),
      body: new Response(spec.text ?? (spec.json != null ? JSON.stringify(spec.json) : "")).body,
      json: async () => spec.json ?? {},
      text: async () => spec.text ?? (spec.json != null ? JSON.stringify(spec.json) : ""),
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", fn);
  return { fn, calls };
}
