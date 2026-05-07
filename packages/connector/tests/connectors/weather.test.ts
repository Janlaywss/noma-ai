import { describe, it, expect, afterEach } from "vitest";
import { weatherDescriptor } from "../../src/app/weather.js";
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

const GEO_URL = "geocoding-api.open-meteo.com";
const FORECAST_URL = "api.open-meteo.com/v1/forecast";

const geoResp = {
  results: [{ name: "New York", country: "US", latitude: 40.7, longitude: -74 }],
};

// 构造一个只有一个时间点的 hourly 预报，便于在用例里精确控制阈值
function makeForecast(opts: {
  temp: number;
  precip: number;
  code: number;
  wind: number;
  time?: string;
}) {
  return {
    hourly: {
      time: [opts.time ?? "2025-01-01T12:00"],
      temperature_2m: [opts.temp],
      precipitation: [opts.precip],
      weathercode: [opts.code],
      wind_speed_10m: [opts.wind],
    },
  };
}

describe("weather connector — 天气预警", () => {
  it("country / city 为空时跳过并打 info 日志", async () => {
    installFetchMock([]);
    const { ctx, events, logs } = createMockContext();
    conn = weatherDescriptor.create(
      { ...weatherDescriptor.defaults, country: "", city: "", pollIntervalSec: 60 },
      ctx
    );
    await conn.start();
    expect(events).toHaveLength(0);
    expect(logs.some((l) => l.message.includes("missing country/city"))).toBe(true);
  });

  it("预报超过阈值时触发 weather_alert", async () => {
    // 12mm/h 降水 + 强对流天气码 65 → 触发告警
    installFetchMock([
      { match: GEO_URL, respond: { json: geoResp } },
      {
        match: FORECAST_URL,
        respond: { json: makeForecast({ temp: 22, precip: 12, code: 65, wind: 30 }) },
      },
    ]);
    const { ctx, events } = createMockContext();
    conn = weatherDescriptor.create(
      { ...weatherDescriptor.defaults, country: "US", city: "New York", pollIntervalSec: 60 },
      ctx
    );

    await conn.start();

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("weather_alert");
    expect(events[0]?.payload).toMatchObject({
      country: "US",
      city: "New York",
      precipitation: 12,
      temperature: 22,
      wind: 30,
      code: 65,
    });
  });

  it("天气温和时不 emit", async () => {
    // 阈值条件：precip<5 / wind<50 / -10<temp<35 / code<71 → 全部满足，温和
    installFetchMock([
      { match: GEO_URL, respond: { json: geoResp } },
      {
        match: FORECAST_URL,
        respond: { json: makeForecast({ temp: 20, precip: 0, code: 1, wind: 10 }) },
      },
    ]);
    const { ctx, events } = createMockContext();
    conn = weatherDescriptor.create(
      { ...weatherDescriptor.defaults, country: "US", city: "New York", pollIntervalSec: 60 },
      ctx
    );

    await conn.start();
    expect(events).toHaveLength(0);
  });

  it("emit 后会记录 alert signature 用于后续去重", async () => {
    installFetchMock([
      { match: GEO_URL, respond: { json: geoResp } },
      {
        match: FORECAST_URL,
        respond: { json: makeForecast({ temp: -15, precip: 0, code: 75, wind: 20 }) },
      },
    ]);
    const { ctx, events } = createMockContext();
    conn = weatherDescriptor.create(
      { ...weatherDescriptor.defaults, country: "US", city: "New York", pollIntervalSec: 60 },
      ctx
    );

    await conn.start();
    expect(events).toHaveLength(1);
    // status 中的 lastAlertSig 是后续轮询去重的依据
    const status = conn.status();
    expect(status.lastAlertSig).toBeTruthy();
  });

  it("geocoding 无匹配时只 warn 不 emit", async () => {
    installFetchMock([
      { match: GEO_URL, respond: { json: { results: [] } } },
    ]);
    const { ctx, events, logs } = createMockContext();
    conn = weatherDescriptor.create(
      { ...weatherDescriptor.defaults, country: "ZZ", city: "Nowhere", pollIntervalSec: 60 },
      ctx
    );
    await conn.start();
    expect(events).toHaveLength(0);
    expect(logs.some((l) => l.message.includes("no geo match"))).toBe(true);
  });

  it("forecast HTTP 错误不抛出", async () => {
    installFetchMock([
      { match: GEO_URL, respond: { json: geoResp } },
      { match: FORECAST_URL, respond: { status: 502, body: "" } },
    ]);
    const { ctx, events, logs } = createMockContext();
    conn = weatherDescriptor.create(
      { ...weatherDescriptor.defaults, country: "US", city: "New York", pollIntervalSec: 60 },
      ctx
    );
    await expect(conn.start()).resolves.toBeUndefined();
    expect(events).toHaveLength(0);
    expect(logs.some((l) => l.message.includes("forecast HTTP 502"))).toBe(true);
  });

  it("status() 暴露 lat / lon / 城市信息", async () => {
    installFetchMock([
      { match: GEO_URL, respond: { json: geoResp } },
      {
        match: FORECAST_URL,
        respond: { json: makeForecast({ temp: 20, precip: 0, code: 1, wind: 10 }) },
      },
    ]);
    const { ctx } = createMockContext();
    conn = weatherDescriptor.create(
      { ...weatherDescriptor.defaults, country: "US", city: "New York", pollIntervalSec: 60 },
      ctx
    );
    await conn.start();
    const status = conn.status();
    // geo 缓存在内存里，下次 poll 不会重复请求
    expect(status.lat).toBe(40.7);
    expect(status.lon).toBe(-74);
    expect(status.city).toBe("New York");
  });
});
