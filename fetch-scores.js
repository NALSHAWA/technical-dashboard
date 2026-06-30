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
const HISTORY_PATH = path.join(__dirname, "public", "data", "history.json");

const INTERVAL = "1day";
const OUTPUT_SIZE = 460;        // ~1y to display (252) plus MA200 lookback
const HISTORY_KEEP = 460;       // daily bars stored per name for the chart
const INTRADAY_INTERVAL = "15min";
const INTRADAY_SIZE = 260;      // ~10 trading days of 15-min bars
const INTRADAY_KEEP = 260;      // intraday bars stored per name (covers 1D/3D/1W)
const MIN_BARS = 35;            // enough for MACD(12,26,9) and RSI(30)

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

function maxAbs(arr) {
  let m = 0;
  for (const v of arr) if (v != null) { const a = Math.abs(v); if (a > m) m = a; }
  return m;
}

// Full two-axis MACD read.
// Returns { hist, line, score, mom } where:
//   hist  = latest histogram (MACD line minus signal); the chart's third number
//   line  = latest MACD line (EMA12-EMA26); the regime axis
//   score = standalone 0-5 grid score crossing regime (line vs zero) with
//           momentum (histogram sign + slope over 3 bars)
//   mom   = histogram-momentum pillar (0-1.5), regime-free, for the composite
// Guards: a slope below FLAT of the recent histogram magnitude counts as flat
// (pulls to regime-only); a line within DEAD of the recent line magnitude of
// zero damps the read toward the neutral midpoint.
function computeMacd(closes, fast = 12, slow = 26, signalP = 9) {
  const NONE = { hist: null, line: null, score: null, mom: null };
  if (closes.length < slow + signalP + 3) return NONE;
  const ef = emaSeries(closes, fast);
  const es = emaSeries(closes, slow);
  const line = [];
  for (let i = 0; i < closes.length; i++) {
    if (ef[i] != null && es[i] != null) line.push(ef[i] - es[i]);
  }
  const sig = emaSeries(line, signalP);
  const hist = [];
  for (let i = 0; i < line.length; i++) hist.push(sig[i] != null ? line[i] - sig[i] : null);
  const histValid = hist.filter((h) => h != null);
  if (histValid.length < 4) return NONE;

  const FLAT = 0.10, DEAD = 0.10, WIN = 20;
  const lastLine = line[line.length - 1];
  const lastHist = histValid[histValid.length - 1];
  const hist3 = histValid[histValid.length - 4]; // 3 bars ago

  const histScale = maxAbs(histValid.slice(-WIN));
  const lineScale = maxAbs(line.slice(-WIN));
  const slope = lastHist - hist3;
  const flatBand = FLAT * histScale;
  const meaningful = histScale > 1e-8; // dead/flat tape: don't read noise as direction
  const rising = meaningful && slope > flatBand;
  const falling = meaningful && slope < -flatBand;
  const bull = lastLine > 0;
  const histPos = lastHist > 0;

  // 8-cell grid -> 0-5. Flat slope falls through to regime-only (3 bull / 2 bear).
  let score;
  if (bull) {
    if (rising && histPos) score = 5;
    else if (falling && histPos) score = 4;
    else if (rising && !histPos) score = 3;
    else if (falling && !histPos) score = 2;
    else score = 3;
  } else {
    if (rising && histPos) score = 3;       // fresh bullish cross below zero
    else if (rising && !histPos) score = 2; // downtrend, tentative improvement
    else if (falling && histPos) score = 1; // failed bounce
    else if (falling && !histPos) score = 0;
    else score = 2;
  }

  // Histogram-momentum pillar (0-1.5), regime-free, for the composite.
  let mom;
  if (rising && histPos) mom = 1.5;
  else if (falling && histPos) mom = 1.0;
  else if (rising && !histPos) mom = 0.75;
  else if (falling && !histPos) mom = 0.0;
  else mom = 0.75;

  // Zero-line deadband: dampen both toward their neutral midpoints.
  if (lineScale > 0 && Math.abs(lastLine) < DEAD * lineScale) {
    score = score * 0.5 + 2.5 * 0.5;
    mom = mom * 0.5 + 0.75 * 0.5;
  }

  return { hist: lastHist, line: lastLine, score, mom };
}

// ---------------------------------------------------------------------------
// Twelve Data fetch (with rate-limit retry)
// ---------------------------------------------------------------------------
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function fetchBatch(symbols, interval, size, attempt = 1) {
  const url =
    `https://api.twelvedata.com/time_series` +
    `?symbol=${encodeURIComponent(symbols.join(","))}` +
    `&interval=${interval}&outputsize=${size}&apikey=${API_KEY}`;
  const res = await fetch(url);

  if (res.status === 429) {
    if (attempt > 4) throw new Error("Rate limit: gave up after 4 retries");
    console.warn(`Rate limited (429). Waiting 65s, retry ${attempt}...`);
    await sleep(65 * 1000);
    return fetchBatch(symbols, interval, size, attempt + 1);
  }
  if (!res.ok) throw new Error(`Twelve Data HTTP ${res.status}`);

  const data = await res.json();
  if (data && data.code === 429) {
    if (attempt > 4) throw new Error("Rate limit: gave up after 4 retries");
    console.warn(`Rate limited (body 429). Waiting 65s, retry ${attempt}...`);
    await sleep(65 * 1000);
    return fetchBatch(symbols, interval, size, attempt + 1);
  }
  if (symbols.length === 1) return { [symbols[0]]: data };
  return data;
}

