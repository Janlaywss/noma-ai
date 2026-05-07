import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { gmailDescriptor } from "../../src/app/gmail.js";
import { createMockContext, createMemoryStorage } from "../helpers/mock-context.js";
import { installFetchMock } from "../helpers/mock-fetch.js";
import type { Connector } from "../../src/types.js";

let conn: Connector | null = null;

beforeEach(() => {
  // gmail connector 内部从 process.env 读 OAuth client 凭据，测试里 stub 一份
  vi.stubEnv("GOOGLE_CLIENT_ID", "test-client");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "test-secret");
});

afterEach(async () => {
  if (conn) {
    await conn.stop();
    conn = null;
  }
  vi.unstubAllEnvs();
});

const LIST_URL = "gmail.googleapis.com/gmail/v1/users/me/messages?q=";
const MSG_URL = (id: string) => `gmail.googleapis.com/gmail/v1/users/me/messages/${id}`;
const TOKEN_URL = "oauth2.googleapis.com/token";

function gmailMessage(opts: { id: string; from: string; subject: string }) {
  return {
    id: opts.id,
    threadId: `t-${opts.id}`,
    snippet: "preview",
    payload: {
      headers: [
        { name: "From", value: opts.from },
        { name: "Subject", value: opts.subject },
        { name: "Date", value: "Wed, 01 Jan 2025 00:00:00 +0000" },
      ],
    },
  };
}

