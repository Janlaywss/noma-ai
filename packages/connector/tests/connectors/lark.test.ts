import { describe, it, expect, afterEach, vi } from "vitest";
import { larkDescriptor } from "../../src/app/lark.js";
import { createMockContext } from "../helpers/mock-context.js";
import type { Connector } from "../../src/types.js";

let conn: Connector | null = null;

const mocks = vi.hoisted(() => ({
  wsClose: vi.fn(),
  chatGet: vi.fn(async () => ({ data: { name: "测试群" } })),
  userGet: vi.fn(async () => ({ data: { user: { name: "张三" } } })),
}));

let capturedEventDispatcher: any = null;

vi.mock("@larksuiteoapi/node-sdk", () => ({
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
    constructor(_params: any) { this.close = mocks.wsClose; }
    async start(_params: any) {}
  },
  Client: class {
    im = { v1: { chat: { get: mocks.chatGet } } };
    contact = { v3: { user: { get: mocks.userGet } } };
    constructor(_params: any) {}
  },
  LoggerLevel: { info: 3 },
}));

afterEach(async () => {
  if (conn) {
    await conn.stop();
    conn = null;
  }
  mocks.chatGet.mockClear();
  mocks.userGet.mockClear();
  mocks.wsClose.mockClear();
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
    expect(mocks.chatGet).toHaveBeenCalledWith({ path: { chat_id: "oc_chat1" } });
    expect(mocks.userGet).toHaveBeenCalledWith({
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

    expect(mocks.chatGet).not.toHaveBeenCalled();
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

    expect(mocks.chatGet).toHaveBeenCalledTimes(1);
    expect(mocks.userGet).toHaveBeenCalledTimes(1);
  });

  it("API 失败时 name 回退为空串，不阻塞事件", async () => {
    mocks.chatGet.mockRejectedValueOnce(new Error("403"));
    mocks.userGet.mockRejectedValueOnce(new Error("403"));
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
    expect(mocks.chatGet).toHaveBeenCalledTimes(1);

    conn.stop();
    expect(mocks.wsClose).toHaveBeenCalled();
    expect(conn.status()).toMatchObject({ connected: false });

    // restart — cache was cleared so names should be fetched again
    await conn.start();
    await capturedEventDispatcher.invoke(
      "im.message.receive_v1",
      makeMessageEvent(),
    );
    expect(mocks.chatGet).toHaveBeenCalledTimes(2);
  });

  it("descriptor 中 appSecret 是 secret + taskRequired", () => {
    const sec = larkDescriptor.configSchema.find((f) => f.key === "appSecret");
    expect(sec?.secret).toBe(true);
    expect(sec?.taskRequired).toBe(true);
  });
});