// Intraday datetime ("2026-06-29 15:45:00") -> epoch seconds for the chart.
function epochSec(dt) {
  return Math.floor(new Date(dt.replace(" ", "T") + "Z").getTime() / 1000);
}

function rowsAscending(seriesObj) {
  if (!seriesObj || !seriesObj.values) return null;
  return [...seriesObj.values].sort(
    (a, b) => new Date(a.datetime) - new Date(b.datetime)
  );
}

function closesAscending(seriesObj) {
  const rows = rowsAscending(seriesObj);
  return rows ? rows.map((r) => parseFloat(r.close)) : null;
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
  const historyOut = {};
  const groups = chunk(symbols, BATCH_SIZE);
  for (let gi = 0; gi < groups.length; gi++) {
    const group = groups[gi];
    const batch = await fetchBatch(group, INTERVAL, OUTPUT_SIZE);
    for (const sym of group) {
      const seriesObj = batch[sym];
      if (seriesObj && seriesObj.status === "error") {
        console.warn(`Skipping ${sym}: ${seriesObj.message}`);
        continue;
      }
      const rows = rowsAscending(seriesObj);
      const closes = rows ? rows.map((r) => parseFloat(r.close)) : null;
      if (!closes || closes.length < MIN_BARS) {
        console.warn(`Skipping ${sym}: only ${closes ? closes.length : 0} bars`);
        continue;
      }
      const meta = metaBySymbol[sym] || {};
      const price = closes[closes.length - 1];
      const prevClose = closes[closes.length - 2];
      const monthAgo = closes.length >= 22 ? closes[closes.length - 22] : null;
      const md = computeMacd(closes);

      results.push({
        ticker: meta.ticker || sym,
        name: meta.name || sym,
        price: round(price, 2),
        d1: round(((price - prevClose) / prevClose) * 100, 2),
        m1: monthAgo ? round(((price - monthAgo) / monthAgo) * 100, 2) : 0,
        ma9: round(sma(closes, 9), 3),
        ma21: round(sma(closes, 21), 3),
        ma50: round(sma(closes, 50), 3),
        ma100: round(sma(closes, 100), 3),
        ma200: round(sma(closes, 200), 3),
        rsi14: round(rsi(closes, 14), 3),
        rsi30: round(rsi(closes, 30), 3),
        macd: round(md.hist, 4),
        macdLine: round(md.line, 4),
        macdScore: md.score == null ? null : round(md.score, 2),
        macdMom: md.mom == null ? null : round(md.mom, 3),
      });

      // [date, close] series for the chart, keyed by the same ticker as scores.
      historyOut[meta.ticker || sym] = rows
        .slice(-HISTORY_KEEP)
        .map((r) => [r.datetime, round(parseFloat(r.close), 2)]);
    }
    if (gi < groups.length - 1) {
      console.log(`Processed a batch of ${group.length}; pausing for rate limit...`);
      await sleep(PAUSE_BETWEEN_BATCHES_MS);
    }
  }

  // Second pass: 15-minute intraday bars for the short timeframes (1W/3D/1D).
  const intradayOut = {};
  for (let gi = 0; gi < groups.length; gi++) {
    const group = groups[gi];
    const batch = await fetchBatch(group, INTRADAY_INTERVAL, INTRADAY_SIZE);
    for (const sym of group) {
      const seriesObj = batch[sym];
      if (seriesObj && seriesObj.status === "error") continue;
      const rows = rowsAscending(seriesObj);
      if (!rows || !rows.length) continue;
      const meta = metaBySymbol[sym] || {};
      intradayOut[meta.ticker || sym] = rows
        .slice(-INTRADAY_KEEP)
        .map((r) => [epochSec(r.datetime), round(parseFloat(r.close), 2)]);
    }
    if (gi < groups.length - 1) {
      console.log(`Intraday batch of ${group.length}; pausing for rate limit...`);
      await sleep(PAUSE_BETWEEN_BATCHES_MS);
    }
  }

  const payload = { updated: new Date().toISOString(), stocks: results, prev };
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(payload, null, 2));
  console.log(`Wrote ${results.length} instruments to ${OUTPUT_PATH}`);

  const history = { updated: new Date().toISOString(), series: historyOut, intraday: intradayOut };
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(history));
  console.log(`Wrote history (${Object.keys(historyOut).length} daily, ${Object.keys(intradayOut).length} intraday) to ${HISTORY_PATH}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
