import { describe, it, expect, afterEach, vi } from "vitest";
import { jin10Descriptor } from "../../src/app/jin10.js";
import { createMockContext } from "../helpers/mock-context.js";
import { installFetchMock } from "../helpers/mock-fetch.js";
import type { Connector } from "../../src/types.js";

let conn: Connector | null = null;

afterEach(async () => {
  if (conn) {
    await conn.stop();
    conn = null;
  }
  vi.useRealTimers();
});

const ENDPOINT = "jin10.com/flash_newest";

// 把一组快讯包装成金十的 JSONP 格式（`var newest = [...];`）
function flashJs(items: Array<{ id: string; content: string; time?: string }>) {
  const arr = items.map((it) => ({
    id: it.id,
    time: it.time ?? "2025-01-01 00:00:00",
    type: 1,
    data: { content: it.content },
  }));
  return `var newest = ${JSON.stringify(arr)};`;
}

describe("jin10 connector — 金十快讯", () => {
  it("首次 poll 只 prime seen 集合，不 emit（避免开机灌历史）", async () => {
    installFetchMock([
      {
        match: ENDPOINT,
        respond: {
          headers: { "content-type": "application/javascript" },
          body: flashJs([
            { id: "a", content: "old news 1" },
            { id: "b", content: "old news 2" },
          ]),
        },
      },
    ]);
    const { ctx, events } = createMockContext();
    conn = jin10Descriptor.create(
      { ...jin10Descriptor.defaults, pollIntervalSec: 30 },
      ctx
    );
    await conn.start();
    expect(events).toHaveLength(0);
    const status = conn.status();
    expect(status.primed).toBe(true);
    expect(status.seenCount).toBe(2);
  });

  it("第二次 poll 按时间从旧到新 emit 新条目", async () => {
    const fetchMock = installFetchMock([
      {
        match: ENDPOINT,
        respond: {
          headers: { "content-type": "application/javascript" },
          body: flashJs([{ id: "a", content: "old" }]),
        },
      },
    ]);

    // 用 fake timers 让我们能精确触发 setInterval 的第二次回调
    vi.useFakeTimers();
    const { ctx, events } = createMockContext();
    conn = jin10Descriptor.create(
      { ...jin10Descriptor.defaults, pollIntervalSec: 30 },
      ctx
    );
    await conn.start();
    expect(events).toHaveLength(0);

    // 切换 mock：返回 newest-first 的 feed（c 最新，a 已 seen）
    fetchMock.setHandlers([
      {
        match: ENDPOINT,
        respond: {
          headers: { "content-type": "application/javascript" },
          body: flashJs([
            { id: "c", content: "<b>news C</b>" }, // 最新
            { id: "b", content: "news B" },
            { id: "a", content: "old" }, // 已 seen
          ]),
        },
      },
    ]);

    await vi.advanceTimersByTimeAsync(30 * 1000);

    // emit 顺序应是「从旧到新」：先 b 后 c
    expect(events).toHaveLength(2);
    expect(events[0]?.payload?.id).toBe("b");
    expect(events[1]?.payload?.id).toBe("c");
    // HTML 标签会被 strip 掉
    expect(events[1]?.payload?.content).toBe("news C");
  });

  it("summary 为空的条目跳过", async () => {
    installFetchMock([
      {
        match: ENDPOINT,
        respond: {
          headers: { "content-type": "application/javascript" },
          body: `var newest = [{ "id": "x", "data": { "content": "" } }];`,
        },
      },
    ]);
    const { ctx, events } = createMockContext();
    conn = jin10Descriptor.create(
      { ...jin10Descriptor.defaults, pollIntervalSec: 30 },
      ctx
    );
    await conn.start(); // 首次 poll：priming，本身就不 emit

    expect(events).toHaveLength(0);
  });

  it("HTTP 错误只 warn 不抛", async () => {
    installFetchMock([{ match: ENDPOINT, respond: { status: 500, body: "" } }]);
    const { ctx, events, logs } = createMockContext();
    conn = jin10Descriptor.create(
      { ...jin10Descriptor.defaults, pollIntervalSec: 30 },
      ctx
    );
    await expect(conn.start()).resolves.toBeUndefined();
    expect(events).toHaveLength(0);
    expect(logs.some((l) => l.message.includes("HTTP 500"))).toBe(true);
  });
});
