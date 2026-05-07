/**
 * Parses an SSE response body:
 *   event: <type>
 *   data: <json>
 *   (blank line)
 *
 * Yields one parsed frame per event and preserves partial lines across
 * stream chunks.
 */

export type SseFrame = { event: string; data: string };

export async function* parseSseResponse(
  res: Response
): AsyncGenerator<SseFrame, void, unknown> {
  if (!res.body) return;
  const decoder = new TextDecoder();
  const reader = res.body.getReader();
  let buffer = "";
  let currentEvent = "message";
  let dataLines: string[] = [];

  const flush = function* (): Generator<SseFrame> {
    if (dataLines.length === 0) {
      currentEvent = "message";
      return;
    }
    const data = dataLines.join("\n");
    yield { event: currentEvent, data };
    currentEvent = "message";
    dataLines = [];
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const rawLine = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

        if (line === "") {
          yield* flush();
          continue;
        }
        if (line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        const val = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
        if (field === "event") currentEvent = val;
        else if (field === "data") dataLines.push(val);
      }
    }
    if (buffer.length > 0) {
      const line = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
      if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    yield* flush();
  } finally {
    reader.releaseLock();
  }
}
