import { expect, it } from "vitest";
import { readSourceBody, MAX_SOURCE_BYTES } from "../sourceBody.js";

it("counts bytes across chunks and cancels before consuming an oversized source", async () => {
  let cancelled = false;
  const response = new Response(
    new ReadableStream({
      pull(c) {
        c.enqueue(new Uint8Array(MAX_SOURCE_BYTES / 2));
      },
      cancel() {
        cancelled = true;
      },
    }),
  );
  expect(await readSourceBody(response)).toBeNull();
  expect(cancelled).toBe(true);
});
it("decodes a multibyte character split across chunks", async () => {
  const bytes = new TextEncoder().encode("π");
  const response = new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(bytes.slice(0, 1));
        c.enqueue(bytes.slice(1));
        c.close();
      },
    }),
  );
  expect(await readSourceBody(response)).toBe("π");
});
