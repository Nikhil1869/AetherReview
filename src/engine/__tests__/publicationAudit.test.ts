import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { HOME } from "../config.js";
import { auditMutation, withPublicationAudit } from "../publicationAudit.js";

it("pairs concurrent runs with replies and records uncertain delivery without logging payloads", async () => {
  const call = async (ok: boolean) =>
    withPublicationAudit("github", "private/project", 7, "private-sha", () =>
      auditMutation(
        "POST",
        "private-url",
        async () => {
          if (!ok) throw Error("private-message");
          return 201;
        },
        (s) => s,
      ),
    );
  await Promise.allSettled([call(true), call(false)]);
  const raw = readFileSync(join(HOME, "publication.jsonl"), "utf8");
  expect(raw).not.toContain("private");
  const events = raw
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  expect(events).toHaveLength(4);
  expect(new Set(events.map((e) => e.run)).size).toBe(2);
  expect(events.map((e) => e.phase).sort()).toEqual(["attempt", "attempt", "reply", "unknown"]);
  for (const event of events.filter((e) => e.phase === "attempt")) {
    expect(events.filter((e) => e.id === event.id && e.run === event.run)).toHaveLength(2);
  }
});
