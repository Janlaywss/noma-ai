import { createServer, type Server } from "node:http";
import { Readable } from "node:stream";
import type { AddressInfo } from "node:net";

/**
 * Forward an HTTP request to the upstream LLM provider.
 *
 * The proxy calls this for every incoming request. The consumer decides
 * how to authenticate and where to route:
 *   - Desktop attaches Supabase cookies via `serverFetch`
 *   - Eval attaches an OpenRouter API key via `Authorization: Bearer`
 */
export type LlmProxyForwarder = (request: {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Uint8Array | undefined;
}) => Promise<Response>;

export type LlmProxyHandle = {
  url: string;
  stop: () => Promise<void>;
};

export async function startLlmProxy(
  forward: LlmProxyForwarder
): Promise<LlmProxyHandle> {
  const server = createServer(async (req, res) => {
    if (!req.url) {
      res.writeHead(400).end();
      return;
    }

    let body: Uint8Array | undefined;
    if (req.method !== "GET" && req.method !== "HEAD") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      body = new Uint8Array(Buffer.concat(chunks));
    }

    const headers: Record<string, string> = {};
    const accept = req.headers["accept"];
    if (typeof accept === "string") headers["accept"] = accept;
    const contentType = req.headers["content-type"];
    if (typeof contentType === "string") headers["content-type"] = contentType;

    const responsesAdapter =
      body && isResponsesPath(req.url)
        ? adaptResponsesRequestBodyForOpenRouter(body)
        : null;

    let upstream: Response;
    try {
      upstream = await forward({
        method: req.method ?? "GET",
        path: req.url,
        headers,
        body: responsesAdapter?.body ?? body,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `llm-proxy: ${msg}` } }));
      return;
    }

    if (responsesAdapter && responsesAdapter.nameMap.size > 0) {
      upstream = adaptResponsesResponseFromOpenRouter(
        upstream,
        responsesAdapter.nameMap
      );
    }

    const respHeaders: Record<string, string> = {};
    upstream.headers.forEach((value, name) => {
      const lower = name.toLowerCase();
      if (lower === "content-encoding" || lower === "transfer-encoding") return;
      respHeaders[name] = value;
    });

    res.writeHead(upstream.status, respHeaders);
    if (!upstream.body) {
      res.end();
      return;
    }
    Readable.fromWeb(upstream.body as any).pipe(res);
  });

  server.on("upgrade", (_req, socket) => {
    socket.write("HTTP/1.1 501 Not Implemented\r\n\r\n");
    socket.destroy();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

/**
 * Convenience: create a forwarder that attaches a Bearer token and
 * routes to a base URL. Covers the OpenRouter / generic OpenAI case.
 */
export function createApiKeyForwarder(
  apiKey: string,
  baseUrl = "https://openrouter.ai/api"
): LlmProxyForwarder {
  const base = baseUrl.replace(/\/$/, "");
  return async ({ method, path, headers, body }) => {
    const upstreamPath = path.startsWith("/v1/") ? path : `/v1${path}`;
    return fetch(`${base}${upstreamPath}`, {
      method,
      headers: { ...headers, authorization: `Bearer ${apiKey}` },
      body: body as any,
    });
  };
}

type NamespaceToolNameMap = Map<string, { namespace: string; name: string }>;

export function adaptResponsesRequestForOpenRouter(input: unknown): {
  request: unknown;
  nameMap: NamespaceToolNameMap;
} {
  const nameMap: NamespaceToolNameMap = new Map();
  if (!isRecord(input)) return { request: input, nameMap };
  if (!Array.isArray(input.tools)) return { request: input, nameMap };
  const tools = input.tools.flatMap((tool) =>
    flattenNamespaceTool(tool, nameMap)
  );
  return {
    request: adaptNamespaceToolCallsForProvider({ ...input, tools }, nameMap),
    nameMap,
  };
}

function adaptResponsesRequestBodyForOpenRouter(body: Uint8Array): {
  body: Uint8Array;
  nameMap: NamespaceToolNameMap;
} {
  try {
    const parsed = JSON.parse(Buffer.from(body).toString("utf8"));
    const adapted = adaptResponsesRequestForOpenRouter(parsed);
    return {
      body: new TextEncoder().encode(JSON.stringify(adapted.request)),
      nameMap: adapted.nameMap,
    };
  } catch {
    return { body, nameMap: new Map() };
  }
}

function flattenNamespaceTool(
  tool: unknown,
  nameMap: NamespaceToolNameMap
): unknown[] {
  if (!isRecord(tool) || tool.type !== "namespace") return [tool];
  if (typeof tool.name !== "string" || !Array.isArray(tool.tools)) {
    return [tool];
  }

  const namespace = tool.name;
  const prefix = namespaceToolPrefix(namespace);
  return tool.tools.map((child) => {
    if (!isRecord(child) || typeof child.name !== "string") return child;
    const childName = child.name;
    const flatName = `${prefix}${childName}`;
    nameMap.set(flatName, { namespace, name: childName });
    const description =
      typeof child.description === "string" && child.description.length > 0
        ? child.description
        : `${namespace}.${childName}`;
    return {
      ...child,
      name: flatName,
      description,
    };
  });
}

function namespaceToolPrefix(namespace: string): string {
  if (/^mcp__[A-Za-z0-9_]+__$/.test(namespace)) {
    return sanitizeToolName(namespace);
  }
  return `${sanitizeToolName(namespace)}_`;
}

function sanitizeToolName(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_");
}

function adaptResponsesResponseFromOpenRouter(
  upstream: Response,
  nameMap: NamespaceToolNameMap
): Response {
  const headers = new Headers(upstream.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");

  if (!upstream.body) {
    return new Response(null, { status: upstream.status, headers });
  }

  const contentType = headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    return new Response(adaptSseBody(upstream.body, nameMap), {
      status: upstream.status,
      headers,
    });
  }

  return new Response(adaptJsonBody(upstream.body, nameMap), {
    status: upstream.status,
    headers,
  });
}

function adaptSseBody(
  body: ReadableStream<Uint8Array>,
  nameMap: NamespaceToolNameMap
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          buffer = flushCompleteSseBlocks(
            buffer,
            controller,
            nameMap,
            encoder,
            false
          );
        }
        buffer += decoder.decode();
        buffer = flushCompleteSseBlocks(
          buffer,
          controller,
          nameMap,
          encoder,
          true
        );
        controller.close();
      } catch (err) {
        controller.error(err);
      } finally {
        reader.releaseLock();
      }
    },
  });
}

