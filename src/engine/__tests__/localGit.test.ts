import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { newSideLines } from "../diff.js";
import { readLocalChanges } from "../localGit.js";

let fixture: string;
let repo: string;
const git = (...args: string[]) =>
  execFileSync("git", ["-C", repo, "-c", "gc.auto=0", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    },
  }).trim();

beforeEach(async () => {
  fixture = await mkdtemp(join(tmpdir(), "aetherreview-git-"));
  repo = join(fixture, "test repo");
  await mkdir(repo);
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "commit.gpgsign", "false");
  git("config", "core.autocrlf", "false");
});
afterEach(async () =>
  rm(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }),
);

const put = (file: string, text: string | Buffer) => writeFile(join(repo, file), text);

describe("readLocalChanges", { timeout: 30_000 }, () => {
  it("uses the requested snapshot and keeps the Git index intact", async () => {
    const path = "two words.ts";
    await put(path, "const value = 'base';\n");
    git("add", "--", path);
    git("commit", "-qm", "base");
    await put(path, "const value = 'staged';\n");
    git("add", "--", path);
    const index = await readFile(join(repo, ".git", "index"));
    await put(path, "const value = 'working';\n");
    const staged = await readLocalChanges(repo, { mode: "staged" });
    const unstaged = await readLocalChanges(repo, { mode: "unstaged" });
    const working = await readLocalChanges(repo, { mode: "working" });
    expect(staged.diffs[0]).toMatchObject({
      newPath: path,
      diff: expect.stringContaining("+const value = 'staged';"),
    });
    expect(unstaged.diffs[0].diff).toContain("-const value = 'staged';");
    expect(working.diffs[0].diff).toContain("-const value = 'base';");
    expect(await staged.getFile(repo, path)).toContain("'staged'");
    expect(await readFile(join(repo, ".git", "index"))).toEqual(index);
  });

  it("compares commits and keeps old/new names and binary patches distinct", async () => {
    await put("original.ts", "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n");
    await put("gone.ts", "bye\n");
    git("add", ".");
    git("commit", "-qm", "base");
    git("branch", "base");
    git("mv", "original.ts", "renamed file.ts");
    git("rm", "gone.ts");
    await put("renamed file.ts", "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nchanged\n");
    await put("binary.dat", Buffer.from([0, 1, 2]));
    git("add", ".");
    git("commit", "-qm", "head");
    const source = await readLocalChanges(repo, { mode: "compare", base: "base", head: "main" });
    expect(source.headSha).toBe(git("rev-parse", "HEAD"));
    expect(source.diffs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ newPath: "renamed file.ts", oldPath: "original.ts" }),
        expect.objectContaining({ newPath: "gone.ts", deletedFile: true }),
        expect.objectContaining({
          newPath: "binary.dat",
          newFile: true,
          diff: expect.stringContaining("Binary files"),
        }),
      ]),
    );
  });

  it("includes untracked text only on request and ignores files matched by .gitignore", async () => {
    await put(".gitignore", "ignored.ts\n");
    await put("first.ts", "staged\n");
    git("add", ".gitignore", "first.ts");
    await put("first.ts", "live\n");
    await put("ignored.ts", "ignored\n");
    await put("untracked.ts", "one\ntwo");
    const working = await readLocalChanges(repo, { mode: "working" });
    expect(working.diffs.map((file) => file.newPath)).not.toContain("untracked.ts");
    expect(working.diffs.find((file) => file.newPath === "first.ts")?.diff).toContain("+live");
    const expanded = await readLocalChanges(repo, { mode: "working", includeUntracked: true });
    expect(expanded.diffs.map((file) => file.newPath)).not.toContain("ignored.ts");
    const diff = expanded.diffs.find((file) => file.newPath === "untracked.ts")?.diff ?? "";
    expect([...newSideLines(diff)].map(({ line, text }) => [line, text])).toEqual([
      [1, "one"],
      [2, "two"],
    ]);
  });

  it("uses no named Git clean filter when taking a working-tree diff", async () => {
    await put(".gitattributes", "*.ts filter=fixture\n");
    await put("source.ts", "old\n");
    git("add", ".");
    git("commit", "-qm", "base");
    git("config", "filter.fixture.clean", "git --version");
    git("config", "filter.fixture.required", "true");
    await put("source.ts", "current source\n");
    const source = await readLocalChanges(repo, { mode: "working" });
    expect(source.diffs[0].diff).toContain("+current source");
    expect(source.diffs[0].diff).not.toContain("git version");
  });

  it("limits context reads to files inside the repository", async () => {
    const outside = join(fixture, "private.txt");
    await writeFile(outside, "external fixture\n");
    const source = await readLocalChanges(repo, { mode: "working" });
    expect(await source.getFile(repo, "../private.txt")).toBeNull();
    expect(await source.getFile(repo, ".git/config")).toBeNull();
    try {
      await symlink(fixture, join(repo, "outside"), "junction");
    } catch (error) {
      if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EPERM")
        throw error;
      return;
    }
    expect(await source.getFile(repo, "outside/private.txt")).toBeNull();
  });
});
