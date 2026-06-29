#!/usr/bin/env node
/**
 * fetch-scores.js
 * -----------------------------------------------------------------------------
 * Pulls daily OHLCV from Twelve Data for every entry in tickers.json and
 * computes the full field set the ARP dashboard expects:
 *   price, d1 (1-day %), m1 (1-month %), ma50, ma100, ma200,
 *   rsi14, rsi30, macd (MACD line).
 *
 * It also carries forward the previous run's results as `prev`, so the
 * dashboard can show score upgrades / downgrades day over day.
 *
 * Output: public/data/scores.json   { updated, stocks: [...], prev: [...] }
 *
 * Zero dependencies. Node 18+ (built-in fetch).
 * Env: TWELVE_DATA_API_KEY
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
const OUTPUT_SIZE = 250;       // enough history for MA200
const MIN_BARS = 35;           // enough for MACD(12,26,9) and RSI(30)

// Basic (free) plan allows ~8 requests/minute. Request in small batches and
// pause between them. If you upgrade your Twelve Data plan, raise BATCH_SIZE
// and shorten PAUSE_BETWEEN_BATCHES_MS to make this run faster.
const BATCH_SIZE = 7;
const PAUSE_BETWEEN_BATCHES_MS = 62 * 1000;

// ---------------------------------------------------------------------------
// Indicator math
// ---------------------------------------------------------------------------
function sma(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

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

function rsi(closes, period) {
  if (closes.length < period + 1) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  let avgGain = gain / period, avgLoss = loss / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

// Returns the latest MACD line value (EMA12 - EMA26).
function macdLine(closes, fast = 12, slow = 26) {
  if (closes.length < slow) return null;
  const ef = emaSeries(closes, fast);
  const es = emaSeries(closes, slow);
  const i = closes.length - 1;
  if (ef[i] == null || es[i] == null) return null;
  return ef[i] - es[i];
}

// ---------------------------------------------------------------------------
// Twelve Data fetch (with rate-limit retry)
// ---------------------------------------------------------------------------
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function fetchBatch(symbols, attempt = 1) {
  const url =
    `https://api.twelvedata.com/time_series` +
    `?symbol=${encodeURIComponent(symbols.join(","))}` +
    `&interval=${INTERVAL}&outputsize=${OUTPUT_SIZE}&apikey=${API_KEY}`;
  const res = await fetch(url);

  if (res.status === 429) {
    if (attempt > 4) throw new Error("Rate limit: gave up after 4 retries");
    console.warn(`Rate limited (429). Waiting 65s, retry ${attempt}...`);
    await sleep(65 * 1000);
    return fetchBatch(symbols, attempt + 1);
  }
  if (!res.ok) throw new Error(`Twelve Data HTTP ${res.status}`);

  const data = await res.json();
  if (data && data.code === 429) {
    if (attempt > 4) throw new Error("Rate limit: gave up after 4 retries");
    console.warn(`Rate limited (body 429). Waiting 65s, retry ${attempt}...`);
    await sleep(65 * 1000);
    return fetchBatch(symbols, attempt + 1);
  }
  if (symbols.length === 1) return { [symbols[0]]: data };
  return data;
}

function closesAscending(seriesObj) {
  if (!seriesObj || !seriesObj.values) return null;
  const rows = [...seriesObj.values].sort(
    (a, b) => new Date(a.datetime) - new Date(b.datetime)
  );
  return rows.map((r) => parseFloat(r.close));
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function round(n, dp) {
  if (n == null || Number.isNaN(n)) return null;
  const f = Math.pow(10, dp);
  return Math.round(n * f) / f;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const entries = JSON.parse(fs.readFileSync(TICKERS_PATH, "utf8")).map((t) =>
    typeof t === "string" ? { symbol: t } : t
  );
  const symbols = entries.map((e) => e.symbol);
  const metaBySymbol = {};
  entries.forEach((e) => { metaBySymbol[e.symbol] = e; });

  // Carry forward previous run for score-change tracking.
  let prev = [];
  try {
    const existing = JSON.parse(fs.readFileSync(OUTPUT_PATH, "utf8"));
    prev = existing.stocks || [];
  } catch (e) { /* first run, no previous file */ }

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
      if (!closes || closes.length < MIN_BARS) {
        console.warn(`Skipping ${sym}: only ${closes ? closes.length : 0} bars`);
        continue;
      }
      const meta = metaBySymbol[sym] || {};
      const price = closes[closes.length - 1];
      const prevClose = closes[closes.length - 2];
      const monthAgo = closes.length >= 22 ? closes[closes.length - 22] : null;

      results.push({
        ticker: meta.ticker || sym,
        name: meta.name || sym,
        price: round(price, 2),
        d1: round(((price - prevClose) / prevClose) * 100, 2),
        m1: monthAgo ? round(((price - monthAgo) / monthAgo) * 100, 2) : 0,
        ma50: round(sma(closes, 50), 3),
        ma100: round(sma(closes, 100), 3),
        ma200: round(sma(closes, 200), 3),
        rsi14: round(rsi(closes, 14), 3),
        rsi30: round(rsi(closes, 30), 3),
        macd: round(macdLine(closes), 3),
      });
    }
    if (gi < groups.length - 1) {
      console.log(`Processed a batch of ${group.length}; pausing for rate limit...`);
      await sleep(PAUSE_BETWEEN_BATCHES_MS);
    }
  }

  const payload = { updated: new Date().toISOString(), stocks: results, prev };
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(payload, null, 2));
  console.log(`Wrote ${results.length} instruments to ${OUTPUT_PATH}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
