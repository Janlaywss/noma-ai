import type { Connector, ConnectorContext, ConnectorDescriptor } from "../types.js";

/**
 * Weather watcher. Each instance polls Open-Meteo for one (country, city)
 * pair (and optional target datetime), and emits `weather_alert` when the
 * forecast crosses thresholds for heavy rain/snow, high winds, or extreme
 * temperatures. No API key.
 */

interface WeatherConfig extends Record<string, unknown> {
  country: string;
  city: string;
  datetime: string;
  pollIntervalSec: number;
}

interface GeoResult {
  name: string;
  country: string;
  latitude: number;
  longitude: number;
}

interface Forecast {
  hourly?: {
    time: string[];
    temperature_2m: number[];
    precipitation: number[];
    weathercode: number[];
    wind_speed_10m: number[];
  };
}

function describeCode(code: number): string {
  if (code === 0) return "Clear";
  if (code <= 3) return "Partly cloudy";
  if (code <= 48) return "Fog";
  if (code <= 67) return "Rain";
  if (code <= 77) return "Snow";
  if (code <= 82) return "Showers";
  if (code <= 99) return "Thunderstorm";
  return `Code ${code}`;
}

function createWeatherConnector(cfg: WeatherConfig, ctx: ConnectorContext): Connector {
  let pollIntervalSec = Math.max(60, Number(cfg.pollIntervalSec) || 1800);
  const country = String(cfg.country ?? "").trim();
  const city = String(cfg.city ?? "").trim();
  const datetime = String(cfg.datetime ?? "").trim();
  let timer: NodeJS.Timeout | null = null;
  let running = false;
  let lat: number | null = null;
  let lon: number | null = null;
  let lastAlertSig: string | null = null;
  let lastPollAt: number | null = null;

  const ensureGeo = async (): Promise<boolean> => {
    if (lat !== null && lon !== null) return true;
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=5&language=en&format=json`;
    const res = await fetch(url);
    if (!res.ok) {
      ctx.log("warn", `  weather: geo HTTP ${res.status}`);
      return false;
    }
    const body = (await res.json()) as { results?: GeoResult[] };
    const match =
      body.results?.find(
        (r) => r.country.toLowerCase() === country.toLowerCase()
      ) ?? body.results?.[0];
    if (!match) {
      ctx.log("warn", `  weather: no geo match for ${city}, ${country}`);
      return false;
    }
    lat = match.latitude;
    lon = match.longitude;
    return true;
  };

  const poll = async () => {
    if (running) return;
    running = true;
    try {
      if (!country || !city) {
        ctx.log("info", "  weather: missing country/city — skip");
        return;
      }
      if (!(await ensureGeo())) return;
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=temperature_2m,precipitation,weathercode,wind_speed_10m&forecast_days=3`;
      const res = await fetch(url);
      lastPollAt = Date.now();
      if (!res.ok) {
        ctx.log("warn", `  weather: forecast HTTP ${res.status}`);
        return;
      }
      const fc = (await res.json()) as Forecast;
      const h = fc.hourly;
      if (!h || h.time.length === 0) return;

      let idx = 0;
      if (datetime) {
        const target = new Date(datetime).getTime();
        if (!Number.isNaN(target)) {
          let bestDelta = Number.POSITIVE_INFINITY;
          for (let i = 0; i < h.time.length; i++) {
            const d = Math.abs(new Date(h.time[i]).getTime() - target);
            if (d < bestDelta) {
              bestDelta = d;
              idx = i;
            }
          }
        }
      }
      const temp = h.temperature_2m[idx];
      const precip = h.precipitation[idx];
      const code = h.weathercode[idx];
      const wind = h.wind_speed_10m[idx];
      const at = h.time[idx];

      const noteworthy =
        precip >= 5 || wind >= 50 || temp >= 35 || temp <= -10 || code >= 71;
      const sig = `${at}|${noteworthy ? "alert" : "clear"}|${code}`;
      if (noteworthy && sig !== lastAlertSig) {
        ctx.emitEvent({
          type: "weather_alert",
          payload: {
            title: `${city} ${at.replace("T", " ")} · ${describeCode(code)}`,
            sub: `${temp}°C · ${precip}mm precip · ${wind}km/h wind`,
            country,
            city,
            datetime: at,
            temperature: temp,
            precipitation: precip,
            wind,
            code,
          },
        });
        lastAlertSig = sig;
      } else if (!noteworthy) {
        lastAlertSig = sig;
      }
    } catch (err) {
      ctx.log(
        "warn",
        `  weather: poll failed — ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      running = false;
    }
  };

  return {
    async start() {
      ctx.log(
        "info",
        `weather: started (${city}, ${country}, every ${pollIntervalSec}s)`
      );
      await poll();
      timer = setInterval(() => void poll(), pollIntervalSec * 1000);
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      ctx.log("info", "weather: stopped");
    },
    status() {
      return { pollIntervalSec, country, city, datetime, lat, lon, lastAlertSig, lastPollAt };
    },
    updateConfig(cfg: Record<string, unknown>) {
      const newInterval = Math.max(60, Number(cfg.pollIntervalSec) || 1800);
      if (newInterval !== pollIntervalSec) {
        pollIntervalSec = newInterval;
        if (timer) {
          clearInterval(timer);
          timer = setInterval(() => void poll(), pollIntervalSec * 1000);
        }
      }
      ctx.log(
        "info",
        `weather: config updated (${city}, ${country}, every ${pollIntervalSec}s)`
      );
    },
  };
}

export const weatherDescriptor: ConnectorDescriptor<WeatherConfig> = {
  name: "weather",
  label: "Weather",
  description: "按城市监测预报，恶劣天气（强降水/大风/极端气温）触发提醒。",
  configSchema: [
    { key: "country", type: "string", taskRequired: true },
    { key: "city", type: "string", taskRequired: true },
    { key: "datetime", type: "string" },
    { key: "pollIntervalSec", type: "number", min: 60 },
  ],
  defaults: { country: "", city: "", datetime: "", pollIntervalSec: 1800 },
  create: createWeatherConnector,
};
