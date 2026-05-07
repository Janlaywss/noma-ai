import type { Connector, ConnectorContext, ConnectorDescriptor } from "../types.js";

/**
 * Flight watcher. Each instance follows ONE configured flight number on
 * OpenSky's anonymous ADS-B feed; emits `flight_change` on takeoff,
 * landing, or large positional drift from the last seen snapshot.
 */

interface FlightConfig extends Record<string, unknown> {
  flightNumber: string;
  pollIntervalSec: number;
}

interface FlightSnapshot {
  callsign: string | null;
  originCountry: string | null;
  longitude: number | null;
  latitude: number | null;
  baroAltitude: number | null;
  onGround: boolean | null;
  velocity: number | null;
  geoAltitude: number | null;
  timePosition: number | null;
}

const POSITION_DELTA_KM = 50;

function haversineKm(
  lat1: number | null,
  lon1: number | null,
  lat2: number | null,
  lon2: number | null
): number | null {
  if (lat1 === null || lon1 === null || lat2 === null || lon2 === null) {
    return null;
  }
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

function diffSnapshot(
  prev: FlightSnapshot,
  next: FlightSnapshot
): Array<{ label: string; from: unknown; to: unknown }> {
  const out: Array<{ label: string; from: unknown; to: unknown }> = [];
  if (prev.onGround !== next.onGround) {
    out.push({
      label:
        prev.onGround === true && next.onGround === false
          ? "takeoff"
          : prev.onGround === false && next.onGround === true
            ? "landing"
            : "ground state",
      from: prev.onGround,
      to: next.onGround,
    });
  }
  const moved = haversineKm(
    prev.latitude,
    prev.longitude,
    next.latitude,
    next.longitude
  );
  if (moved !== null && moved >= POSITION_DELTA_KM) {
    out.push({
      label: `position +${Math.round(moved)}km`,
      from: { lat: prev.latitude, lon: prev.longitude },
      to: { lat: next.latitude, lon: next.longitude },
    });
  }
  return out;
}

function createFlightConnector(cfg: FlightConfig, ctx: ConnectorContext): Connector {
  let pollIntervalSec = Math.max(60, Number(cfg.pollIntervalSec) || 600);
  const flightNumber = String(cfg.flightNumber ?? "")
    .trim()
    .toUpperCase();
  let timer: NodeJS.Timeout | null = null;
  let running = false;
  let prev: FlightSnapshot | null = null;
  let lastPollAt: number | null = null;

  const poll = async () => {
    if (running) return;
    running = true;
    try {
      if (!flightNumber) {
        ctx.log("info", "  flight: no flightNumber configured — skip");
        return;
      }
      const res = await fetch("https://opensky-network.org/api/states/all");
      lastPollAt = Date.now();
      if (!res.ok) {
        ctx.log("warn", `  flight: HTTP ${res.status}`);
        return;
      }
      const body = (await res.json()) as {
        time: number;
        states?: Array<unknown[]> | null;
      };
      const states = body.states ?? [];
      const match = states.find((s) => {
        const cs = String(s[1] ?? "")
          .trim()
          .replace(/\s+/g, "")
          .toUpperCase();
        return cs === flightNumber || cs.endsWith(flightNumber);
      });
      if (!match) return;
      const snapshot: FlightSnapshot = {
        callsign: String(match[1] ?? "").trim() || null,
        originCountry: typeof match[2] === "string" ? match[2] : null,
        longitude: typeof match[5] === "number" ? match[5] : null,
        latitude: typeof match[6] === "number" ? match[6] : null,
        baroAltitude: typeof match[7] === "number" ? match[7] : null,
        onGround: typeof match[8] === "boolean" ? match[8] : null,
        velocity: typeof match[9] === "number" ? match[9] : null,
        geoAltitude: typeof match[13] === "number" ? match[13] : null,
        timePosition: typeof match[3] === "number" ? match[3] : null,
      };
      if (!prev) {
        prev = snapshot;
        return;
      }
      const changes = diffSnapshot(prev, snapshot);
      if (changes.length > 0) {
        ctx.emitEvent({
          type: "flight_change",
          payload: {
            title: `${flightNumber} · ${changes.map((c) => c.label).join(", ")}`,
            sub: snapshot.onGround
              ? `on ground · ${snapshot.originCountry ?? "?"}`
              : `airborne · ${Math.round(snapshot.geoAltitude ?? 0)}m`,
            flight: flightNumber,
            changes,
            snapshot,
          },
        });
      }
      prev = snapshot;
    } catch (err) {
      ctx.log(
        "warn",
        `  flight: poll failed — ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      running = false;
    }
  };

  return {
    async start() {
      ctx.log(
        "info",
        `flight: started (${flightNumber}, every ${pollIntervalSec}s)`
      );
      await poll();
      timer = setInterval(() => void poll(), pollIntervalSec * 1000);
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      ctx.log("info", "flight: stopped");
    },
    status() {
      return { pollIntervalSec, flightNumber, lastPollAt, snapshot: prev };
    },
    updateConfig(cfg: Record<string, unknown>) {
      const newInterval = Math.max(60, Number(cfg.pollIntervalSec) || 600);
      if (newInterval !== pollIntervalSec) {
        pollIntervalSec = newInterval;
        if (timer) {
          clearInterval(timer);
          timer = setInterval(() => void poll(), pollIntervalSec * 1000);
        }
      }
      ctx.log(
        "info",
        `flight: config updated (${flightNumber}, every ${pollIntervalSec}s)`
      );
    },
  };
}

export const flightDescriptor: ConnectorDescriptor<FlightConfig> = {
  name: "flight",
  label: "Flight",
  description: "按航班号通过 OpenSky 公开 ADS-B 数据跟踪一趟航班，起飞/降落/位置明显变化时通知。",
  configSchema: [
    { key: "flightNumber", type: "string", taskRequired: true },
    { key: "pollIntervalSec", type: "number", min: 60 },
  ],
  defaults: { flightNumber: "", pollIntervalSec: 600 },
  create: createFlightConnector,
};
