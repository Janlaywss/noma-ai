import { describe, it, expect, afterEach } from "vitest";
import { larkDescriptor } from "../../src/app/lark.js";
import { createMockContext } from "../helpers/mock-context.js";
import { installFetchMock } from "../helpers/mock-fetch.js";
import type { Connector } from "../../src/types.js";

let conn: Connector | null = null;

afterEach(async () => {
  if (conn) {
    await conn.stop();
    conn = null;
  }
});

const TOKEN_URL = "auth/v3/tenant_access_token/internal";
const CHATS_URL = "im/v1/chats";

describe("lark connector — 飞书会话更新", () => {
  it("appId / appSecret 为空时跳过", async () => {
    installFetchMock([]);
    const { ctx, events, logs } = createMockContext();
    conn = larkDescriptor.create(
      { ...larkDescriptor.defaults, appId: "", appSecret: "", pollIntervalSec: 60 },
      ctx
    );
    await conn.start();
    expect(events).toHaveLength(0);
    expect(logs.some((l) => l.message.includes("missing appId/appSecret"))).toBe(true);
  });

  it("先获取 token，再为 lastSeen 之后的会话 emit on_chat_update", async () => {
    installFetchMock([
      {
        match: TOKEN_URL,
        respond: { json: { tenant_access_token: "tk_abc", expire: 7200 } },
      },
      {
        match: CHATS_URL,
        respond: {
          json: {
            data: {
              items: [
                {
                  chat_id: "c1",
                  name: "General",
                  description: "main channel",
                  last_message_time: "1735689600", // 2025-01-01
                },
                {
                  chat_id: "c2",
                  name: "Bots",
                  last_message_time: "1735689700",
                },
              ],
            },
          },
        },
      },
    ]);
    const { ctx, events } = createMockContext();
    conn = larkDescriptor.create(
      { ...larkDescriptor.defaults, appId: "id", appSecret: "secret", pollIntervalSec: 60 },
      ctx
    );

    await conn.start();

    expect(events).toHaveLength(2);
    expect(events[0]?.type).toBe("on_chat_update");
    expect(events[0]?.payload).toMatchObject({
      chat_id: "c1",
      title: "General · 新活动",
      sub: "main channel",
    });
    // lastSeen 推进到最新一条会话的时间戳（飞书返回的是秒，存的是毫秒）
    expect(conn.status().lastSeen).toBe(1735689700 * 1000);
  });

  it("token endpoint 返回非 OK 时打 warn", async () => {
    installFetchMock([
      { match: TOKEN_URL, respond: { status: 401, body: "" } },
    ]);
    const { ctx, events, logs } = createMockContext();
    conn = larkDescriptor.create(
      { ...larkDescriptor.defaults, appId: "id", appSecret: "secret", pollIntervalSec: 60 },
      ctx
    );
    await conn.start();
    expect(events).toHaveLength(0);
    expect(logs.some((l) => l.message.includes("token HTTP 401"))).toBe(true);
  });

  it("token 响应里缺 tenant_access_token 时打 warn", async () => {
    installFetchMock([
      { match: TOKEN_URL, respond: { json: { expire: 7200 } } },
    ]);
    const { ctx, events, logs } = createMockContext();
    conn = larkDescriptor.create(
      { ...larkDescriptor.defaults, appId: "id", appSecret: "secret", pollIntervalSec: 60 },
      ctx
    );
    await conn.start();
    expect(events).toHaveLength(0);
    expect(logs.some((l) => l.message.includes("missing tenant_access_token"))).toBe(true);
  });

  it("没有 last_message_time 的会话跳过", async () => {
    // 飞书的群可能从未有过消息，这种群没有 last_message_time，不该 emit
    installFetchMock([
      { match: TOKEN_URL, respond: { json: { tenant_access_token: "tk", expire: 7200 } } },
      {
        match: CHATS_URL,
        respond: {
          json: {
            data: { items: [{ chat_id: "x", name: "Empty" }] },
          },
        },
      },
    ]);
    const { ctx, events } = createMockContext();
    conn = larkDescriptor.create(
      { ...larkDescriptor.defaults, appId: "id", appSecret: "secret", pollIntervalSec: 60 },
      ctx
    );
    await conn.start();
    expect(events).toHaveLength(0);
  });

  it("descriptor 中 appSecret 是 secret + taskRequired", () => {
    const sec = larkDescriptor.configSchema.find((f) => f.key === "appSecret");
    expect(sec?.secret).toBe(true);
    expect(sec?.taskRequired).toBe(true);
  });
});
