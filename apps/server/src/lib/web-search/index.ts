import { tavilyPlugin } from "./tavily";
import { searxngPlugin } from "./searxng";
import type { WebSearchPlugin, WebSearchResult } from "./types";

/**
 * Plugin selection is purely env-driven. Tavily wins when its key is set
 * (hosted, LLM-tuned); searxng is the self-hosted fallback. Neither set =
 * web search is unavailable and the agent tool is not registered.
 *
 * Order here is preference, not precedence for side-by-side execution.
 */
const PLUGINS: readonly WebSearchPlugin[] = [tavilyPlugin, searxngPlugin];

export function activeWebSearchPlugin(): WebSearchPlugin | null {
  return PLUGINS.find((p) => p.isReady()) ?? null;
}

export async function webSearch(
  query: string,
  opts?: { maxResults?: number }
): Promise<{ plugin: string; results: WebSearchResult[] }> {
  const plugin = activeWebSearchPlugin();
  if (!plugin) throw new Error("no web search backend configured");
  const results = await plugin.search(query, opts);
  return { plugin: plugin.id, results };
}

export type { WebSearchPlugin, WebSearchResult };
