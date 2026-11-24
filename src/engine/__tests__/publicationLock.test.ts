import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { HOME, resetAll } from "../config.js";
import { PublicationLocks } from "../publicationLock.js";

it("keeps live owners through reset and long reviews", () => {
  const root = join(HOME, "locks");
  const owner = new PublicationLocks(root);
  const competitor = new PublicationLocks(root);
  expect(owner.acquire("r#1")).toBe(true);
  resetAll();
  competitor.release("r#1");
  expect(competitor.acquire("r#1")).toBe(false);
  owner.release("r#1");
  expect(competitor.acquire("r#1")).toBe(true);
  competitor.release("r#1");
});

it("excludes other Node processes and recovers after the holder exits without releasing", async () => {
  const root = mkdtempSync(join(tmpdir(), "aether-lock-"));
  const module = new URL("../publicationLock.ts", import.meta.url).href;
  const worker = spawn(process.execPath, [
    "--experimental-strip-types",
    "--input-type=module",
    "-e",
    "import {PublicationLocks} from " +
      JSON.stringify(module) +
      '; const locks = new PublicationLocks(process.argv[1]); process.stdout.write(String(locks.acquire("target"))); process.stdin.resume();',
    root,
  ]);
  const exited = once(worker, "exit");
  try {
    const ready = await Promise.race([once(worker.stdout, "data"), exited]);
    expect(String(ready[0])).toBe("true");
    const other = new PublicationLocks(root);
    expect(other.acquire("target")).toBe(false);
    worker.kill();
    await exited;
    expect(other.acquire("target")).toBe(true);
    other.release("target");
  } finally {
    worker.kill();
    await exited;
  }
}, 15000);
