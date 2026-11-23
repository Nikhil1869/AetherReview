import { URL } from "node:url";
import process from "node:process";
import { writeFileSync } from "node:fs";
// The synthetic-only harness records locations before validation to count rejected anchors.
const fetchRequest = globalThis.fetch;
globalThis.fetch = async (...args) => {
  const response = await fetchRequest(...args);
  if (response.ok && new URL(response.url).pathname.endsWith("/chat/completions")) {
    const data = await response.clone().json();
    const text = data.choices?.[0]?.message?.content ?? "";
    try {
      const { findings } = JSON.parse(
        text.replace(/^\s*\x60\x60\x60(?:json)?|\x60\x60\x60\s*$/g, ""),
      );
      if (Array.isArray(findings))
        writeFileSync(process.env.AETHER_EVAL_CAPTURE, JSON.stringify(findings));
    } catch {
      /* The engine reports malformed output. */
    }
  }
  return response;
};