function flushCompleteSseBlocks(
  input: string,
  controller: ReadableStreamDefaultController<Uint8Array>,
  nameMap: NamespaceToolNameMap,
  encoder: TextEncoder,
  flushRemainder: boolean
): string {
  let buffer = input;
  while (true) {
    const sep = nextSseSeparator(buffer);
    if (!sep) break;
    const block = buffer.slice(0, sep.index);
    buffer = buffer.slice(sep.index + sep.length);
    controller.enqueue(encoder.encode(`${adaptSseBlock(block, nameMap)}\n\n`));
  }

  if (flushRemainder && buffer.length > 0) {
    controller.enqueue(encoder.encode(adaptSseBlock(buffer, nameMap)));
    buffer = "";
  }
  return buffer;
}

function nextSseSeparator(input: string): { index: number; length: number } | null {
  const lf = input.indexOf("\n\n");
  const crlf = input.indexOf("\r\n\r\n");
  if (lf === -1 && crlf === -1) return null;
  if (lf === -1) return { index: crlf, length: 4 };
  if (crlf === -1 || lf < crlf) return { index: lf, length: 2 };
  return { index: crlf, length: 4 };
}

function adaptSseBlock(block: string, nameMap: NamespaceToolNameMap): string {
  return block
    .split(/\r?\n/)
    .map((line) => {
      if (!line.startsWith("data:")) return line;
      const data = line.slice(5).trimStart();
      if (!data || data === "[DONE]") return line;
      try {
        return `data: ${JSON.stringify(
          adaptNamespaceToolCallsForCodex(JSON.parse(data), nameMap)
        )}`;
      } catch {
        return line;
      }
    })
    .join("\n");
}

function adaptJsonBody(
  body: ReadableStream<Uint8Array>,
  nameMap: NamespaceToolNameMap
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = body.getReader();
      const chunks: Uint8Array[] = [];
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
        }
        const text =
          chunks.map((chunk) => decoder.decode(chunk, { stream: true })).join("") +
          decoder.decode();
        const adapted = adaptNamespaceToolCallsForCodex(
          JSON.parse(text),
          nameMap
        );
        controller.enqueue(encoder.encode(JSON.stringify(adapted)));
        controller.close();
      } catch (err) {
        controller.error(err);
      } finally {
        reader.releaseLock();
      }
    },
  });
}

function adaptNamespaceToolCallsForProvider(
  value: unknown,
  nameMap: NamespaceToolNameMap
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => adaptNamespaceToolCallsForProvider(item, nameMap));
  }
  if (!isRecord(value)) return value;

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    out[key] = adaptNamespaceToolCallsForProvider(child, nameMap);
  }

  if (
    out.type === "function_call" &&
    typeof out.name === "string" &&
    typeof out.namespace === "string"
  ) {
    const flatName = flatNameForNamespaceCall(
      out.namespace,
      out.name,
      nameMap
    );
    if (flatName) {
      out.name = flatName;
      delete out.namespace;
    }
  }
  return out;
}

function adaptNamespaceToolCallsForCodex(
  value: unknown,
  nameMap: NamespaceToolNameMap
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => adaptNamespaceToolCallsForCodex(item, nameMap));
  }
  if (!isRecord(value)) return value;

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    out[key] = adaptNamespaceToolCallsForCodex(child, nameMap);
  }

  if (out.type === "function_call" && typeof out.name === "string") {
    const target = nameMap.get(out.name);
    if (target) {
      out.name = target.name;
      out.namespace = target.namespace;
    }
  }
  return out;
}

function flatNameForNamespaceCall(
  namespace: string,
  name: string,
  nameMap: NamespaceToolNameMap
): string | null {
  for (const [flatName, target] of nameMap) {
    if (target.namespace === namespace && target.name === name) {
      return flatName;
    }
  }
  return null;
}

function isResponsesPath(path: string): boolean {
  return path === "/responses" || path === "/v1/responses";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
