import { describe, it, expect, afterEach, vi } from "vitest";
import { larkDescriptor } from "../../src/app/lark.js";
import { createMockContext } from "../helpers/mock-context.js";
import type { Connector } from "../../src/types.js";

let conn: Connector | null = null;

afterEach(async () => {
  if (conn) {
    await conn.stop();
    conn = null;
  }
  mockChatGet?.mockClear();
  mockUserGet?.mockClear();
  mockWSClose?.mockClear();
});

let capturedEventDispatcher: any = null;
let mockWSClose: ReturnType<typeof vi.fn>;
let mockChatGet: ReturnType<typeof vi.fn>;
let mockUserGet: ReturnType<typeof vi.fn>;

vi.mock("@larksuiteoapi/node-sdk", () => {
  mockWSClose = vi.fn();
  mockChatGet = vi.fn().mockResolvedValue({ data: { name: "测试群" } });
  mockUserGet = vi.fn().mockResolvedValue({ data: { user: { name: "张三" } } });
  return {
    EventDispatcher: class {
      private handles: Record<string, Function> = {};
      register(handles: Record<string, Function>) {
        Object.assign(this.handles, handles);
        capturedEventDispatcher = this;
        return this;
      }
      async invoke(eventType: string, data: unknown) {
        const handler = this.handles[eventType];
        if (handler) await handler(data);
      }
    },
    WSClient: class {
      close: any;
      constructor(_params: any) { this.close = mockWSClose; }
      async start(_params: any) {}
    },
    Client: class {
      im = { v1: { chat: { get: mockChatGet } } };
      contact = { v3: { user: { get: mockUserGet } } };
      constructor(_params: any) {}
    },
    LoggerLevel: { info: 3 },
  };
});

function makeMessageEvent(overrides?: {
  chatType?: string;
  messageType?: string;
  content?: string;
  chatId?: string;
  senderId?: string;
}) {
  return {
    sender: {
      sender_id: { open_id: overrides?.senderId ?? "ou_user1" },
      sender_type: "user",
    },
    message: {
      message_id: "msg_001",
      chat_id: overrides?.chatId ?? "oc_chat1",
      chat_type: overrides?.chatType ?? "group",
      message_type: overrides?.messageType ?? "text",
      content: overrides?.content ?? JSON.stringify({ text: "你好" }),
      create_time: "1735689600000",
    },
  };
}

