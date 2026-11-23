/** ~/.aetherreview store — same files/shapes as the Python version, so existing
 * setups keep working: credentials.json (forge tokens) + config.json (reviewer,
 * watch targets). */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { RawNorms } from "./types.js";

export const HOME = process.env.AETHERREVIEW_HOME ?? join(homedir(), ".aetherreview");
const CRED_PATH = join(HOME, "credentials.json");
const CONFIG_PATH = join(HOME, "config.json");
export const LOG_FILE = join(HOME, "watcher.log");
export const PID_FILE = join(HOME, "watcher.pid");
/** GitHub App private key (PEM), copied here on app sign-in. chmod 600. */
export const GITHUB_APP_KEY_PATH = join(HOME, "github-app.pem");

/** Where global norm packs (*.yml) and code transforms (*.mjs) live. Same trust
 * boundary as the rest of the store — dropping a file here is like installing a plugin. */
export function normsDir(): string {
  return join(HOME, "norms");
}

export interface ForgeCred {
  token?: string;
  method?: string; // "pat" | "gh" | "oauth" | "app"
  user?: string;
  url?: string;
  backend?: "mcp" | "rest";
  refresh_token?: string; // oauth device flow — refresh grant
  expires_at?: number; // oauth/app — access-token expiry, ms epoch
  client_id?: string; // oauth — the app client id used to obtain/refresh the token
  app_id?: string; // app — GitHub App id (public)
  installation_id?: number; // app — installation the token is minted for
}

export interface ReviewerConfig {
  provider?: string;
  api_key?: string;
  base_url?: string;
  model?: string;
  bot_name?: string;
  /** review passes per run: 1 = single (default), 2 adds a security-only pass,
   * 3 adds a logic-only pass. More passes = better recall on small models. */
  passes?: number;
  /** input-context budget per review, in tokens (diff + codebase context).
   * Caps cost and keeps small-context models from overflowing. */
  token_limit?: number;
}

export interface WatchConfig {
  targets?: string[];
  interval?: number;
}

/** Global (user-level) review norms. A personal baseline applied to every repo, plus
 * `use`: names of packs/transforms in `~/.aetherreview/norms/` to activate globally.
 * Layers below the repo's own `.aetherreview.yml` (project overrides global). */
export interface NormsConfig extends RawNorms {
  use?: string[];
}

export interface AppConfig {
  reviewer?: ReviewerConfig;
  watch?: WatchConfig;
  norms?: NormsConfig;
}

function readJson<T>(path: string): T {
  if (!existsSync(path)) return {} as T;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return {} as T;
  }
}

function writeJson(path: string, data: unknown): void {
  writePrivateFile(path, JSON.stringify(data, null, 2));
}

