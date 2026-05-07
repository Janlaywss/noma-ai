import type { WebSearchPlugin, WebSearchResult } from "./types";

interface SearxngResult {
  title?: string;
  url?: string;
  content?: string;
}

interface SearxngResponse {
  results?: SearxngResult[];
}

export const searxngPlugin: WebSearchPlugin = {
  id: "searxng",
  isReady() {
    return !!process.env.SEARXNG_URL;
  },
  async search(query, opts) {
    const base = process.env.SEARXNG_URL;
    if (!base) throw new Error("SEARXNG_URL not set");

    const url = new URL("search", base.endsWith("/") ? base : base + "/");
    url.searchParams.set("q", query);
    url.searchParams.set("format", "json");

    const headers: Record<string, string> = { accept: "application/json" };
    if (process.env.SEARXNG_TOKEN) {
      headers.authorization = `Bearer ${process.env.SEARXNG_TOKEN}`;
    }

    const resp = await fetch(url, { headers });
    if (!resp.ok) {
      throw new Error(`searxng ${resp.status}: ${await resp.text()}`);
    }
    const data = (await resp.json()) as SearxngResponse;
    const max = opts?.maxResults ?? 5;
    return (data.results ?? []).slice(0, max).map(
      (r): WebSearchResult => ({
        title: r.title ?? "",
        url: r.url ?? "",
        snippet: r.content ?? "",
      })
    );
  },
};
