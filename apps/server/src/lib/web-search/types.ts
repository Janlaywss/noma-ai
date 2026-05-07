export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchPlugin {
  /** Stable identifier, surfaced in logs. */
  readonly id: string;
  /** True when the plugin has the env/config it needs to run. */
  isReady(): boolean;
  /** Execute a search. Throw on network or API errors — the caller catches. */
  search(query: string, opts?: { maxResults?: number }): Promise<WebSearchResult[]>;
}
