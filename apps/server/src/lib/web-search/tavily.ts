import type { WebSearchPlugin, WebSearchResult } from "./types";

interface TavilyApiResult {
  title?: string;
  url?: string;
  content?: string;
}

interface TavilyApiResponse {
  results?: TavilyApiResult[];
}

export const tavilyPlugin: WebSearchPlugin = {
  id: "tavily",
  isReady() {
    return !!process.env.TAVILY_API_KEY;
  },
  async search(query, opts) {
    const key = process.env.TAVILY_API_KEY;
    if (!key) throw new Error("TAVILY_API_KEY not set");

    const resp = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_key: key,
        query,
        max_results: opts?.maxResults ?? 5,
        search_depth: "basic",
      }),
    });
    if (!resp.ok) {
      throw new Error(`tavily ${resp.status}: ${await resp.text()}`);
    }
    const data = (await resp.json()) as TavilyApiResponse;
    return (data.results ?? []).map(
      (r): WebSearchResult => ({
        title: r.title ?? "",
        url: r.url ?? "",
        snippet: r.content ?? "",
      })
    );
  },
};