function writePrivateFile(path: string, contents: string): void {
  mkdirSync(HOME, { recursive: true, mode: 0o700 });
  const temporary = join(HOME, `.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, contents, { flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function saveGithubAppKey(pem: string): void {
  writePrivateFile(GITHUB_APP_KEY_PATH, pem);
}

export function loadCredentials(): Record<string, ForgeCred> {
  return readJson(CRED_PATH);
}

export function setForge(forge: string, fields: ForgeCred): void {
  const data = loadCredentials();
  data[forge] = { ...data[forge], ...fields };
  writeJson(CRED_PATH, data);
}

const ENV_TOKEN: Record<string, string> = {
  github: "GITHUB_TOKEN",
  gitlab: "GITLAB_TOKEN",
  bitbucket: "BITBUCKET_TOKEN",
};

export function resolveToken(forge: string): string | undefined {
  const env = process.env[ENV_TOKEN[forge] ?? ""];
  if (env !== undefined) return env;
  const credential = loadCredentials()[forge];
  const alternative =
    forge === "gitlab"
      ? process.env.GITLAB_URL
      : forge === "github"
        ? process.env.GITHUB_URL
        : undefined;
  if (alternative !== undefined) {
    const saved =
      credential?.url ?? (forge === "gitlab" ? "https://gitlab.com" : "https://api.github.com");
    const origin = URL.parse(alternative)?.origin;
    if (!origin || origin !== URL.parse(saved)?.origin) return undefined;
  }
  return credential?.token;
}

export function gitlabUrl(): string {
  return (process.env.GITLAB_URL ?? loadCredentials().gitlab?.url ?? "https://gitlab.com").replace(
    /\/+$/,
    "",
  );
}

/** True when any forge token exists (file or env) — the TUI login gate. */
export function hasForgeCredentials(): boolean {
  return !!(resolveToken("github") ?? resolveToken("gitlab"));
}

export function loadConfig(): AppConfig {
  return readJson(CONFIG_PATH);
}

export function updateConfig<K extends keyof AppConfig>(section: K, fields: AppConfig[K]): void {
  const data = loadConfig();
  data[section] = { ...data[section], ...fields };
  writeJson(CONFIG_PATH, data);
}

export interface ReviewerSettings {
  apiKey: string;
  baseUrl: string;
  model: string;
  botName: string;
  passes: number;
}

export function getBotName(model: string, customBotName?: string): string {
  if (customBotName) return customBotName;
  const m = model.toLowerCase();
  if (m.includes("claude")) return "Claude review";
  if (m.includes("gemini")) return "Gemini review";
  if (m.includes("gpt")) return "GPT review";
  if (m.includes("llama")) return "Llama review";
  if (m.includes("deepseek")) return "DeepSeek review";
  if (m.includes("qwen")) return "Qwen review";
  return "AetherReview review";
}

export function reviewerSettings(): ReviewerSettings {
  const cfg = loadConfig().reviewer ?? {};
  const gemini = "https://generativelanguage.googleapis.com/v1beta/openai/";
  const configuredUrl = cfg.base_url ?? gemini;
  const baseUrl = process.env.REVIEWER_BASE_URL ?? configuredUrl;
  const origin = parseReviewerEndpoint(baseUrl)?.origin;
  const storedKey =
    origin && origin === parseReviewerEndpoint(configuredUrl)?.origin ? cfg.api_key : undefined;
  const geminiKey = origin === new URL(gemini).origin ? process.env.GEMINI_API_KEY : undefined;
  const apiKey = process.env.REVIEWER_API_KEY ?? geminiKey ?? storedKey ?? "";
  const model = process.env.REVIEWER_MODEL ?? cfg.model ?? "gemini-2.5-flash";
  const botName = process.env.REVIEWER_BOT_NAME ?? cfg.bot_name ?? getBotName(model);
  const rawPasses = Number(process.env.REVIEWER_PASSES ?? cfg.passes ?? 1);
  return {
    apiKey,
    baseUrl,
    model,
    botName,
    passes: Number.isFinite(rawPasses) ? Math.max(1, Math.min(3, Math.trunc(rawPasses))) : 1,
  };
}

export function parseReviewerEndpoint(input: string): URL | null {
  try {
    const endpoint = new URL(input);
    if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) return null;
    if (endpoint.protocol === "https:" || (endpoint.protocol === "http:" && isLoopback(endpoint))) {
      return endpoint;
    }
    return null;
  } catch {
    return null;
  }
}

export function isLoopback(endpoint: URL): boolean {
  return (
    endpoint.hostname === "localhost" ||
    endpoint.hostname === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(endpoint.hostname)
  );
}

/** True when a reviewer model is usable: an api key, or a local base url. */
export function reviewerConfigured(): boolean {
  const s = reviewerSettings();
  const endpoint = parseReviewerEndpoint(s.baseUrl);
  return !!endpoint && (!!s.apiKey || isLoopback(endpoint));
}

/** Sign out: drop forge credentials, watched repos, and the reviewer/model
 * config (so the next sign-in walks through model setup again). Keeps the
 * github OAuth client id — public, reused on next sign-in. */
export function resetLogin(): void {
  const clientId = loadCredentials().github?.client_id;
  rmSync(CRED_PATH, { force: true });
  rmSync(GITHUB_APP_KEY_PATH, { force: true });
  if (clientId) writeJson(CRED_PATH, { github: { client_id: clientId } });
  const cfg = loadConfig();
  delete cfg.reviewer;
  if (cfg.watch) cfg.watch = { ...cfg.watch, targets: [] };
  writeJson(CONFIG_PATH, cfg);
}

/** Wipe all local config: credentials, settings, logs, pid, locks. */
export function resetAll(): void {
  for (const f of [CRED_PATH, CONFIG_PATH, LOG_FILE, PID_FILE, GITHUB_APP_KEY_PATH]) {
    rmSync(f, { force: true });
  }
  rmSync(join(HOME, "locks"), { recursive: true, force: true });
}

/** Default input-context budget per review (tokens). At ~4 chars/token this
 * matches the previous fixed caps (40k diff chars + 40k context chars). */
export const DEFAULT_TOKEN_LIMIT = 20000;

/** Resolve the user's token limit: env > config > default. 0 means no limit
 * (the diff and context are sent untruncated). */
export function reviewTokenLimit(): number {
  const raw = Number(process.env.REVIEWER_TOKEN_LIMIT ?? loadConfig().reviewer?.token_limit);
  if (raw === 0) return 0;
  return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : DEFAULT_TOKEN_LIMIT;
}

/** Per-review budgets, derived from the token limit (split evenly between the
 * diff and the context bundle at ~4 chars/token). The char/file env overrides
 * still win for fine-grained control. A 0 token limit disables the char caps
 * (the context file-count cap still applies). */
export function reviewLimits() {
  const limit = reviewTokenLimit();
  const budgetChars = limit > 0 ? limit * 4 : Number.POSITIVE_INFINITY;
  return {
    maxDiffChars: Number(process.env.MAX_DIFF_CHARS ?? Math.floor(budgetChars / 2)),
    maxContextFiles: Number(process.env.MAX_CONTEXT_FILES ?? 12),
    maxContextChars: Number(process.env.MAX_CONTEXT_CHARS ?? Math.floor(budgetChars / 2)),
  };
}
