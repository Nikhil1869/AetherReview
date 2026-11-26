/** Provider registry — opencode-style model selection. Every provider speaks
 * the OpenAI chat-completions dialect (native or via compat endpoint), so one
 * reviewer client covers all of them, including local servers. */

import {
  isLoopback,
  parseReviewerEndpoint,
  reviewerConfigured,
  reviewerSettings,
} from "./config.js";
import { readBoundedText } from "./sourceBody.js";

export interface Provider {
  id: string;
  label: string;
  baseUrl: string;
  keyUrl?: string; // where to create an API key; undefined = no key needed
  local?: boolean;
  models: string[]; // suggestions; user can always type a custom model
}

export const PROVIDERS: Provider[] = [
  {
    id: "ollama",
    label: "Ollama (local)",
    baseUrl: "http://localhost:11434/v1",
    local: true,
    models: [],
  },
  {
    id: "gemini",
    label: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
    keyUrl: "https://aistudio.google.com/apikey",
    models: ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite"],
  },
  {
    id: "anthropic",
    label: "Anthropic Claude",
    baseUrl: "https://api.anthropic.com/v1/",
    keyUrl: "https://console.anthropic.com/settings/keys",
    models: ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"],
  },
  {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    keyUrl: "https://platform.openai.com/api-keys",
    models: ["gpt-5.2", "gpt-5.2-mini", "gpt-4.1"],
  },
  {
    id: "openrouter",
    label: "OpenRouter (any model)",
    baseUrl: "https://openrouter.ai/api/v1",
    keyUrl: "https://openrouter.ai/keys",
    models: ["anthropic/claude-sonnet-4.6", "google/gemini-2.5-flash", "deepseek/deepseek-v3.2"],
  },
  {
    id: "groq",
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    keyUrl: "https://console.groq.com/keys",
    models: ["llama-4-maverick", "qwen-3-72b"],
  },
  {
    id: "lmstudio",
    label: "LM Studio (local)",
    baseUrl: "http://localhost:1234/v1",
    local: true,
    models: [],
  },
  {
    id: "custom",
    label: "Custom endpoint",
    baseUrl: "",
    models: [],
  },
];

async function readModelIds(response: Response): Promise<string[] | null> {
  const text = await readBoundedText(response, 1024 * 1024);
  if (text === null) return null;
  const body = JSON.parse(text);
  if (body?.data === null) return [];
  if (!Array.isArray(body?.data)) return null;
  const ids: string[] = [];
  for (const item of body.data) {
    if (typeof item?.id !== "string" || !item.id.trim() || item.id.length > 512) return null;
    if (/\p{Cc}/u.test(item.id)) return null;
    ids.push(item.id);
  }
  return ids;
}

/** Live-detect models on a local OpenAI-compatible server (Ollama, LM Studio).
 * null = server unreachable; [] = server up but no models installed (e.g. a
 * fresh Ollama before any `ollama pull`) — callers should word these apart. */
export async function detectLocalModels(baseUrl: string): Promise<string[] | null> {
  try {
    const url = parseReviewerEndpoint(baseUrl);
    if (!url || !isLoopback(url)) return null;
    url.pathname = url.pathname.replace(/\/$/, "") + "/models";
    const res = await fetch(url, {
      signal: AbortSignal.timeout(2000),
      redirect: "error",
    });
    if (!res.ok) {
      await res.body?.cancel();
      return null;
    }
    return await readModelIds(res);
  } catch {
    return null;
  }
}

export async function diagnoseReviewer(): Promise<{ ok: boolean; message: string }> {
  const settings = reviewerSettings();
  const endpoint = parseReviewerEndpoint(settings.baseUrl);
  if (!endpoint || !reviewerConfigured())
    return { ok: false, message: "Configure a valid reviewer endpoint and any required API key." };
  try {
    endpoint.pathname = `${endpoint.pathname.replace(/\/$/, "")}/models`;
    const response = await fetch(endpoint, {
      headers: settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {},
      signal: AbortSignal.timeout(5000),
      redirect: "error",
    });
    if (!response.ok) {
      await response.body?.cancel();
      return {
        ok: false,
        message: `${endpoint.origin} returned HTTP ${response.status} for model discovery.`,
      };
    }
    const models = await readModelIds(response);
    if (!models)
      return { ok: false, message: `${endpoint.origin} returned an invalid model list.` };
    const found = models.includes(settings.model);
    return {
      ok: found,
      message: `${endpoint.origin} ${found ? "lists" : "does not list"} the configured model.`,
    };
  } catch {
    return { ok: false, message: `Could not retrieve the model list from ${endpoint.origin}.` };
  }
}
