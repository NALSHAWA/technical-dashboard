#!/usr/bin/env node
/**
 * fetch-scores.js
 * -----------------------------------------------------------------------------
 * Pulls daily OHLCV from Twelve Data for the tickers in tickers.json,
 * computes RSI(14), MACD(12,26,9) and a trend read, derives a 0-5 composite
 * score, and writes the result to public/data/scores.json.
 *
 * Zero dependencies. Requires Node 18+ (uses the built-in global fetch).
 *
 * Env:
 *   TWELVE_DATA_API_KEY   your Twelve Data key (set as a GitHub Actions secret)
 *
 * Run locally:
 *   TWELVE_DATA_API_KEY=xxxx node fetch-scores.js
 * -----------------------------------------------------------------------------
 */

const fs = require("fs");
const path = require("path");

const API_KEY = process.env.TWELVE_DATA_API_KEY;
if (!API_KEY) {
  console.error("Missing TWELVE_DATA_API_KEY environment variable.");
  process.exit(1);
}

const TICKERS_PATH = path.join(__dirname, "tickers.json");
const OUTPUT_PATH = path.join(__dirname, "public", "data", "scores.json");

const INTERVAL = "1day";
const OUTPUT_SIZE = 250;      // bars of history; enough for stable MACD / SMA200
// Twelve Data allows up to 120 symbols per call, but the Basic (free) plan
// permits only 8 requests per minute. So we request in small batches and pause
// between them to stay under the limit. If you upgrade your plan later, you can
// raise BATCH_SIZE and shorten PAUSE_BETWEEN_BATCHES_MS to make this faster.
const BATCH_SIZE = 7;
const PAUSE_BETWEEN_BATCHES_MS = 62 * 1000; // just over a minute between batches

// ---------------------------------------------------------------------------
// Indicator math
// ---------------------------------------------------------------------------

