import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";

const MAX_CONTENT_LENGTH = 16_000;
const FETCH_TIMEOUT_MS = 15_000;

export async function webFetch(url: string): Promise<string> {
  const resp = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 (compatible; NomaBot/1.0)",
      accept: "text/html,application/xhtml+xml,*/*",
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    redirect: "follow",
  });

  if (!resp.ok) {
    throw new Error(`fetch ${resp.status}: ${resp.statusText}`);
  }

  const contentType = resp.headers.get("content-type") ?? "";
  const html = await resp.text();

  if (!contentType.includes("html")) {
    return truncate(html);
  }

  const { document } = parseHTML(html);
  const reader = new Readability(document);
  const article = reader.parse();

  if (!article?.textContent) {
    return truncate(document.body?.textContent ?? html);
  }

  const header = article.title ? `# ${article.title}\n\n` : "";
  return truncate(header + article.textContent);
}

function truncate(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_CONTENT_LENGTH) return trimmed;
  return trimmed.slice(0, MAX_CONTENT_LENGTH) + "\n\n[truncated]";
}