describe("lark connector — 飞书消息监听", () => {
  it("appId / appSecret 为空时跳过", async () => {
    const { ctx, events, logs } = createMockContext();
    conn = larkDescriptor.create(
      { ...larkDescriptor.defaults, appId: "", appSecret: "" },
      ctx,
    );
    await conn.start();
    expect(events).toHaveLength(0);
    expect(logs.some((l) => l.message.includes("missing appId/appSecret"))).toBe(true);
  });

  it("start 后通过 WSClient 建立连接", async () => {
    const { ctx, logs } = createMockContext();
    conn = larkDescriptor.create(
      { ...larkDescriptor.defaults, appId: "id", appSecret: "secret" },
      ctx,
    );
    await conn.start();
    expect(logs.some((l) => l.message.includes("started (WebSocket)"))).toBe(true);
    expect(conn.status()).toMatchObject({ connected: true });
  });

  it("群聊文本消息携带 chat_name 和 sender_name", async () => {
    const { ctx, events } = createMockContext();
    conn = larkDescriptor.create(
      { ...larkDescriptor.defaults, appId: "id", appSecret: "secret" },
      ctx,
    );
    await conn.start();

    await capturedEventDispatcher.invoke(
      "im.message.receive_v1",
      makeMessageEvent(),
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "on_message",
      payload: {
        title: "测试群",
        sub: "张三: 你好",
        chat_name: "测试群",
        sender_name: "张三",
        message_id: "msg_001",
        chat_id: "oc_chat1",
        chat_type: "group",
      },
    });
    expect(mockChatGet).toHaveBeenCalledWith({ path: { chat_id: "oc_chat1" } });
    expect(mockUserGet).toHaveBeenCalledWith({
      path: { user_id: "ou_user1" },
      params: { user_id_type: "open_id" },
    });
  });

  it("单聊不查群名称", async () => {
    const { ctx, events } = createMockContext();
    conn = larkDescriptor.create(
      { ...larkDescriptor.defaults, appId: "id", appSecret: "secret" },
      ctx,
    );
    await conn.start();

    await capturedEventDispatcher.invoke(
      "im.message.receive_v1",
      makeMessageEvent({ chatType: "p2p" }),
    );

    expect(mockChatGet).not.toHaveBeenCalled();
    expect(events[0]?.payload).toMatchObject({
      chat_name: "",
      sender_name: "张三",
    });
  });

  it("同一 chat_id / sender_id 命中缓存不重复请求", async () => {
    const { ctx } = createMockContext();
    conn = larkDescriptor.create(
      { ...larkDescriptor.defaults, appId: "id", appSecret: "secret" },
      ctx,
    );
    await conn.start();

    await capturedEventDispatcher.invoke(
      "im.message.receive_v1",
      makeMessageEvent(),
    );
    await capturedEventDispatcher.invoke(
      "im.message.receive_v1",
      makeMessageEvent(),
    );

    expect(mockChatGet).toHaveBeenCalledTimes(1);
    expect(mockUserGet).toHaveBeenCalledTimes(1);
  });

  it("API 失败时 name 回退为空串，不阻塞事件", async () => {
    mockChatGet.mockRejectedValueOnce(new Error("403"));
    mockUserGet.mockRejectedValueOnce(new Error("403"));
    const { ctx, events } = createMockContext();
    conn = larkDescriptor.create(
      { ...larkDescriptor.defaults, appId: "id", appSecret: "secret" },
      ctx,
    );
    await conn.start();

    await capturedEventDispatcher.invoke(
      "im.message.receive_v1",
      makeMessageEvent(),
    );

    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({
      title: "飞书 · 新消息",
      sub: "你好",
      chat_name: "",
      sender_name: "",
    });
  });

  it("非文本消息 sub 回退为 message_type 标签", async () => {
    const { ctx, events } = createMockContext();
    conn = larkDescriptor.create(
      { ...larkDescriptor.defaults, appId: "id", appSecret: "secret" },
      ctx,
    );
    await conn.start();

    await capturedEventDispatcher.invoke(
      "im.message.receive_v1",
      makeMessageEvent({
        chatType: "p2p",
        messageType: "image",
        content: JSON.stringify({ image_key: "img_xxx" }),
      }),
    );

    expect(events[0]?.payload?.sub).toBe("张三: [image]");
  });

  it("stop 调用 WSClient.close 并清空缓存", async () => {
    const { ctx } = createMockContext();
    conn = larkDescriptor.create(
      { ...larkDescriptor.defaults, appId: "id", appSecret: "secret" },
      ctx,
    );
    await conn.start();

    await capturedEventDispatcher.invoke(
      "im.message.receive_v1",
      makeMessageEvent(),
    );
    expect(mockChatGet).toHaveBeenCalledTimes(1);

    conn.stop();
    expect(mockWSClose).toHaveBeenCalled();
    expect(conn.status()).toMatchObject({ connected: false });

    // restart — cache was cleared so names should be fetched again
    await conn.start();
    await capturedEventDispatcher.invoke(
      "im.message.receive_v1",
      makeMessageEvent(),
    );
    expect(mockChatGet).toHaveBeenCalledTimes(2);
  });

  it("descriptor 中 appSecret 是 secret + taskRequired", () => {
    const sec = larkDescriptor.configSchema.find((f) => f.key === "appSecret");
    expect(sec?.secret).toBe(true);
    expect(sec?.taskRequired).toBe(true);
  });
});
