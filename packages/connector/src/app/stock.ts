import type { Connector, ConnectorContext, ConnectorDescriptor } from "../types.js";

interface StockConfig extends Record<string, unknown> {
  symbols: string[];
  threshold: number;
  pollIntervalSec: number;
  finnhubKey: string;
}

interface QuoteResult {
  symbol: string;
  shortName?: string;
  price: number;
  changePercent: number;
}

// --- Finnhub ---

interface FinnhubQuoteResponse {
  c?: number;   // current price
  pc?: number;  // previous close
  dp?: number;  // percent change
  t?: number;   // timestamp (0 表示无数据)
}

async function fetchFinnhub(
  symbol: string,
  key: string,
  ctx: ConnectorContext
): Promise<QuoteResult | null> {
  const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${key}`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      ctx.log("warn", `  stock: ${symbol} finnhub HTTP ${res.status}`);
      return null;
    }
    const data = (await res.json()) as FinnhubQuoteResponse;
    // t === 0 说明 symbol 无效或无数据
    if (!data.t || typeof data.c !== "number" || typeof data.pc !== "number") {
      ctx.log("warn", `  stock: ${symbol} finnhub no data`);
      return null;
    }
    const pct = data.dp ?? (data.pc === 0 ? 0 : ((data.c - data.pc) / data.pc) * 100);
    return { symbol, price: data.c, changePercent: pct };
  } catch (err) {
    ctx.log("warn", `  stock: ${symbol} finnhub failed — ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// --- Stooq (免费，无 key，返回 CSV) ---

async function fetchStooq(
  symbol: string,
  ctx: ConnectorContext
): Promise<QuoteResult | null> {
  // 美股需要 .US 后缀
  const stooqSymbol = `${symbol.toUpperCase()}.US`;
  const url = `https://stooq.com/q/l/?s=${encodeURIComponent(stooqSymbol)}&f=sd2t2ohlcv&h&e=csv`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      ctx.log("warn", `  stock: ${symbol} stooq HTTP ${res.status}`);
      return null;
    }
    const text = await res.text();
    const lines = text.trim().split("\n");
    if (lines.length < 2) return null;
    // CSV: Symbol,Date,Time,Open,High,Low,Close,Volume
    const cols = lines[1]!.split(",");
    const open = parseFloat(cols[3]!);
    const close = parseFloat(cols[6]!);
    if (!Number.isFinite(open) || !Number.isFinite(close) || open === 0) {
      ctx.log("warn", `  stock: ${symbol} stooq invalid data`);
      return null;
    }
    // 用 open 近似 previous close 计算日内涨跌幅
    const pct = ((close - open) / open) * 100;
    return { symbol, price: close, changePercent: pct };
  } catch (err) {
    ctx.log("warn", `  stock: ${symbol} stooq failed — ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// --- Yahoo Finance ---

interface YahooChartMeta {
  symbol?: string;
  shortName?: string;
  longName?: string;
  regularMarketPrice?: number;
  chartPreviousClose?: number;
  previousClose?: number;
}

interface YahooChartResponse {
  chart?: {
    result?: Array<{ meta?: YahooChartMeta }>;
    error?: { code?: string; description?: string } | null;
  };
}

const YAHOO_HEADERS = {
  accept: "application/json",
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
};

async function fetchYahoo(
  symbol: string,
  ctx: ConnectorContext
): Promise<QuoteResult | null> {
  for (const host of ["query1.finance.yahoo.com", "query2.finance.yahoo.com"]) {
    const url = `https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1m`;
    try {
      const res = await fetch(url, { headers: YAHOO_HEADERS });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        ctx.log("warn", `  stock: ${symbol} ${host} HTTP ${res.status}${text ? ` — ${text.slice(0, 120)}` : ""}`);
        continue;
      }
      const body = (await res.json()) as YahooChartResponse;
      const error = body.chart?.error;
      if (error) {
        ctx.log("warn", `  stock: ${symbol} ${error.code ?? "chart_error"} — ${error.description ?? ""}`);
        continue;
      }
      const meta = body.chart?.result?.[0]?.meta;
      const price = meta?.regularMarketPrice;
      const previousClose = meta?.chartPreviousClose ?? meta?.previousClose;
      if (typeof price !== "number" || typeof previousClose !== "number") {
        ctx.log("warn", `  stock: ${symbol} missing price fields`);
        return null;
      }
      const pct = previousClose === 0 ? 0 : ((price - previousClose) / previousClose) * 100;
      return {
        symbol: meta?.symbol ?? symbol,
        shortName: meta?.shortName ?? meta?.longName,
        price,
        changePercent: pct,
      };
    } catch (err) {
      ctx.log("warn", `  stock: ${symbol} ${host} failed — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return null;
}

// --- 多源调度 ---

async function fetchQuote(
  symbol: string,
  finnhubKey: string,
  ctx: ConnectorContext
): Promise<QuoteResult | null> {
  if (finnhubKey) {
    const result = await fetchFinnhub(symbol, finnhubKey, ctx);
    if (result) return result;
  }
  const stooq = await fetchStooq(symbol, ctx);
  if (stooq) return stooq;
  return fetchYahoo(symbol, ctx);
}

const REALERT_COOLDOWN_MS = 30 * 60_000;

function createStockConnector(cfg: StockConfig, ctx: ConnectorContext): Connector {
  let pollIntervalSec = Math.max(30, Number(cfg.pollIntervalSec) || 300);
  let threshold = Number(cfg.threshold) || 3;
  let finnhubKey = typeof cfg.finnhubKey === "string" ? cfg.finnhubKey.trim() : "";
  let symbols = (Array.isArray(cfg.symbols) ? cfg.symbols : [])
    .filter((s): s is string => typeof s === "string" && s.trim().length > 0);
  const alertedAt = new Map<string, number>();
  let timer: NodeJS.Timeout | null = null;
  let polling = false;
  let lastPollAt: number | null = null;

  const poll = async () => {
    if (polling) return;
    polling = true;
    try {
      if (symbols.length === 0) {
        ctx.log("info", "  stock: no symbols configured — skip");
        return;
      }
      lastPollAt = Date.now();
      const quotes = (
        await Promise.all(symbols.map((s) => fetchQuote(s, finnhubKey, ctx)))
      ).filter((q): q is QuoteResult => q !== null);

      for (const q of quotes) {
        const key = q.symbol;
        const last = alertedAt.get(key) ?? 0;
        if (Date.now() - last < REALERT_COOLDOWN_MS) continue;
        if (Math.abs(q.changePercent) < threshold) continue;
        ctx.emitEvent({
          type: "price_move",
          payload: {
            title: `${key} ${q.changePercent > 0 ? "+" : ""}${q.changePercent.toFixed(2)}%`,
            sub: `Price: ${q.price} · ${q.shortName ?? ""}`,
            symbol: key,
            pct: q.changePercent,
            price: q.price,
          },
        });
        alertedAt.set(key, Date.now());
      }
    } catch (err) {
      ctx.log(
        "warn",
        `  stock: poll failed — ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      polling = false;
    }
  };

  return {
    async start() {
      const source = finnhubKey ? "finnhub→stooq→yahoo" : "stooq→yahoo";
      ctx.log(
        "info",
        `stock: started (symbols=${symbols.join(",") || "—"}, every ${pollIntervalSec}s, threshold=${threshold}%, source=${source})`
      );
      await poll();
      timer = setInterval(() => void poll(), pollIntervalSec * 1000);
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      ctx.log("info", "stock: stopped");
    },
    status() {
      return {
        pollIntervalSec,
        threshold,
        symbols,
        lastPollAt,
        alertedCount: alertedAt.size,
      };
    },
    updateConfig(cfg: Record<string, unknown>) {
      const newSymbols = (Array.isArray(cfg.symbols) ? cfg.symbols : [])
        .filter((s): s is string => typeof s === "string" && s.trim().length > 0);
      const newThreshold = Number(cfg.threshold) || 3;
      const newInterval = Math.max(30, Number(cfg.pollIntervalSec) || 300);
      const newKey = typeof cfg.finnhubKey === "string" ? cfg.finnhubKey.trim() : "";

      for (const key of alertedAt.keys()) {
        if (!newSymbols.includes(key)) alertedAt.delete(key);
      }

      symbols = newSymbols;
      threshold = newThreshold;
      finnhubKey = newKey;

      if (newInterval !== pollIntervalSec) {
        pollIntervalSec = newInterval;
        if (timer) {
          clearInterval(timer);
          timer = setInterval(() => void poll(), pollIntervalSec * 1000);
        }
      }

      ctx.log(
        "info",
        `stock: config updated (symbols=${symbols.join(",") || "—"}, every ${pollIntervalSec}s, threshold=${threshold}%)`
      );
    },
  };
}

export const stockDescriptor: ConnectorDescriptor<StockConfig> = {
  name: "stock",
  label: "Stock (US)",
  description: "美股价格异动提醒（数据源 Finnhub / Stooq / Yahoo Finance，按优先级降级）。",
  configSchema: [
    { key: "symbols", type: "string[]", taskRequired: true },
    { key: "threshold", type: "number", min: 0.1 },
    { key: "pollIntervalSec", type: "number", min: 30 },
    { key: "finnhubKey", type: "string", secret: true },
  ],
  defaults: { symbols: ["AAPL", "NVDA"], threshold: 3, pollIntervalSec: 300, finnhubKey: "" },
  create: createStockConnector,
};
