/** Review norms, layered low->high: built-in defaults <- global config & packs <-
 * repo .aetherreview.yml (project wins). Global code transforms run last. `agent`/`key_ref`
 * are stripped from repo config and a repo's `extends` may reference packs by NAME only —
 * a fork must never redirect the reviewer, leak keys, escape the dir, or run code. */

import { parse } from "yaml";
import { z } from "zod";

import { loadConfig } from "./config.js";
import type { ForgeClient } from "./forge.js";
import {
  closeShape,
  loadPacks,
  loadTransforms,
  mergeNorms,
  safePackName,
} from "./normsRegistry.js";
import type { Forge, MrInfo, NormCtx, Norms, RawNorms } from "./types.js";
import type { FileDiff } from "./types.js";

const DEFAULTS: Norms = {
  confidenceThreshold: 0.7,
  maxFindings: 25,
  exclude: [
    "**/*.lock",
    "**/*.min.js",
    "**/__generated__/**",
    "**/node_modules/**",
    "**/dist/**",
    "**/build/**",
    "**/.aetherreview/**",
    "**/.env",
    "**/.env.*",
  ],
  categories: {
    security: true,
    bug: true,
    perf: true,
    style: true,
    maintainability: true,
    reliability: true,
    testing: true,
  },
  guidelines: `Review like a careful senior engineer. Prioritise, in order:
1. Security — injection, secrets in code, broken authn/authz, unsafe deserialization.
2. Correctness — null/undefined derefs, off-by-one, race conditions, wrong API usage.
3. Performance — N+1 queries, accidental quadratic loops, sync I/O on a hot path.
4. Maintainability — dead code, misleading names, missing error handling.
Be concrete and kind. Prefer one strong finding over many weak ones.`,
  examples: [],
};

const repoNormsSchema = z.object({
  extends: z.array(z.string().max(100)).max(25).optional().catch(undefined),
  confidence_threshold: z.number().min(0).max(1).optional().catch(undefined),
  max_findings: z.int().min(0).max(1000).optional().catch(undefined),
  exclude: z.array(z.string().min(1).max(150)).max(100).optional().catch(undefined),
  categories: z.record(z.string(), z.boolean()).optional().catch(undefined),
  guidelines: z.string().max(8000).optional().catch(undefined),
  examples: z
    .array(z.object({ bad: z.string().max(1000).optional(), why: z.string().max(1000).optional() }))
    .max(10)
    .optional()
    .catch(undefined),
});

/** Facts the layered loader can pass through to code transforms. */
export interface LoadNormsCtx {
  forge?: Forge;
  diffLines?: number;
}

export async function loadNorms(
  gl: Pick<ForgeClient, "getFile">,
  projectId: string,
  mr: MrInfo,
  ctx: LoadNormsCtx = {},
): Promise<Norms> {
  const packs = loadPacks();
  const global = loadConfig().norms ?? {};

  // repo .aetherreview.yml — UNTRUSTED. strip redirect/key fields; `extends` is name-only.
  let repoCfg: RawNorms = {};
  const ref = mr.diffRefs?.head_sha || mr.sourceBranch;
  if (ref) {
    const raw = await gl.getFile(projectId, ".aetherreview.yml", ref).catch(() => null);
    if (raw && raw.length <= 32_000) {
      try {
        // The allowlist strips unknown keys, including agent and key_ref.
        const parsed = repoNormsSchema.safeParse(parse(raw));
        if (parsed.success) repoCfg = parsed.data;
      } catch {
        repoCfg = {};
      }
    }
  }

  // assemble layers, low -> high precedence (project wins on overlapping scalars).
  const layers: { label: string; raw: RawNorms }[] = [{ label: "global", raw: global }];
  for (const name of global.use ?? []) {
    const pack = packs.get(name);
    if (pack) layers.push({ label: name, raw: pack });
  }
  // a repo may pull in packs by NAME only, and only ones already installed locally.
  for (const name of repoCfg.extends ?? []) {
    if (!safePackName(name)) continue; // reject path traversal / non-bare names
    const pack = packs.get(name);
    if (pack) layers.push({ label: name, raw: pack });
  }
  layers.push({ label: "repo", raw: repoCfg });

  let norms = closeShape(DEFAULTS);
  for (const { label, raw } of layers) norms = mergeNorms(norms, raw, label);

  // code transforms run LAST and only when the GLOBAL config activates them — a repo can
  // never trigger code. A broken transform must not kill the review.
  const transforms = await loadTransforms(global.use ?? []);
  if (transforms.length) {
    const tctx: NormCtx = { forge: ctx.forge ?? "github", projectId, mr, diffLines: ctx.diffLines };
    for (const t of transforms) {
      try {
        const out = t.transform(norms, tctx);
        norms = closeShape(out ?? norms);
      } catch {
        // skip a throwing transform
      }
    }
  }

  return closeShape(norms);
}

function matchesGlob(path: string, pattern: string): boolean {
  if (!/[*?]/.test(pattern)) return path === pattern;
  const tokens = pattern.match(/\*\*\/|\*\*|\*|\?|[\s\S]/g) ?? [];
  let next = new Uint8Array(path.length + 1);
  let current = new Uint8Array(path.length + 1);
  next[path.length] = 1;
  // Match suffixes in bounded time even when the repository supplies the glob.
  for (const token of tokens.reverse()) {
    current[path.length] = token.startsWith("*") ? next[path.length] : 0;
    let matchAfterSlash = 0;
    for (let i = path.length - 1; i >= 0; i--) {
      const slash = path[i] === "/";
      if (token === "**/") {
        if (slash) matchAfterSlash |= next[i + 1];
        current[i] = next[i] | matchAfterSlash;
      } else if (token === "*" || token === "**") {
        current[i] = next[i] | (!slash || token === "**" ? current[i + 1] : 0);
      } else {
        current[i] = token === path[i] || (token === "?" && !slash) ? next[i + 1] : 0;
      }
    }
    [next, current] = [current, next];
  }
  return next[0] === 1;
}

export function isExcluded(path: string, norms: Norms): boolean {
  const basename = path.split("/").pop() ?? path;
  for (const pat of norms.exclude) {
    const stripped = pat.startsWith("**/") ? pat.slice(3) : pat;
    if (
      matchesGlob(path, pat) ||
      (stripped !== pat && matchesGlob(path, stripped)) ||
      (basename !== path && matchesGlob(basename, stripped))
    ) {
      return true;
    }
  }
  return false;
}

export function applyExcludes(diffs: FileDiff[], norms: Norms): FileDiff[] {
  return diffs.filter((d) => !isExcluded(d.newPath || d.oldPath || "", norms));
}
