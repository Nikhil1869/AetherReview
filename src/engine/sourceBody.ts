export const MAX_SOURCE_BYTES = 256 * 1024;

export async function readPolicy(
  response: Response,
  verifyBase: () => Promise<Response>,
): Promise<string | null> {
  if (response.status === 404) {
    await response.body?.cancel();
    const base = await verifyBase();
    await base.body?.cancel();
    if (!base.ok) throw Error("Cannot verify access to the base revision.");
    return null;
  }
  const content = await readSourceBody(response);
  if (content === null)
    throw Error("Could not verify base revision policy (HTTP " + response.status + ").");
  return content;
}

/** Limit the decoded HTTP stream, including compressed and chunked responses. */
export async function readSourceBody(response: Response): Promise<string | null> {
  if (!response.ok) {
    await response.body?.cancel();
    return null;
  }
  return readBoundedText(response, MAX_SOURCE_BYTES);
}

export async function readBoundedText(response: Response, limit: number): Promise<string | null> {
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel();
    return null;
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0,
    text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}