describe("gmail connector — Gmail 新邮件", () => {
  it("没有有效 token 且无法刷新时打 warn 并跳过", async () => {
    installFetchMock([]);
    const { ctx, events, logs } = createMockContext();
    conn = gmailDescriptor.create(
      {
        ...gmailDescriptor.defaults,
        access_token: "",
        refresh_token: null,
        expires_at: 0,
        pollIntervalSec: 60,
      },
      ctx
    );
    await conn.start();
    expect(events).toHaveLength(0);
    expect(logs.some((l) => l.message.includes("no valid token"))).toBe(true);
  });

  it("list 接口返回的邮件每封都 emit on_new_email", async () => {
    installFetchMock([
      {
        match: LIST_URL,
        respond: {
          json: { messages: [{ id: "m1", threadId: "t1" }, { id: "m2", threadId: "t2" }] },
        },
      },
      {
        match: MSG_URL("m1"),
        respond: { json: gmailMessage({ id: "m1", from: "alice@x", subject: "Hi" }) },
      },
      {
        match: MSG_URL("m2"),
        respond: { json: gmailMessage({ id: "m2", from: "bob@y", subject: "Hello" }) },
      },
    ]);
    const { ctx, events } = createMockContext();
    conn = gmailDescriptor.create(
      {
        ...gmailDescriptor.defaults,
        access_token: "valid_token",
        refresh_token: "refresh",
        expires_at: Date.now() + 600_000,
        pollIntervalSec: 60,
      },
      ctx
    );
    await conn.start();

    expect(events).toHaveLength(2);
    expect(events[0]?.type).toBe("on_new_email");
    expect(events[0]?.payload).toMatchObject({
      title: "Hi",
      sub: "alice@x",
      message_id: "m1",
      thread_id: "t-m1",
    });
  });

  it("收到 401 时刷新 token 并重试 list 请求", async () => {
    // 模拟「token 看似有效但实际已被服务端撤销」场景：第一次 list → 401，刷新后重试
    let listCalls = 0;
    installFetchMock([
      {
        match: TOKEN_URL,
        respond: { json: { access_token: "fresh", expires_in: 3600 } },
      },
      {
        match: LIST_URL,
        respond: () => {
          listCalls++;
          if (listCalls === 1) return { status: 401, body: "" };
          return { json: { messages: [{ id: "m1", threadId: "t1" }] } };
        },
      },
      {
        match: MSG_URL("m1"),
        respond: { json: gmailMessage({ id: "m1", from: "x@y", subject: "after refresh" }) },
      },
    ]);

    const storage = createMemoryStorage();
    const { ctx, events } = createMockContext({ storage });
    conn = gmailDescriptor.create(
      {
        ...gmailDescriptor.defaults,
        access_token: "expired",
        refresh_token: "rt",
        expires_at: Date.now() + 600_000, // 看着还在有效期，靠 401 触发刷新
        pollIntervalSec: 60,
      },
      ctx
    );
    await conn.start();

    expect(events).toHaveLength(1);
    expect(events[0]?.payload?.title).toBe("after refresh");
    // 刷新后的 token 必须落库，重启时才能直接复用
    expect(await storage.get("access_token")).toBe("fresh");
  });

  it("启动时如果 storage 里的 token 还在有效期就直接用", async () => {
    installFetchMock([
      { match: LIST_URL, respond: { json: { messages: [] } } },
    ]);
    const future = Date.now() + 3_600_000;
    const storage = createMemoryStorage({
      access_token: "stored_tok",
      expires_at: String(future),
    });
    const { ctx } = createMockContext({ storage });
    conn = gmailDescriptor.create(
      {
        ...gmailDescriptor.defaults,
        access_token: "",
        expires_at: 0,
        pollIntervalSec: 60,
      },
      ctx
    );

    await conn.start();
    const status = conn.status() as { tokenExpiresAt: number };
    // expires_at 应被 storage 中的值覆盖
    expect(status.tokenExpiresAt).toBe(future);
  });

  it("ctx.refreshOAuth 存在时优先走 host 代理刷新", async () => {
    // 模拟 desktop app 的场景：refreshOAuth 通过 server proxy 刷新 token
    let refreshOAuthCalled = false;
    installFetchMock([
      { match: LIST_URL, respond: { json: { messages: [{ id: "m1", threadId: "t1" }] } } },
      { match: MSG_URL("m1"), respond: { json: gmailMessage({ id: "m1", from: "z@w", subject: "via proxy" }) } },
    ]);

    const storage = createMemoryStorage();
    const { ctx, events } = createMockContext({ storage });

    // Inject refreshOAuth — simulates the desktop task-manager proxy
    ctx.refreshOAuth = async () => {
      refreshOAuthCalled = true;
      return { access_token: "proxy_fresh", expires_at: Date.now() + 3_600_000 };
    };

    conn = gmailDescriptor.create(
      {
        ...gmailDescriptor.defaults,
        access_token: "expired_tok",
        refresh_token: "rt",
        expires_at: 0, // already expired → triggers refresh
        pollIntervalSec: 60,
      },
      ctx
    );
    await conn.start();

    expect(refreshOAuthCalled).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload?.title).toBe("via proxy");
    // Token should be persisted via storage
    expect(await storage.get("access_token")).toBe("proxy_fresh");
  });

  it("ctx.refreshOAuth 返回 null 时不回退（desktop 无 client_secret）", async () => {
    // Desktop scenario: host proxy fails, and there's no GOOGLE_CLIENT_SECRET
    // locally, so no fallback. Should log warn and skip polling.
    installFetchMock([]);

    const storage = createMemoryStorage();
    const { ctx, events, logs } = createMockContext({ storage });
    ctx.refreshOAuth = async () => null;

    conn = gmailDescriptor.create(
      {
        ...gmailDescriptor.defaults,
        access_token: "expired",
        refresh_token: "rt",
        expires_at: 0, // expired → triggers refresh attempt
        pollIntervalSec: 60,
      },
      ctx
    );
    await conn.start();

    // refreshOAuth returned null → logged warn
    expect(logs.some((l) => l.message.includes("refreshOAuth returned null"))).toBe(true);
    // No events emitted (couldn't get a valid token)
    expect(events).toHaveLength(0);
    // No token stored
    expect(await storage.get("access_token")).toBeNull();
  });

  it("工具也共享 refreshOAuth 刷新的 token", async () => {
    // The list_messages tool should use the same token from refreshOAuth
    installFetchMock([
      { match: LIST_URL, respond: { json: { messages: [] } } },
    ]);

    const storage = createMemoryStorage({
      access_token: "tool_tok",
      expires_at: String(Date.now() + 3_600_000),
    });
    const { ctx } = createMockContext({ storage });

    const config = {
      ...gmailDescriptor.defaults,
      access_token: "",
      expires_at: 0,
      pollIntervalSec: 60,
    };

    // Call the tool directly
    const listTool = gmailDescriptor.tools!.find(t => t.schema.name === "list_messages")!;
    const result = await listTool.execute(
      { query: "is:unread", maxResults: 5 },
      config,
      { log: ctx.log, storage, refreshOAuth: ctx.refreshOAuth }
    );
    expect(result).toContain("messages");
  });

  it("GOOGLE_CLIENT_ID 未设置时不尝试刷新", async () => {
    // 缺少 OAuth client 凭据时刷新无意义，应直接放弃
    vi.unstubAllEnvs();
    installFetchMock([]);
    const { ctx, events, logs } = createMockContext();
    conn = gmailDescriptor.create(
      {
        ...gmailDescriptor.defaults,
        access_token: "",
        refresh_token: "rt",
        expires_at: 0,
        pollIntervalSec: 60,
      },
      ctx
    );
    await conn.start();
    expect(events).toHaveLength(0);
    expect(logs.some((l) => l.message.includes("no valid token"))).toBe(true);
  });
});
