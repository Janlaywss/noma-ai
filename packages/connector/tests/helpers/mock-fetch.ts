import { vi, type MockInstance } from "vitest";

export type FetchResponseShape = {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  json?: unknown;
};

export type FetchHandler = {
  match: string | RegExp | ((url: string, init?: RequestInit) => boolean);
  respond:
    | FetchResponseShape
    | ((url: string, init?: RequestInit) => FetchResponseShape | Promise<FetchResponseShape>);
};

export interface FetchMock {
  spy: MockInstance;
  /** Replace handlers for subsequent calls. */
  setHandlers(next: FetchHandler[]): void;
  /** All calls made so far. */
  calls(): Array<{ url: string; init?: RequestInit }>;
  restore(): void;
}

function matches(
  m: FetchHandler["match"],
  url: string,
  init?: RequestInit
): boolean {
  if (typeof m === "string") return url.includes(m);
  if (m instanceof RegExp) return m.test(url);
  return m(url, init);
}

// Statuses that the Fetch spec forbids carrying a body. Passing a body
// (even "") to `new Response(body, { status })` for these throws TypeError,
// so we explicitly use null for them.
const NULL_BODY_STATUS = new Set([101, 103, 204, 205, 304]);

function buildResponse(shape: FetchResponseShape): Response {
  const status = shape.status ?? 200;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...shape.headers,
  };
  if (NULL_BODY_STATUS.has(status)) {
    return new Response(null, { status, headers });
  }
  const body =
    shape.json !== undefined ? JSON.stringify(shape.json) : (shape.body ?? "");
  return new Response(body, { status, headers });
}

/**
 * Install a fetch mock with the given handlers. Returns a controller that
 * lets you reset handlers, inspect calls, and restore the original fetch.
 *
 * Usage in tests: `const fetchMock = installFetchMock([{ match: /github/, respond: { json: [...] } }]);`
 * Vitest's `restoreMocks: true` (set in vitest.config.ts) handles cleanup
 * between tests, but tests can call `fetchMock.restore()` explicitly too.
 */
export function installFetchMock(initial: FetchHandler[] = []): FetchMock {
  let handlers = initial;
  const callLog: Array<{ url: string; init?: RequestInit }> = [];

  const impl = async (
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    callLog.push({ url, init });
    for (const h of handlers) {
      if (!matches(h.match, url, init)) continue;
      const shape =
        typeof h.respond === "function" ? await h.respond(url, init) : h.respond;
      return buildResponse(shape);
    }
    throw new Error(`unmocked fetch: ${url}`);
  };

  const spy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(impl as typeof fetch);

  return {
    spy,
    setHandlers(next) {
      handlers = next;
    },
    calls() {
      return callLog.slice();
    },
    restore() {
      spy.mockRestore();
    },
  };
}