// Simple moving average of the last `period` values.
function sma(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

// Full EMA series (seeded with the SMA of the first `period` values).
function emaSeries(values, period) {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  const out = [];
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

// RSI using Wilder's smoothing. Returns the latest value.
function rsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// MACD(12,26,9). Returns {macd, signal, hist} latest values.
function macd(closes, fast = 12, slow = 26, signalPeriod = 9) {
  if (closes.length < slow + signalPeriod) return null;
  const emaFast = emaSeries(closes, fast);
  const emaSlow = emaSeries(closes, slow);
  const macdLine = [];
  for (let i = 0; i < closes.length; i++) {
    if (emaFast[i] != null && emaSlow[i] != null) {
      macdLine[i] = emaFast[i] - emaSlow[i];
    }
  }
  const macdCompact = macdLine.filter((v) => v != null);
  const signalSeries = emaSeries(macdCompact, signalPeriod);
  const macdVal = macdCompact[macdCompact.length - 1];
  const signalVal = signalSeries[signalSeries.length - 1];
  return { macd: macdVal, signal: signalVal, hist: macdVal - signalVal };
}

// ---------------------------------------------------------------------------
// Composite scoring  ***  TUNE THIS TO MATCH YOUR METHODOLOGY  ***
// ---------------------------------------------------------------------------
// Range 0-5. Trend contributes 0-2, MACD 0-2, RSI 0-1.
// These thresholds are a sensible starting point; replace with your own rules.
function scoreInstrument({ price, rsiVal, macdVal, sma50, sma200 }) {
  let trend = 0;
  if (sma50 != null && price > sma50) trend += 1;
  if (sma200 != null && price > sma200) trend += 1;

  let macdScore = 0;
  if (macdVal) {
    if (macdVal.macd > macdVal.signal) macdScore += 1; // bullish cross state
    if (macdVal.macd > 0) macdScore += 1;              // above zero line
  }

  let rsiScore = 0;
  if (rsiVal != null && rsiVal > 50 && rsiVal < 70) rsiScore = 1; // constructive, not overbought

  return {
    trend,
    macd: macdScore,
    rsi: rsiScore,
    composite: trend + macdScore + rsiScore,
  };
}

// ---------------------------------------------------------------------------
// Twelve Data fetch
// ---------------------------------------------------------------------------

async function fetchBatch(symbols, attempt = 1) {
  const symbolParam = symbols.join(",");
  const url =
    `https://api.twelvedata.com/time_series` +
    `?symbol=${encodeURIComponent(symbolParam)}` +
    `&interval=${INTERVAL}&outputsize=${OUTPUT_SIZE}&apikey=${API_KEY}`;
  const res = await fetch(url);

  // 429 = rate limited. Wait, then retry a few times before giving up.
  if (res.status === 429) {
    if (attempt > 4) throw new Error("Twelve Data rate limit: gave up after 4 retries");
    console.warn(`Rate limited (429). Waiting 65s, then retry (attempt ${attempt})...`);
    await sleep(65 * 1000);
    return fetchBatch(symbols, attempt + 1);
  }
  if (!res.ok) throw new Error(`Twelve Data HTTP ${res.status}`);

  const data = await res.json();

  // Twelve Data also signals rate limits inside a normal 200 body as code 429.
  if (data && data.code === 429) {
    if (attempt > 4) throw new Error("Twelve Data rate limit: gave up after 4 retries");
    console.warn(`Rate limited (body code 429). Waiting 65s, then retry (attempt ${attempt})...`);
    await sleep(65 * 1000);
    return fetchBatch(symbols, attempt + 1);
  }

  // Single-symbol responses are flat; multi-symbol responses are keyed by symbol.
  if (symbols.length === 1) return { [symbols[0]]: data };
  return data;
}

// Twelve Data returns values newest-first; we sort ascending for the math.
function closesAscending(seriesObj) {
  if (!seriesObj || !seriesObj.values) return null;
  const rows = [...seriesObj.values].sort(
    (a, b) => new Date(a.datetime) - new Date(b.datetime)
  );
  return rows.map((r) => parseFloat(r.close));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const tickers = JSON.parse(fs.readFileSync(TICKERS_PATH, "utf8"));
  const symbols = tickers.map((t) => (typeof t === "string" ? t : t.symbol));

  const results = [];
  const groups = chunk(symbols, BATCH_SIZE);
  for (let gi = 0; gi < groups.length; gi++) {
    const group = groups[gi];
    const batch = await fetchBatch(group);
    for (const sym of group) {
      const seriesObj = batch[sym];
      if (seriesObj && seriesObj.status === "error") {
        console.warn(`Skipping ${sym}: ${seriesObj.message}`);
        continue;
      }
      const closes = closesAscending(seriesObj);
      // Need >= 35 bars for MACD(12,26,9) + RSI(14). The 50- and 200-day
      // moving averages compute only when enough history exists, otherwise
      // they come back null and the trend score adjusts accordingly. This
      // lets newly-listed names (e.g. recent ETFs) still be scored.
      const MIN_BARS = 35;
      if (!closes || closes.length < MIN_BARS) {
        console.warn(`Skipping ${sym}: only ${closes ? closes.length : 0} bars, need >= ${MIN_BARS}`);
        continue;
      }

      const price = closes[closes.length - 1];
      const prev = closes[closes.length - 2];
      const rsiVal = rsi(closes, 14);
      const macdVal = macd(closes);
      const sma50 = sma(closes, 50);
      const sma200 = sma(closes, 200);
      const scores = scoreInstrument({ price, rsiVal, macdVal, sma50, sma200 });

      results.push({
        symbol: sym,
        price: round(price),
        change_pct: round(((price - prev) / prev) * 100),
        rsi: round(rsiVal),
        macd: macdVal
          ? { macd: round(macdVal.macd, 4), signal: round(macdVal.signal, 4), hist: round(macdVal.hist, 4) }
          : null,
        trend: {
          sma50: round(sma50),
          sma200: round(sma200),
          above50: sma50 != null && price > sma50,
          above200: sma200 != null && price > sma200,
        },
        scores,
      });
    }
    // Pause between batches so we never exceed the Basic plan's per-minute limit.
    if (gi < groups.length - 1) {
      console.log(`Processed a batch of ${group.length}; pausing ~1 min for the rate limit...`);
      await sleep(PAUSE_BETWEEN_BATCHES_MS);
    }
  }

  results.sort((a, b) => b.scores.composite - a.scores.composite);

  const payload = { updated: new Date().toISOString(), stocks: results };
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(payload, null, 2));
  console.log(`Wrote ${results.length} instruments to ${OUTPUT_PATH}`);
}

function round(n, dp = 2) {
  if (n == null || Number.isNaN(n)) return null;
  const f = Math.pow(10, dp);
  return Math.round(n * f) / f;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
