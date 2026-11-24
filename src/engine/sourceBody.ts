export const MAX_SOURCE_BYTES = 256 * 1024;

/** Limit the decoded HTTP stream, including compressed and chunked responses. */
export async function readSourceBody(response: Response): Promise<string | null> {
  if (!response.ok || Number(response.headers.get("content-length")) > MAX_SOURCE_BYTES) {
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
      if (size > MAX_SOURCE_BYTES) {
        await reader.cancel();
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}
