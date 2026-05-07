import { describe, it, expect, afterEach, vi } from "vitest";
import { flightDescriptor } from "../../src/app/flight.js";
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

const STATES_URL = "opensky-network.org/api/states/all";

// OpenSky state vector 的字段顺序：
//   1=callsign, 2=origin_country, 3=time_position,
//   5=longitude, 6=latitude, 7=baro_altitude,
//   8=on_ground, 9=velocity, 13=geo_altitude
function stateVector(opts: {
  callsign: string;
  lon: number;
  lat: number;
  onGround: boolean;
  alt?: number;
}): unknown[] {
  const v: unknown[] = new Array(17).fill(null);
  v[1] = opts.callsign;
  v[2] = "United States";
  v[3] = Date.now() / 1000;
  v[5] = opts.lon;
  v[6] = opts.lat;
  v[7] = opts.alt ?? 10000;
  v[8] = opts.onGround;
  v[9] = 250;
  v[13] = opts.alt ?? 10500;
  return v;
}

describe("flight connector — 航班轨迹", () => {
  it("flightNumber 为空时跳过", async () => {
    installFetchMock([]);
    const { ctx, events, logs } = createMockContext();
    conn = flightDescriptor.create(
      { ...flightDescriptor.defaults, flightNumber: "", pollIntervalSec: 60 },
      ctx
    );
    await conn.start();
    expect(events).toHaveLength(0);
    expect(logs.some((l) => l.message.includes("no flightNumber"))).toBe(true);
  });

  it("首次 poll 只存快照不 emit（无对比基准）", async () => {
    installFetchMock([
      {
        match: STATES_URL,
        respond: {
          json: {
            time: Math.floor(Date.now() / 1000),
            states: [
              stateVector({ callsign: "UA123", lon: -73, lat: 40, onGround: true }),
            ],
          },
        },
      },
    ]);
    const { ctx, events } = createMockContext();
    conn = flightDescriptor.create(
      { ...flightDescriptor.defaults, flightNumber: "UA123", pollIntervalSec: 60 },
      ctx
    );
    await conn.start();
    expect(events).toHaveLength(0);
    const snap = (conn.status().snapshot as { onGround: boolean } | null) ?? null;
    expect(snap?.onGround).toBe(true);
  });

  it("起飞（onGround 翻转）时 emit flight_change", async () => {
    const fetchMock = installFetchMock([
      {
        match: STATES_URL,
        respond: {
          json: {
            time: 1,
            states: [
              stateVector({ callsign: "UA123", lon: -73, lat: 40, onGround: true }),
            ],
          },
        },
      },
    ]);
    vi.useFakeTimers();
    const { ctx, events } = createMockContext();
    conn = flightDescriptor.create(
      { ...flightDescriptor.defaults, flightNumber: "UA123", pollIntervalSec: 60 },
      ctx
    );
    await conn.start();

    // 第二次 poll：onGround 由 true → false，触发 takeoff
    fetchMock.setHandlers([
      {
        match: STATES_URL,
        respond: {
          json: {
            time: 2,
            states: [
              stateVector({ callsign: "UA123", lon: -73, lat: 40, onGround: false }),
            ],
          },
        },
      },
    ]);
    await vi.advanceTimersByTimeAsync(60 * 1000);

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("flight_change");
    const changes = events[0]?.payload?.changes as Array<{ label: string }>;
    expect(changes[0]?.label).toBe("takeoff");
  });

  it("位置漂移 ≥ 50km 时 emit flight_change", async () => {
    const fetchMock = installFetchMock([
      {
        match: STATES_URL,
        respond: {
          json: {
            time: 1,
            states: [
              stateVector({ callsign: "UA123", lon: -74, lat: 40, onGround: false }),
            ],
          },
        },
      },
    ]);
    vi.useFakeTimers();
    const { ctx, events } = createMockContext();
    conn = flightDescriptor.create(
      { ...flightDescriptor.defaults, flightNumber: "UA123", pollIntervalSec: 60 },
      ctx
    );
    await conn.start();

    // 纬度差 1° ≈ 111km，远超 50km 阈值
    fetchMock.setHandlers([
      {
        match: STATES_URL,
        respond: {
          json: {
            time: 2,
            states: [
              stateVector({ callsign: "UA123", lon: -74, lat: 41, onGround: false }),
            ],
          },
        },
      },
    ]);
    await vi.advanceTimersByTimeAsync(60 * 1000);

    expect(events).toHaveLength(1);
    const changes = events[0]?.payload?.changes as Array<{ label: string }>;
    expect(changes[0]?.label).toMatch(/^position \+\d+km$/);
  });

  it("callsign 用 suffix 匹配（UAL123 命中 flightNumber=123）", async () => {
    // 民航的 callsign 通常是「公司前缀 + 航班号」，匹配时只看尾部
    installFetchMock([
      {
        match: STATES_URL,
        respond: {
          json: {
            time: 1,
            states: [
              stateVector({ callsign: "UAL123", lon: -74, lat: 40, onGround: false }),
            ],
          },
        },
      },
    ]);
    const { ctx } = createMockContext();
    conn = flightDescriptor.create(
      { ...flightDescriptor.defaults, flightNumber: "123", pollIntervalSec: 60 },
      ctx
    );
    await conn.start();
    const snap = conn.status().snapshot as { callsign: string } | null;
    expect(snap?.callsign).toBe("UAL123");
  });

  it("HTTP 错误只 warn 不抛", async () => {
    installFetchMock([
      { match: STATES_URL, respond: { status: 503, body: "" } },
    ]);
    const { ctx, events, logs } = createMockContext();
    conn = flightDescriptor.create(
      { ...flightDescriptor.defaults, flightNumber: "UA123", pollIntervalSec: 60 },
      ctx
    );
    await expect(conn.start()).resolves.toBeUndefined();
    expect(events).toHaveLength(0);
    expect(logs.some((l) => l.message.includes("HTTP 503"))).toBe(true);
  });
});
