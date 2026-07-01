#!/usr/bin/env node
/**
 * fetch-scores.js
 * -----------------------------------------------------------------------------
 * Pulls daily OHLCV from Twelve Data for every entry in tickers.json and
 * computes the full field set the ARP dashboard expects:
 *   price, d1 (1-day %), m1 (1-month %), ma50, ma100, ma200,
 *   rsi14, rsi21, macd (MACD line).
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

// QUICK mode: refresh daily data/scores only and skip the intraday fetch.
// Used by the every-30-minutes market-hours runs to stay under the data cap.
const QUICK = process.env.FETCH_MODE === "quick";

// Benchmark for Mansfield relative strength (MSCI ACWI ETF).
const BENCHMARK = "ACWI";

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

// SMA of the `period` window ending `offset` bars before the latest bar.
function smaAtOffset(values, period, offset) {
  if (values.length < period + offset) return null;
  const end = values.length - offset;
  const slice = values.slice(end - period, end);
  return slice.reduce((a, b) => a + b, 0) / period;
}

// Is the `period` MA higher than it was `lookback` bars ago? (default 1 week)
function maRising(values, period, lookback) {
  const now = sma(values, period);
  const before = smaAtOffset(values, period, lookback || 5);
  if (now == null || before == null) return false;
  return now > before;
}

// Resample ascending daily rows into weekly OHLCV bars (Monday-anchored).
function toWeekly(rows) {
  const map = new Map();
  for (const r of rows) {
    const d = new Date(r.datetime.slice(0, 10) + "T00:00:00Z");
    const day = d.getUTCDay();              // 0 Sun .. 6 Sat
    const shift = day === 0 ? -6 : 1 - day; // back to Monday
    const monday = new Date(d);
    monday.setUTCDate(d.getUTCDate() + shift);
    const key = monday.toISOString().slice(0, 10);
    const o = parseFloat(r.open), h = parseFloat(r.high), l = parseFloat(r.low),
          c = parseFloat(r.close), v = parseFloat(r.volume) || 0;
    const w = map.get(key);
    if (!w) map.set(key, { t: key, o, h, l, c, v });
    else { w.h = Math.max(w.h, h); w.l = Math.min(w.l, l); w.c = c; w.v += v; }
  }
  return [...map.values()].sort((a, b) => (a.t < b.t ? -1 : 1));
}

// Weekly Stage Analysis Technical Attributes (SATA), 10 bands, each 0/1.
// Faithful reconstruction of the stageanalysis.net methodology (closed-source);
// thresholds are documented and tunable.
function computeSataWeekly(rows, benchWeeklyByKey) {
  const wk = toWeekly(rows);
  if (wk.length < 41) return null;          // need ~40 weeks of weekly history
  const C = wk.map(b => b.c), H = wk.map(b => b.h), V = wk.map(b => b.v);
  const n = C.length - 1, close = C[n];
  const ma10 = sma(C, 10), ma30 = sma(C, 30), ma40 = sma(C, 40);
  const ma30prev = smaAtOffset(C, 30, 5);   // 30W MA five weeks ago

  // Mansfield RS: stock/benchmark ratio vs its own 52-week average, > 0 = outperforming.
  const ratio = wk.map(b => { const a = benchWeeklyByKey[b.t]; return (a != null && a !== 0) ? b.c / a : null; });
  const rclean = ratio.filter(v => v != null);
  let mans = null;
  if (rclean.length >= 52) {
    const rma = sma(rclean, 52);
    if (rma) mans = (rclean[rclean.length - 1] / rma - 1) * 100;
  }

  // Momentum: 12-week rate of change, positive and durably rising (vs 3 weeks ago).
  const roc = (i) => (i >= 12 && C[i - 12] > 0) ? (C[i] / C[i - 12] - 1) : null;
  const rocNow = roc(n), rocPrev = roc(n - 3);

  // Volume: accumulation = avg volume on up-weeks > avg on down-weeks (last 10 weeks).
  let upV = 0, upN = 0, dnV = 0, dnN = 0;
  for (let i = Math.max(1, n - 9); i <= n; i++) {
    if (C[i] > C[i - 1]) { upV += V[i]; upN++; }
    else if (C[i] < C[i - 1]) { dnV += V[i]; dnN++; }
  }
  const accumulation = (upN && dnN) ? (upV / upN) > (dnV / dnN) : (upN >= dnN);

  const hi52 = Math.max(...H.slice(-52));               // 52-week high
  const hh13 = n >= 1 ? Math.max(...H.slice(Math.max(0, n - 13), n)) : H[n]; // prior 13-week high

  const comp = [
    ma10 != null && close > ma10,                              // 1 close > 10W MA
    ma30 != null && close > ma30,                              // 2 close > 30W MA
    ma40 != null && close > ma40,                              // 3 close > 40W MA
    ma30 != null && ma30prev != null && ma30 > ma30prev,       // 4 30W MA rising
    mans != null && mans > 0,                                  // 5 Mansfield RS > 0
    rocNow != null && rocNow > 0,                              // 6 momentum positive
    rocNow != null && rocPrev != null && rocNow > rocPrev,     // 7 momentum rising (vs 3 weeks ago)
    H[n] > hh13,                                               // 8 breakout: new 13-week high
    accumulation,                                              // 9 volume accumulation
    hi52 > 0 && close >= 0.92 * hi52,                          // 10 minimal overhead (within 8% of 52W high)
  ].map(Boolean);
  return { score: comp.reduce((a, b) => a + (b ? 1 : 0), 0), comp, mans };
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
  // prev24h is a daily snapshot updated only on full (nightly) runs so the
  // upgrades/downgrades panel always shows 24-hour moves, not 30-min ticks.
  let prev = [];
  let prev24h = [];
  try {
    const existing = JSON.parse(fs.readFileSync(OUTPUT_PATH, "utf8"));
    prev = existing.stocks || [];
    prev24h = QUICK
      ? (existing.prev24h || existing.stocks || [])   // quick: preserve yesterday's snapshot
      : (existing.prev24h || existing.stocks || []);   // full:  yesterday's snapshot stays as-is until we overwrite below
  } catch (e) { /* first run, no previous file */ }

  const results = [];
  const historyOut = {};

  // Benchmark series for Mansfield relative strength (one extra request).
  let benchWeeklyByKey = {};
  try {
    const bBatch = await fetchBatch([BENCHMARK], INTERVAL, OUTPUT_SIZE);
    const bRows = rowsAscending(bBatch[BENCHMARK]);
    if (bRows) { const bw = toWeekly(bRows); for (const b of bw) benchWeeklyByKey[b.t] = b.c; }
    console.log(`Fetched benchmark ${BENCHMARK}: ${Object.keys(benchWeeklyByKey).length} weekly bars.`);
  } catch (e) {
    console.warn(`Benchmark ${BENCHMARK} fetch failed; Mansfield RS scores 0 this run. ${e.message}`);
  }

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
      const sataRes = computeSataWeekly(rows, benchWeeklyByKey);
      const h52 = Math.max(...closes.slice(-252));

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
        ma150: round(sma(closes, 150), 3),
        ma200: round(sma(closes, 200), 3),
        rsi14: round(rsi(closes, 14), 3),
        rsi21: round(rsi(closes, 21), 3),
        macd: round(md.hist, 4),
        macdLine: round(md.line, 4),
        macdScore: md.score == null ? null : round(md.score, 2),
        macdMom: md.mom == null ? null : round(md.mom, 3),
        sata: sataRes ? sataRes.score : null,
        sataComp: sataRes ? sataRes.comp : null,
        mansfield: sataRes && sataRes.mans != null ? round(sataRes.mans, 2) : null,
        high52w: round(h52, 2),
        pct52w: round(((price / h52) - 1) * 100, 2),
      });

      // [date, close, volume] series for the chart.
      historyOut[meta.ticker || sym] = rows
        .slice(-HISTORY_KEEP)
        .map((r) => [r.datetime, round(parseFloat(r.open), 2), round(parseFloat(r.high), 2), round(parseFloat(r.low), 2), round(parseFloat(r.close), 2), Math.round(parseFloat(r.volume) || 0)]);
    }
    if (gi < groups.length - 1) {
      console.log(`Processed a batch of ${group.length}; pausing for rate limit...`);
      await sleep(PAUSE_BETWEEN_BATCHES_MS);
    }
  }

  // Second pass: 15-minute intraday bars for the short timeframes (1W/3D/1D).
  // Skipped in QUICK mode (intraday market-hours refresh) to stay under the
  // data-request cap; the prior run's intraday series is preserved instead.
  let intradayOut = {};
  if (QUICK) {
    try {
      const existing = JSON.parse(fs.readFileSync(HISTORY_PATH, "utf8"));
      intradayOut = existing.intraday || {};
    } catch (e) { /* no prior history file yet */ }
    console.log(`QUICK mode: skipped intraday fetch, preserved ${Object.keys(intradayOut).length} intraday series.`);
  } else {
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
  }

  const payload = {
    updated: new Date().toISOString(),
    stocks: results,
    prev,
    prev24h: QUICK ? prev24h : results,  // full run: today's close becomes tomorrow's 24h baseline
  };
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(payload, null, 2));
  console.log(`Wrote ${results.length} instruments to ${OUTPUT_PATH}`);

  const history = { updated: new Date().toISOString(), series: historyOut, intraday: intradayOut };
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(history));
  console.log(`Wrote history (${Object.keys(historyOut).length} daily, ${Object.keys(intradayOut).length} intraday) to ${HISTORY_PATH}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
