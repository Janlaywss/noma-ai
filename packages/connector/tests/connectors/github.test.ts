import { describe, it, expect, afterEach } from "vitest";
import { githubDescriptor } from "../../src/app/github.js";
import { createMockContext } from "../helpers/mock-context.js";
import { installFetchMock } from "../helpers/mock-fetch.js";
import type { Connector } from "../../src/types.js";

let conn: Connector | null = null;

// 每个用例结束都得 stop()，否则 setInterval 会让 vitest worker 不退出
afterEach(async () => {
  if (conn) {
    await conn.stop();
    conn = null;
  }
});

const NOTIFICATIONS_URL = "https://api.github.com/notifications";

describe("github connector — GitHub 通知监听", () => {
  it("token 为空时只记 info 不发请求", async () => {
    const fetchMock = installFetchMock([]);
    const { ctx, events, logs } = createMockContext();

    conn = githubDescriptor.create(
      { ...githubDescriptor.defaults, token: "", pollIntervalSec: 60 },
      ctx
    );
    await conn.start();

    expect(events).toHaveLength(0);
    expect(fetchMock.calls()).toHaveLength(0);
    expect(logs.some((l) => l.message.includes("no token configured"))).toBe(true);
  });

  it("首次 poll 为每条通知 emit 一个对应类型的事件", async () => {
    installFetchMock([
      {
        match: NOTIFICATIONS_URL,
        respond: {
          status: 200,
          headers: { "Last-Modified": "Wed, 01 Jan 2025 00:00:00 GMT" },
          json: [
            {
              id: "111",
              reason: "review_requested",
              subject: { type: "PullRequest", title: "Add caching", url: "https://api.github.com/repos/x/y/pulls/1" },
              repository: { full_name: "x/y" },
            },
            {
              id: "222",
              reason: "mention",
              subject: { type: "Issue", title: "Bug found" },
              repository: { full_name: "x/z" },
            },
            {
              id: "333",
              reason: "subscribed",
              subject: { type: "PullRequest", title: "Random update" },
              repository: { full_name: "x/y" },
            },
          ],
        },
      },
    ]);
    const { ctx, events } = createMockContext();
    conn = githubDescriptor.create(
      { ...githubDescriptor.defaults, token: "ghp_test", pollIntervalSec: 60 },
      ctx
    );

    await conn.start();

    // reason → type 映射规则：已知 reason 走专属 case，未知 reason 拼 on_<reason>
    expect(events).toHaveLength(3);
    expect(events[0]?.type).toBe("on_review_requested");
    expect(events[1]?.type).toBe("on_mention");
    expect(events[2]?.type).toBe("on_subscribed");
    expect(events[0]?.payload).toMatchObject({
      title: "PullRequest · Add caching",
      sub: "x/y · review_requested",
      url: "https://api.github.com/repos/x/y/pulls/1",
      thread_id: "111",
    });
  });

  it("请求带上 Authorization 和 Accept 头", async () => {
    const fetchMock = installFetchMock([
      {
        match: NOTIFICATIONS_URL,
        respond: {
          status: 200,
          headers: { "Last-Modified": "Wed, 01 Jan 2025 00:00:00 GMT" },
          json: [],
        },
      },
    ]);
    const { ctx } = createMockContext();
    conn = githubDescriptor.create(
      { ...githubDescriptor.defaults, token: "ghp_secret", pollIntervalSec: 60 },
      ctx
    );

    await conn.start();

    const call = fetchMock.calls()[0];
    expect(call).toBeDefined();
    const headers = (call!.init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer ghp_secret");
    expect(headers.Accept).toBe("application/vnd.github+json");
  });

  it("304 Not Modified 静默处理不告警", async () => {
    // 304 表示没有新通知，正常分支，不应有 warn 日志
    installFetchMock([{ match: NOTIFICATIONS_URL, respond: { status: 304 } }]);
    const { ctx, events, logs } = createMockContext();
    conn = githubDescriptor.create(
      { ...githubDescriptor.defaults, token: "t", pollIntervalSec: 60 },
      ctx
    );

    await conn.start();

    expect(events).toHaveLength(0);
    expect(logs.some((l) => l.level === "warn")).toBe(false);
  });

  it("HTTP 5xx 错误只 warn 不抛", async () => {
    installFetchMock([
      { match: NOTIFICATIONS_URL, respond: { status: 500, body: "boom" } },
    ]);
    const { ctx, events, logs } = createMockContext();
    conn = githubDescriptor.create(
      { ...githubDescriptor.defaults, token: "t", pollIntervalSec: 60 },
      ctx
    );

    // start() 不应该抛错——connector 必须容错
    await expect(conn.start()).resolves.toBeUndefined();
    expect(events).toHaveLength(0);
    expect(logs.some((l) => l.level === "warn" && l.message.includes("HTTP 500"))).toBe(true);
  });

  it("status() 暴露 config 与 lastModified cursor", async () => {
    installFetchMock([
      {
        match: NOTIFICATIONS_URL,
        respond: {
          status: 200,
          headers: { "Last-Modified": "Wed, 01 Jan 2025 00:00:00 GMT" },
          json: [],
        },
      },
    ]);
    const { ctx } = createMockContext();
    conn = githubDescriptor.create(
      { ...githubDescriptor.defaults, token: "t", pollIntervalSec: 60 },
      ctx
    );
    await conn.start();
    const status = conn.status();
    expect(status.pollIntervalSec).toBe(60);
    // cursor 已被本次 poll 推进
    expect(status.lastModified).toBe("Wed, 01 Jan 2025 00:00:00 GMT");
    expect(typeof status.lastPollAt).toBe("number");
  });

  it("updateConfig 能改 pollIntervalSec", async () => {
    installFetchMock([
      { match: NOTIFICATIONS_URL, respond: { status: 200, json: [] } },
    ]);
    const { ctx } = createMockContext();
    conn = githubDescriptor.create(
      { ...githubDescriptor.defaults, token: "t", pollIntervalSec: 60 },
      ctx
    );
    await conn.start();
    conn.updateConfig?.({ pollIntervalSec: 120 });
    expect(conn.status().pollIntervalSec).toBe(120);
  });

  it("descriptor schema 中 token 是 secret + taskRequired", () => {
    // UI 必须把 token 当作可编辑的凭据字段；taskRequired 保证不会被 default 偷偷覆盖
    const tokenField = githubDescriptor.configSchema.find((f) => f.key === "token");
    expect(tokenField?.secret).toBe(true);
    expect(tokenField?.taskRequired).toBe(true);
  });
});
