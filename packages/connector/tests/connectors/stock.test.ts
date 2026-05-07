import { describe, it, expect, afterEach } from "vitest";
import { stockDescriptor } from "../../src/app/stock.js";
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

// Yahoo Finance v8/chart 接口的最小 mock 响应
function yahooQuote(symbol: string, price: number, prevClose: number) {
  return {
    chart: {
      result: [
        {
          meta: {
            symbol,
            shortName: `${symbol} Inc`,
            regularMarketPrice: price,
            chartPreviousClose: prevClose,
          },
        },
      ],
      error: null,
    },
  };
}

// Finnhub /quote 接口的 mock 响应
function finnhubQuote(price: number, prevClose: number) {
  return { c: price, pc: prevClose, dp: ((price - prevClose) / prevClose) * 100, t: 1700000000 };
}

describe("stock connector — 美股价格异动", () => {
  it("没有 symbols 时跳过", async () => {
    installFetchMock([]);
    const { ctx, events, logs } = createMockContext();
    conn = stockDescriptor.create(
      { ...stockDescriptor.defaults, symbols: [], pollIntervalSec: 60, threshold: 3 },
      ctx
    );
    await conn.start();
    expect(events).toHaveLength(0);
    expect(logs.some((l) => l.message.includes("no symbols configured"))).toBe(true);
  });

  it("symbol 涨跌幅超过 threshold 时 emit price_move", async () => {
    // 200 vs 190 ≈ +5.26%，threshold=3 → 触发
    installFetchMock([
      { match: /AAPL/, respond: { json: yahooQuote("AAPL", 200, 190) } },
    ]);
    const { ctx, events } = createMockContext();
    conn = stockDescriptor.create(
      { ...stockDescriptor.defaults, symbols: ["AAPL"], threshold: 3, pollIntervalSec: 60 },
      ctx
    );

    await conn.start();
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("price_move");
    expect(events[0]?.payload).toMatchObject({ symbol: "AAPL", price: 200 });
    const pct = events[0]?.payload?.pct as number;
    expect(pct).toBeGreaterThan(5);
    expect(pct).toBeLessThan(6);
  });

  it("低于 threshold 不 emit", async () => {
    installFetchMock([
      { match: /AAPL/, respond: { json: yahooQuote("AAPL", 191, 190) } }, // ~0.5%
    ]);
    const { ctx, events } = createMockContext();
    conn = stockDescriptor.create(
      { ...stockDescriptor.defaults, symbols: ["AAPL"], threshold: 3, pollIntervalSec: 60 },
      ctx
    );

    await conn.start();
    expect(events).toHaveLength(0);
  });

  it("Stooq 和 query1 都失败时 fallback 到 query2", async () => {
    // 完整降级链：Stooq 失败 → Yahoo query1 失败 → query2 成功
    const fetchMock = installFetchMock([
      { match: (url) => url.includes("stooq.com"), respond: { status: 503, body: "" } },
      { match: (url) => url.includes("query1.finance.yahoo.com"), respond: { status: 500, body: "fail" } },
      { match: (url) => url.includes("query2.finance.yahoo.com"), respond: { json: yahooQuote("NVDA", 100, 90) } },
    ]);
    const { ctx, events } = createMockContext();
    conn = stockDescriptor.create(
      { ...stockDescriptor.defaults, symbols: ["NVDA"], threshold: 3, pollIntervalSec: 60 },
      ctx
    );

    await conn.start();

    // stooq 失败、query1 失败、query2 成功
    expect(fetchMock.calls()).toHaveLength(3);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload?.symbol).toBe("NVDA");
  });

  it("所有数据源都失败时不 emit", async () => {
    installFetchMock([
      { match: (url) => url.includes("stooq.com"), respond: { status: 500, body: "" } },
      { match: (url) => url.includes("yahoo.com"), respond: { status: 500, body: "fail" } },
    ]);
    const { ctx, events, logs } = createMockContext();
    conn = stockDescriptor.create(
      { ...stockDescriptor.defaults, symbols: ["AAPL"], threshold: 3, pollIntervalSec: 60 },
      ctx
    );

    await conn.start();
    expect(events).toHaveLength(0);
    expect(logs.some((l) => l.message.includes("HTTP 500"))).toBe(true);
  });

  it("配置 finnhubKey 时优先走 Finnhub", async () => {
    const fetchMock = installFetchMock([
      {
        match: (url) => url.includes("finnhub.io"),
        respond: { json: finnhubQuote(200, 190) }, // +5.26%
      },
    ]);
    const { ctx, events } = createMockContext();
    conn = stockDescriptor.create(
      { ...stockDescriptor.defaults, symbols: ["AAPL"], threshold: 3, pollIntervalSec: 60, finnhubKey: "test_key" },
      ctx
    );

    await conn.start();

    // 只调了 Finnhub，没走 Yahoo
    expect(fetchMock.calls().every((c) => c.url.includes("finnhub.io"))).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload?.symbol).toBe("AAPL");
  });

  it("Finnhub 失败时降级到 Yahoo", async () => {
    const fetchMock = installFetchMock([
      { match: (url) => url.includes("finnhub.io"), respond: { status: 429, body: "" } },
      { match: /AAPL/, respond: { json: yahooQuote("AAPL", 200, 190) } },
    ]);
    const { ctx, events } = createMockContext();
    conn = stockDescriptor.create(
      { ...stockDescriptor.defaults, symbols: ["AAPL"], threshold: 3, pollIntervalSec: 60, finnhubKey: "test_key" },
      ctx
    );

    await conn.start();

    // Finnhub 429 → 降级到 Yahoo 成功
    const urls = fetchMock.calls().map((c) => c.url);
    expect(urls.some((u) => u.includes("finnhub.io"))).toBe(true);
    expect(urls.some((u) => u.includes("yahoo.com"))).toBe(true);
    expect(events).toHaveLength(1);
  });

  it("Finnhub 返回 t=0 时视为无数据，降级到 Stooq", async () => {
    // t=0 表示 symbol 不存在或无交易数据
    installFetchMock([
      { match: (url) => url.includes("finnhub.io"), respond: { json: { c: 0, pc: 0, dp: 0, t: 0 } } },
      {
        match: (url) => url.includes("stooq.com"),
        respond: { body: "Symbol,Date,Time,Open,High,Low,Close,Volume\nNVDA.US,2025-05-05,16:00:00,90,105,89,100,50000000" },
      },
    ]);
    const { ctx, events } = createMockContext();
    conn = stockDescriptor.create(
      { ...stockDescriptor.defaults, symbols: ["NVDA"], threshold: 3, pollIntervalSec: 60, finnhubKey: "k" },
      ctx
    );

    await conn.start();
    expect(events).toHaveLength(1);
    expect(events[0]?.payload?.symbol).toBe("NVDA");
    // (100 - 90) / 90 ≈ 11.11%
    expect(events[0]?.payload?.pct).toBeCloseTo(11.11, 1);
  });

  it("无 finnhubKey 时优先走 Stooq，成功则不请求 Yahoo", async () => {
    const fetchMock = installFetchMock([
      {
        match: (url) => url.includes("stooq.com"),
        respond: { body: "Symbol,Date,Time,Open,High,Low,Close,Volume\nAAPL.US,2025-05-05,16:00:00,190,202,189,200,80000000" },
      },
    ]);
    const { ctx, events } = createMockContext();
    conn = stockDescriptor.create(
      { ...stockDescriptor.defaults, symbols: ["AAPL"], threshold: 3, pollIntervalSec: 60 },
      ctx
    );

    await conn.start();
    // Stooq 成功，不走 Yahoo
    expect(fetchMock.calls().every((c) => c.url.includes("stooq.com"))).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload?.price).toBe(200);
  });

  it("Stooq 返回无效数据时降级到 Yahoo", async () => {
    installFetchMock([
      { match: (url) => url.includes("stooq.com"), respond: { body: "Symbol,Date,Time,Open,High,Low,Close,Volume\nAAPL.US,N/D,N/D,N/D,N/D,N/D,N/D,N/D" } },
      { match: /AAPL/, respond: { json: yahooQuote("AAPL", 200, 190) } },
    ]);
    const { ctx, events } = createMockContext();
    conn = stockDescriptor.create(
      { ...stockDescriptor.defaults, symbols: ["AAPL"], threshold: 3, pollIntervalSec: 60 },
      ctx
    );

    await conn.start();
    expect(events).toHaveLength(1);
    expect(events[0]?.payload?.symbol).toBe("AAPL");
  });

  it("updateConfig 时清理被移除 symbol 的 alerted 状态", async () => {
    installFetchMock([
      { match: /AAPL/, respond: { json: yahooQuote("AAPL", 200, 190) } },
      { match: /NVDA/, respond: { json: yahooQuote("NVDA", 100, 90) } },
    ]);
    const { ctx, events } = createMockContext();
    conn = stockDescriptor.create(
      { ...stockDescriptor.defaults, symbols: ["AAPL", "NVDA"], threshold: 3, pollIntervalSec: 60 },
      ctx
    );

    await conn.start();
    expect(events).toHaveLength(2);
    expect(conn.status().alertedCount).toBe(2);

    // NVDA 被移除，对应的 alertedAt 也得清掉，避免下次重新加入时被错误压制
    conn.updateConfig?.({ symbols: ["AAPL"], threshold: 3, pollIntervalSec: 60 });
    expect(conn.status().alertedCount).toBe(1);
    expect(conn.status().symbols).toEqual(["AAPL"]);
  });

  it("finnhubKey 在 schema 中标记为 secret", () => {
    const f = stockDescriptor.configSchema.find((f) => f.key === "finnhubKey");
    expect(f?.secret).toBe(true);
    expect(f?.type).toBe("string");
  });
});
