import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 3000;

const trackedAssets = [
  { symbol: "AAPL", name: "Apple", sector: "Technology", type: "stocks" },
  { symbol: "MSFT", name: "Microsoft", sector: "Technology", type: "stocks" },
  { symbol: "NVDA", name: "NVIDIA", sector: "Semiconductors", type: "stocks" },
  { symbol: "TSLA", name: "Tesla", sector: "Consumer Cyclical", type: "stocks" },
  { symbol: "SPY", name: "S&P 500 ETF", sector: "ETF", type: "etf" },
  { symbol: "QQQ", name: "Nasdaq 100 ETF", sector: "ETF", type: "etf" },
  { symbol: "BTC-USD", name: "Bitcoin", sector: "Crypto", type: "crypto", coinGeckoId: "bitcoin" },
  { symbol: "ETH-USD", name: "Ethereum", sector: "Crypto", type: "crypto", coinGeckoId: "ethereum" }
];

const portfolioHoldings = [
  { symbol: "AAPL", shares: 38 },
  { symbol: "MSFT", shares: 21 },
  { symbol: "NVDA", shares: 44 },
  { symbol: "TSLA", shares: 18 },
  { symbol: "SPY", shares: 42 },
  { symbol: "QQQ", shares: 27 },
  { symbol: "BTC-USD", shares: 0.22 },
  { symbol: "ETH-USD", shares: 3.4 }
];
const cashBalance = 12_840.35;

const cache = new Map();
const cacheTtlMs = 12_000;
const streamIntervalMs = 15_000;
const newsCacheTtlMs = 90_000;
const quoteRequestTimeoutMs = 8_000;
const chartRequestTimeoutMs = 4_000;
const newsRequestTimeoutMs = 8_000;
let newsCache = { fetchedAt: 0, data: [] };
const sentimentCache = new Map();
const sentimentCacheTtlMs = 60_000;
const chartPeriods = {
  "1y": { key: "1y", label: "近1年", yahooRange: "1y", maxPoints: 140 },
  "3y": { key: "3y", label: "近3年", yahooRange: "3y", maxPoints: 180 }
};

app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", (_request, response) => {
  response.json({
    status: "ok",
    generatedAt: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    trackedAssets: trackedAssets.length,
    cachedQuotes: cache.size,
    cachedNews: newsCache.data.length,
    streamIntervalMs,
    cacheTtlMs,
    newsCacheTtlMs,
    quoteRequestTimeoutMs,
    chartRequestTimeoutMs,
    newsRequestTimeoutMs,
    sources: ["Nasdaq", "CoinGecko", "Yahoo chart fallback", "Nasdaq RSS", "MarketWatch RSS"]
  });
});

app.get("/api/market", async (_request, response) => {
  const snapshot = await loadMarketSnapshot();
  response.status(snapshot.quotes.length ? 200 : 502).json(snapshot);
});

app.get("/api/sentiment", async (request, response) => {
  const snapshot = await loadSentimentSnapshot(request.query.period);
  response.status(snapshot.status === "offline" ? 502 : 200).json(snapshot);
});

app.get("/api/stream", async (request, response) => {
  response.setHeader("Content-Type", "text/event-stream");
  response.setHeader("Cache-Control", "no-cache");
  response.setHeader("Connection", "keep-alive");
  response.flushHeaders?.();

  let closed = false;

  const sendSnapshot = async () => {
    if (closed) return;
    const snapshot = await loadMarketSnapshot();
    snapshot.transport = "sse";
    response.write(`event: market\n`);
    response.write(`data: ${JSON.stringify(snapshot)}\n\n`);
  };

  await sendSnapshot();
  const interval = setInterval(sendSnapshot, streamIntervalMs);
  const heartbeat = setInterval(() => {
    response.write(`event: heartbeat\n`);
    response.write(`data: ${Date.now()}\n\n`);
  }, 25_000);

  request.on("close", () => {
    closed = true;
    clearInterval(interval);
    clearInterval(heartbeat);
    response.end();
  });
});

async function loadMarketSnapshot() {
  const startedAt = Date.now();
  const cryptoAssets = trackedAssets.filter((asset) => asset.type === "crypto");
  const cryptoQuotes = await fetchCryptoQuotes(cryptoAssets).catch((error) => {
    const fallback = new Map();
    for (const asset of cryptoAssets) {
      const cached = cache.get(asset.symbol)?.data;
      if (cached) fallback.set(asset.symbol, { ...cached, isStale: true });
    }
    fallback.error = error.message;
    return fallback;
  });
  const quotes = [];
  const failures = cryptoQuotes.error ? [{ symbol: "CRYPTO", message: cryptoQuotes.error }] : [];

  for (const asset of trackedAssets) {
    try {
      if (asset.type === "crypto") {
        const quote = cryptoQuotes.get(asset.symbol);
        if (!quote) throw new Error("Crypto source returned no quote");
        quotes.push(quote);
      } else {
        quotes.push(await fetchQuote(asset));
      }
    } catch (error) {
      failures.push({ symbol: asset.symbol, message: error.message });
      const cached = cache.get(asset.symbol)?.data;
      if (cached) {
        quotes.push({ ...cached, isStale: true });
      }
    }
  }

  const liveQuotes = quotes.filter((quote) => !quote.isStale).length;
  const status = liveQuotes === quotes.length ? "live" : liveQuotes > 0 ? "partial" : "offline";
  const cleanQuotes = quotes.filter(Boolean);
  return {
    source: "Nasdaq real-time quotes, CoinGecko crypto markets, Yahoo chart fallback",
    sources: ["Nasdaq", "CoinGecko", "Yahoo chart fallback", "Nasdaq RSS", "MarketWatch RSS"],
    transport: "http",
    status,
    latencyMs: Date.now() - startedAt,
    generatedAt: new Date().toISOString(),
    streamIntervalMs,
    cacheTtlMs,
    newsCacheTtlMs,
    liveQuotes,
    staleQuotes: cleanQuotes.length - liveQuotes,
    failures,
    portfolio: buildPortfolio(cleanQuotes),
    news: await fetchMarketNews(),
    quotes: cleanQuotes
  };
}

app.get("/api/asset/:symbol", async (request, response) => {
  const symbol = request.params.symbol.toUpperCase();
  if (!trackedAssets.some((asset) => asset.symbol === symbol)) {
    response.status(404).json({ error: "Unknown symbol" });
    return;
  }

  try {
    const quote = await fetchQuote(trackedAssets.find((asset) => asset.symbol === symbol));
    if (!quote || quote.price === null) {
      response.status(502).json({ error: "Unable to load asset", message: `${symbol} returned no price` });
      return;
    }
    response.json(quote);
  } catch (error) {
    response.status(502).json({ error: "Unable to load asset", message: error.message });
  }
});

async function fetchQuote(asset) {
  if (asset.type === "crypto") {
    return (await fetchCryptoQuotes([asset])).get(asset.symbol);
  }

  const existing = cache.get(asset.symbol);
  if (existing && Date.now() - existing.fetchedAt < cacheTtlMs) {
    return existing.data;
  }

  const quote = await fetchNasdaqQuote(asset, existing?.data);
  cache.set(asset.symbol, { fetchedAt: Date.now(), data: quote });
  return quote;
}

async function loadSentimentSnapshot(periodKey = "1y") {
  const chartPeriod = chartPeriods[periodKey] ?? chartPeriods["1y"];
  const cached = sentimentCache.get(chartPeriod.key);
  if (cached?.data && Date.now() - cached.fetchedAt < sentimentCacheTtlMs) {
    return cached.data;
  }

  const startedAt = Date.now();
  const failures = [];
  const [sp500, ndx, gold, vix, vxn, treasury, fearGreed, spRsi, ndxRsi, spPe, ndxPe, btc, mvrv] = await Promise.all([
    fetchIndexQuote("^spx", "^GSPC", chartPeriod).catch((error) =>
      failedValue(failures, "S&P 500", error)
    ),
    fetchIndexQuote("^ndx", "^NDX", chartPeriod).catch((error) =>
      failedValue(failures, "NASDAQ 100", error)
    ),
    fetchIndexQuote("xauusd", "GC=F", chartPeriod).catch((error) =>
      failedValue(failures, "XAU/USD", error)
    ),
    fetchCboeQuote("_VIX").catch((error) => failedValue(failures, "VIX", error)),
    fetchCboeQuote("_VXN").catch((error) => failedValue(failures, "VXN", error)),
    fetchTreasury10Year(chartPeriod).catch((error) => failedValue(failures, "10Y Treasury", error)),
    fetchCnnFearGreed().catch((error) => failedValue(failures, "CNN Fear & Greed", error)),
    fetchNfinRsi("SPY").catch((error) => failedValue(failures, "S&P RSI", error)),
    fetchNfinRsi("QQQ").catch((error) => failedValue(failures, "NDX RSI", error)),
    fetchSp500Pe().catch((error) => failedValue(failures, "S&P PE", error)),
    fetchNasdaq100Pe().catch((error) => failedValue(failures, "Nasdaq 100 PE", error)),
    fetchYahooQuote("BTC-USD", chartPeriod).catch((error) => failedValue(failures, "BTC/USD", error)),
    fetchMvrvZScore().catch((error) => failedValue(failures, "BTC MVRV Z-Score", error))
  ]);

  const liveCount = [sp500, ndx, gold, vix, vxn, treasury, fearGreed, spRsi, ndxRsi, spPe, ndxPe, btc, mvrv].filter(
    (item) => item?.isLive
  ).length;
  const snapshot = {
    status: liveCount ? (failures.length ? "partial" : "live") : "offline",
    generatedAt: new Date().toISOString(),
    displayDate: formatChineseDate(new Date()),
    latencyMs: Date.now() - startedAt,
    refreshIntervalMs: sentimentCacheTtlMs,
    chartPeriod: {
      key: chartPeriod.key,
      label: chartPeriod.label,
      source: "Yahoo Finance chart"
    },
    sources: [
      "Stooq",
      "Cboe delayed quotes",
      "US Treasury",
      "CNN Fear & Greed",
      "nfin Nasdaq API",
      "History of Market",
      "VCP Scanner",
      "Yahoo Finance fallback"
    ],
    failures,
    cards: {
      sp500: buildIndexCard({
        key: "sp500",
        title: "S&P 500 · ^GSPC",
        subtitleLabel: "标普500",
        quote: sp500,
        pe: spPe,
        accent: "green"
      }),
      ndx: buildIndexCard({
        key: "ndx",
        title: "NASDAQ 100 · ^NDX",
        subtitleLabel: "纳指100",
        quote: ndx,
        pe: ndxPe,
        accent: "purple"
      }),
      vix: buildVolatilityCard("VIX", "标普500波动率", vix, [
        [12, "极低波动", "控制追高"],
        [20, "正常波动", "按计划执行"],
        [30, "波动抬升", "分批观察"],
        [50, "恐慌区间", "等待确认"],
        [Infinity, "极端恐慌", "严控仓位"]
      ]),
      vxn: buildVolatilityCard("VXN", "纳指100波动率", vxn, [
        [15, "极低波动", "控制追高"],
        [22, "正常波动", "按计划执行"],
        [32, "波动抬升", "分批观察"],
        [55, "恐慌区间", "等待确认"],
        [Infinity, "极端恐慌", "严控仓位"]
      ]),
      spRsi: buildRsiCard("S&P RSI(14)", "标普500相对强弱 · RSI(14)", spRsi),
      ndxRsi: buildRsiCard("NDX RSI(14)", "纳指100相对强弱 · RSI(14)", ndxRsi),
      fearGreed: buildFearGreedCard(fearGreed),
      playbook: buildPlaybookCard(fearGreed),
      gold: buildMiniCard("GOLD\nXAU/USD", "伦敦金 · 美元/\n盎司", gold, "currency"),
      treasury: buildMiniCard("10Y\nUST ·\n^TNX", "十年期\n美国收益率", treasury, "percent"),
      btc: buildMiniCard("BTC\nBTC/USD", "比特币 ·\n美元", btc, "currency0"),
      btcMvrv: buildMvrvCard(mvrv)
    },
    strategy: buildStrategy(spRsi, ndxRsi, mvrv)
  };

  sentimentCache.set(chartPeriod.key, { fetchedAt: Date.now(), data: snapshot });
  return snapshot;
}

function failedValue(failures, symbol, error) {
  failures.push({ symbol, message: error.message });
  return { isLive: false, error: error.message, source: null };
}

async function fetchIndexQuote(stooqSymbol, yahooSymbol, chartPeriod = chartPeriods["1y"]) {
  try {
    return await fetchYahooQuote(yahooSymbol, chartPeriod);
  } catch (yahooError) {
    try {
      return await fetchStooqQuote(stooqSymbol, "Stooq", yahooSymbol, chartPeriod);
    } catch (stooqError) {
      throw new Error(`Yahoo: ${yahooError.message}; Stooq: ${stooqError.message}`);
    }
  }
}

async function fetchYahooQuote(symbol, chartPeriod = chartPeriods["1y"]) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`;
  const response = await fetchWithRetries(url, {
    headers: {
      "User-Agent": "Mozilla/5.0"
    },
    timeoutMs: quoteRequestTimeoutMs,
    retries: 1,
    retryDelayMs: 1500
  });
  if (!response.ok) throw new Error(`${symbol} Yahoo quote returned ${response.status}`);
  const payload = await response.json();
  const result = payload.chart?.result?.[0];
  const meta = result?.meta;
  const closes = (result?.indicators?.quote?.[0]?.close ?? []).filter(
    (value) => typeof value === "number" && Number.isFinite(value)
  );
  const price = numberOrNull(meta?.regularMarketPrice) ?? (closes.length ? closes[closes.length - 1] : null);
  if (price === null) throw new Error(`${symbol} returned no live quote`);
  const previousClose = closes.length >= 2 ? closes[closes.length - 2] : numberOrNull(meta?.chartPreviousClose);
  const change = previousClose === null ? null : price - previousClose;
  const changePercent = previousClose ? (change / previousClose) * 100 : null;
  const dayHigh = numberOrNull(meta?.regularMarketDayHigh);
  const dayLow = numberOrNull(meta?.regularMarketDayLow);
  const updatedAt = numberOrNull(meta?.regularMarketTime)
    ? new Date(meta.regularMarketTime * 1000).toISOString()
    : new Date().toISOString();
  const historicalSeries = await fetchYahooHistoricalSeries(symbol, chartPeriod).catch(() => null);
  return {
    symbol: meta?.symbol ?? symbol,
    name: meta?.longName ?? meta?.shortName ?? symbol,
    price,
    change,
    changePercent,
    open: previousClose,
    high: dayHigh,
    low: dayLow,
    volume: numberOrNull(meta?.regularMarketVolume),
    updatedAt,
    source: "Yahoo Finance",
    isLive: true,
    series: historicalSeries?.values ?? buildQuoteSeries(previousClose, dayLow, dayHigh, price),
    seriesLabels: historicalSeries?.labels ?? ["前收", "低点", "高点", "最新"],
    seriesSource: historicalSeries?.source ?? "Yahoo Finance",
    seriesPeriodLabel: historicalSeries?.periodLabel ?? "当日"
  };
}

async function fetchStooqQuote(symbol, source, historySymbol = null, chartPeriod = chartPeriods["1y"]) {
  const url = new URL("https://stooq.com/q/l/");
  url.searchParams.set("s", symbol);
  url.searchParams.set("f", "sd2t2ohlcvn");
  url.searchParams.set("h", "");
  url.searchParams.set("e", "csv");

  const response = await fetchWithTimeout(url, { timeoutMs: quoteRequestTimeoutMs });
  if (!response.ok) throw new Error(`${symbol} Stooq returned ${response.status}`);
  const csv = await response.text();
  const [, row] = csv.trim().split(/\r?\n/);
  const values = parseCsvRow(row);
  if (!values || values.some((value, index) => index > 0 && index < 7 && value === "N/D")) {
    throw new Error(`${symbol} returned no live quote`);
  }
  const [, date, time, open, high, low, close, volume, name] = values;
  const price = Number(close);
  const openPrice = Number(open);
  if (!Number.isFinite(price) || !Number.isFinite(openPrice)) {
    throw new Error(`${symbol} Stooq returned a non-CSV response (likely bot challenge)`);
  }
  const change = price - openPrice;
  const changePercent = openPrice ? (change / openPrice) * 100 : null;
  const historicalSeries = historySymbol
    ? await fetchYahooHistoricalSeries(historySymbol, chartPeriod).catch(() => null)
    : null;
  return {
    symbol: values[0],
    name,
    price,
    change,
    changePercent,
    open: openPrice,
    high: Number(high),
    low: Number(low),
    volume: Number(volume) || null,
    updatedAt: `${date}T${time}Z`,
    date,
    time,
    source,
    isLive: true,
    series: historicalSeries?.values ?? buildQuoteSeries(Number(open), Number(low), Number(high), price),
    seriesLabels: historicalSeries?.labels ?? ["开盘", "低点", "高点", "最新"],
    seriesSource: historicalSeries?.source ?? source,
    seriesPeriodLabel: historicalSeries?.periodLabel ?? "当日"
  };
}

function parseCsvRow(row) {
  if (!row) return null;
  const values = [];
  let current = "";
  let quoted = false;
  for (const char of row) {
    if (char === '"') quoted = !quoted;
    else if (char === "," && !quoted) {
      values.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  values.push(current);
  return values;
}

// MVRV Z-Score = (市值 − 已实现市值) / 市值标准差，日更指标。
// bitcoin-data.com 免费档限 8 次/小时，独立长缓存并在源失败时回退旧值。
const mvrvBands = [
  [0, "历史底部区", "重仓买入"],
  [2, "低估积累区", "坚持定投"],
  [3.5, "合理偏高", "持有观察"],
  [6, "牛市偏热", "分批止盈"],
  [7, "顶部预警", "大幅减仓"],
  [Infinity, "极度泡沫", "清仓离场"]
];
const mvrvBandsEn = ["BOTTOM ZONE", "ACCUMULATE", "FAIR-HIGH", "OVERHEATED", "TOP WARNING", "BUBBLE"];
let mvrvCache = null;
const mvrvCacheTtlMs = 3 * 60 * 60 * 1000;

async function fetchMvrvZScore() {
  if (mvrvCache && Date.now() - mvrvCache.fetchedAt < mvrvCacheTtlMs) return mvrvCache.data;
  try {
    const response = await fetchWithTimeout("https://bitcoin-data.com/v1/mvrv-zscore/last", {
      timeoutMs: quoteRequestTimeoutMs,
      headers: { Accept: "application/json" }
    });
    if (!response.ok) throw new Error(`MVRV bitcoin-data returned ${response.status}`);
    const payload = await response.json();
    const value = Number(payload.mvrvZscore);
    if (!Number.isFinite(value)) throw new Error("MVRV returned no numeric value");
    const data = { value, date: payload.d, source: "bitcoin-data.com", isLive: true };
    mvrvCache = { fetchedAt: Date.now(), data };
    return data;
  } catch (error) {
    if (mvrvCache?.data) return mvrvCache.data;
    throw error;
  }
}

function mvrvActiveIndex(value) {
  return typeof value === "number" ? mvrvBands.findIndex(([limit]) => value < limit) : -1;
}

function buildMvrvCard(mvrv) {
  const rows = mvrvBands.map((row, index) => ({
    range:
      index === 0
        ? `< ${row[0]}`
        : index === mvrvBands.length - 1
          ? `> ${mvrvBands[index - 1][0]}`
          : `${mvrvBands[index - 1][0]}-${row[0]}`,
    mood: row[1],
    action: row[2]
  }));
  const value = mvrv?.isLive ? numberOrNull(mvrv.value) : null;
  const active = mvrvActiveIndex(value);
  const row = active >= 0 ? mvrvBands[active] : null;
  return {
    kind: "band",
    accent: "orange",
    title: "BTC MVRV Z-Score",
    subtitle: `比特币估值 · (市值−已实现市值)/市值标准差${mvrv?.date ? ` · ${mvrv.date}` : ""}`,
    value,
    pill: row?.[1] ?? "不可用",
    pillEn: active >= 0 ? mvrvBandsEn[active] : "NO SOURCE",
    active,
    rows,
    source: mvrv?.source ?? "bitcoin-data.com",
    isLive: Boolean(mvrv?.isLive),
    error: mvrv?.error ?? null
  };
}

async function fetchCboeQuote(symbol) {
  const response = await fetchWithTimeout(`https://cdn.cboe.com/api/global/delayed_quotes/quotes/${symbol}.json`, {
    timeoutMs: quoteRequestTimeoutMs
  });
  if (!response.ok) throw new Error(`${symbol} Cboe returned ${response.status}`);
  const payload = await response.json();
  const data = payload.data;
  if (!data || typeof data.current_price !== "number") throw new Error(`${symbol} returned no quote`);
  return {
    symbol: data.symbol,
    price: data.current_price,
    change: numberOrNull(data.price_change) ?? 0,
    changePercent: numberOrNull(data.price_change_percent) ?? 0,
    open: numberOrNull(data.open),
    high: numberOrNull(data.high),
    low: numberOrNull(data.low),
    updatedAt: data.last_trade_time || payload.timestamp,
    source: "Cboe delayed quotes",
    isLive: true,
    series: buildQuoteSeries(data.open, data.low, data.high, data.current_price)
  };
}

async function fetchTreasury10Year(chartPeriod = chartPeriods["1y"]) {
  const now = new Date();
  const month = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const url = `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data=daily_treasury_yield_curve&field_tdr_date_value_month=${month}`;
  const response = await fetchWithTimeout(url, { timeoutMs: newsRequestTimeoutMs });
  if (!response.ok) throw new Error(`Treasury returned ${response.status}`);
  const xml = await response.text();
  const entries = [...xml.matchAll(/<entry\b[\s\S]*?<\/entry>/g)].map((match) => match[0]);
  const rows = entries
    .map((entry) => ({
      date: readXmlTag(entry, "d:NEW_DATE"),
      value: numberOrNull(Number(readXmlTag(entry, "d:BC_10YEAR")))
    }))
    .filter((row) => row.date && typeof row.value === "number");
  if (!rows.length) throw new Error("Treasury returned no 10Y data");
  const latest = rows.at(-1);
  const previous = rows.at(-2) ?? latest;
  const historicalSeries = await fetchYahooHistoricalSeries("^TNX", chartPeriod).catch(() => null);
  return {
    symbol: "^TNX",
    price: latest.value,
    change: latest.value - previous.value,
    changePercent: previous.value ? ((latest.value - previous.value) / previous.value) * 100 : 0,
    updatedAt: latest.date,
    source: "US Treasury",
    isLive: true,
    series: historicalSeries?.values ?? rows.slice(-8).map((row) => row.value),
    seriesLabels: historicalSeries?.labels ?? rows.slice(-8).map((row) => row.date),
    seriesSource: historicalSeries?.source ?? "US Treasury",
    seriesPeriodLabel: historicalSeries?.periodLabel ?? "当月"
  };
}

async function fetchCnnFearGreed() {
  const response = await fetchWithTimeout("https://production.dataviz.cnn.io/index/fearandgreed/graphdata", {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36",
      Accept: "application/json"
    },
    timeoutMs: newsRequestTimeoutMs
  });
  if (!response.ok) throw new Error(`CNN returned ${response.status}`);
  const text = await response.text();
  if (!text.trim().startsWith("{")) throw new Error("CNN blocked the realtime request");
  const payload = JSON.parse(text);
  const data = payload.fear_and_greed;
  if (!data || typeof data.score !== "number") throw new Error("CNN returned no fear/greed score");
  return {
    score: data.score,
    rating: data.rating,
    updatedAt: data.timestamp ? new Date(data.timestamp).toISOString() : new Date().toISOString(),
    source: "CNN Fear & Greed",
    isLive: true
  };
}

async function fetchYahooRsi(symbol) {
  const points = await fetchYahooDailySeries(symbol, "6mo");
  if (points.length < 20) throw new Error(`${symbol} returned insufficient RSI data`);
  return {
    value: calculateRsi(points.map((point) => point.value), 14),
    change: calculateRsi(points.slice(0, -1).map((point) => point.value), 14),
    updatedAt: points.at(-1).time,
    source: "Yahoo Finance chart",
    isLive: true
  };
}

async function fetchNfinRsi(symbol) {
  const points = await fetchNfinHistoricalCloses(symbol);
  if (points.length < 20) throw new Error(`${symbol} nfin returned insufficient RSI data`);
  return {
    value: calculateRsi(points.map((point) => point.value), 14),
    change: calculateRsi(points.slice(0, -1).map((point) => point.value), 14),
    updatedAt: points.at(-1).time,
    source: "nfin Nasdaq API",
    isLive: true
  };
}

async function fetchNfinHistoricalCloses(symbol) {
  const url = new URL(`https://api.nfin.dev/v1/quote/${symbol}/historical`);
  url.searchParams.set("asset_class", "etf");
  url.searchParams.set("limit", "80");
  const response = await fetchWithRetries(url, {
    timeoutMs: quoteRequestTimeoutMs,
    retries: 2,
    retryDelayMs: 2500
  });
  if (!response.ok) throw new Error(`${symbol} nfin historical returned ${response.status}`);
  const payload = await response.json();
  const rows = payload.data?.data?.tradesTable?.rows ?? [];
  return rows
    .map((row) => ({
      time: parseUsDate(row.date),
      value: parseMarketNumber(row.close)
    }))
    .filter((point) => point.time && typeof point.value === "number")
    .sort((a, b) => new Date(a.time) - new Date(b.time));
}

async function fetchSp500Pe() {
  const response = await fetchWithRetries("https://historyofmarket.com/api/sp500/forward-pe.json", {
    timeoutMs: newsRequestTimeoutMs,
    retries: 2,
    retryDelayMs: 2500
  });
  if (!response.ok) throw new Error(`History of Market S&P PE returned ${response.status}`);
  const payload = await response.json();
  const trailing = numberOrNull(payload.current?.trailing);
  const forward = numberOrNull(payload.current?.forward);
  if (typeof trailing !== "number" && typeof forward !== "number") {
    throw new Error("History of Market returned no S&P PE data");
  }
  return {
    pe: trailing,
    forwardPe: forward,
    peRank: percentileRank(payload.trailing, trailing),
    forwardRank: percentileRank(payload.forward, forward),
    source: "History of Market",
    isLive: true
  };
}

async function fetchNasdaq100Pe() {
  try {
    return await fetchVcpNasdaq100Pe();
  } catch (primaryError) {
    try {
      return await fetchYahooPe("QQQ");
    } catch (fallbackError) {
      throw new Error(`VCP Scanner: ${primaryError.message}; Yahoo fallback: ${fallbackError.message}`);
    }
  }
}

async function fetchVcpNasdaq100Pe() {
  const response = await fetchWithRetries("https://vcpscanner.com/market-valuation/nasdaq-100", {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36",
      Accept: "text/html"
    },
    timeoutMs: newsRequestTimeoutMs,
    retries: 2,
    retryDelayMs: 2500
  });
  if (!response.ok) throw new Error(`Nasdaq 100 PE returned ${response.status}`);
  const html = await response.text();
  const text = html
    .replace(/<!--\s*-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const summary = text.match(
    /Nasdaq 100\s+P\/E ratio is\s+([\d.]+)x\s+as of\s+([0-9-]+),\s+with a forward P\/E of\s+([\d.]+)x/i
  );
  const fallback = text.match(/Trailing P\/E\s+([\d.]+)\s*x[\s\S]{0,240}?Forward P\/E\s+([\d.]+)\s*x/i);
  const pe = summary ? Number(summary[1]) : fallback ? Number(fallback[1]) : null;
  const forwardPe = summary ? Number(summary[3]) : fallback ? Number(fallback[2]) : null;
  if (typeof pe !== "number" || !Number.isFinite(pe) || typeof forwardPe !== "number" || !Number.isFinite(forwardPe)) {
    throw new Error("Nasdaq 100 PE page returned no parseable PE data");
  }
  return {
    pe,
    forwardPe,
    peRank: null,
    forwardRank: null,
    updatedAt: summary?.[2] ?? null,
    source: "VCP Scanner",
    isLive: true
  };
}

async function fetchYahooPe(symbol) {
  const url = new URL(`https://query2.finance.yahoo.com/v10/finance/quoteSummary/${symbol}`);
  url.searchParams.set("modules", "summaryDetail,defaultKeyStatistics");
  const response = await fetchWithRetries(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36"
    },
    timeoutMs: chartRequestTimeoutMs,
    retries: 2,
    retryDelayMs: 6000
  });
  if (!response.ok) throw new Error(`${symbol} Yahoo PE returned ${response.status}`);
  const payload = await response.json();
  const data = payload.quoteSummary?.result?.[0];
  const pe = data?.summaryDetail?.trailingPE?.raw ?? data?.defaultKeyStatistics?.trailingPE?.raw;
  const forwardPe = data?.summaryDetail?.forwardPE?.raw ?? data?.defaultKeyStatistics?.forwardPE?.raw;
  if (typeof pe !== "number" && typeof forwardPe !== "number") throw new Error(`${symbol} returned no PE metrics`);
  return {
    pe: numberOrNull(pe),
    forwardPe: numberOrNull(forwardPe),
    source: "Yahoo Finance quoteSummary",
    isLive: true
  };
}

async function fetchYahooHistoricalSeries(symbol, chartPeriod = chartPeriods["1y"]) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=${chartPeriod.yahooRange}`;
  const response = await fetchWithRetries(url, {
    headers: {
      "User-Agent": "Mozilla/5.0"
    },
    timeoutMs: chartRequestTimeoutMs,
    retries: 2,
    retryDelayMs: 2500
  });
  if (!response.ok) throw new Error(`${symbol} Yahoo historical returned ${response.status}`);
  const payload = await response.json();
  const result = payload.chart?.result?.[0];
  const closes = result?.indicators?.adjclose?.[0]?.adjclose ?? result?.indicators?.quote?.[0]?.close ?? [];
  const timestamps = result?.timestamp ?? [];
  const points = closes
    .map((value, index) => ({
      value,
      label: timestamps[index] ? formatAxisDate(new Date(timestamps[index] * 1000)) : null
    }))
    .filter((point) => typeof point.value === "number" && Number.isFinite(point.value) && point.label);
  if (points.length < 20) throw new Error(`${symbol} returned insufficient historical series`);
  const sampled = sampleSeries(points, chartPeriod.maxPoints);
  return {
    values: sampled.map((point) => point.value),
    labels: sampled.map((point) => point.label),
    source: "Yahoo Finance chart",
    periodLabel: chartPeriod.label
  };
}

async function fetchYahooDailySeries(symbol, range = "6mo") {
  const url = new URL(`https://query2.finance.yahoo.com/v8/finance/chart/${symbol}`);
  url.searchParams.set("interval", "1d");
  url.searchParams.set("range", range);
  const response = await fetchWithRetries(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36"
    },
    timeoutMs: chartRequestTimeoutMs,
    retries: 2,
    retryDelayMs: 6000
  });
  if (!response.ok) throw new Error(`${symbol} Yahoo chart returned ${response.status}`);
  const payload = await response.json();
  const result = payload.chart?.result?.[0];
  const closes = result?.indicators?.quote?.[0]?.close ?? [];
  const timestamps = result?.timestamp ?? [];
  return closes
    .map((close, index) => ({
      time: timestamps[index] ? new Date(timestamps[index] * 1000).toISOString() : null,
      value: numberOrNull(close)
    }))
    .filter((point) => point.time && typeof point.value === "number");
}

function buildIndexCard({ title, subtitleLabel, quote, pe, accent }) {
  const unavailable = !quote?.isLive;
  const change = numberOrNull(quote?.change);
  const changePercent = numberOrNull(quote?.changePercent);
  return {
    kind: "index",
    accent,
    title,
    subtitle: unavailable ? `${subtitleLabel} · 实时源不可用` : `${subtitleLabel} · ${formatMarketDate(quote.updatedAt)}最新`,
    value: unavailable ? null : quote.price,
    badge: formatPercentBadge(changePercent),
    badgeTone: change >= 0 ? "red" : "green",
    change,
    changePercent,
    moveLabel: describeMove(change),
    pe: pe?.isLive ? pe.pe : null,
    peRank: pe?.isLive ? pe.peRank : null,
    forwardPe: pe?.isLive ? pe.forwardPe : null,
    forwardRank: pe?.isLive ? pe.forwardRank : null,
    metricsUpdatedAt: pe?.isLive ? pe.updatedAt : null,
    series: quote?.series ?? [],
    seriesLabels: quote?.seriesLabels ?? [],
    seriesSource: quote?.seriesSource ?? quote?.source,
    seriesPeriodLabel: quote?.seriesPeriodLabel ?? null,
    source: quote?.source,
    isLive: Boolean(quote?.isLive),
    error: quote?.error ?? null,
    metricsSource: pe?.isLive ? pe.source : null,
    metricsError: pe?.error ?? null
  };
}

function buildVolatilityCard(label, subtitle, quote, thresholds) {
  const rows = thresholds.map((row, index) => ({
    range:
      index === 0
        ? `< ${row[0]}`
        : index === thresholds.length - 1
          ? `> ${thresholds[index - 1][0]}`
          : `${thresholds[index - 1][0]}-${row[0]}`,
    mood: row[1],
    action: row[2]
  }));
  const active = quote?.isLive ? thresholds.findIndex(([limit]) => quote.price < limit) : -1;
  const row = active >= 0 ? thresholds[active] : null;
  return {
    kind: "band",
    accent: label === "VIX" ? "green" : "purple",
    title: `${label} · ${formatSignedPercent(quote?.changePercent)}`,
    subtitle: `${subtitle} · ${formatSignedNumber(quote?.change)}`,
    value: quote?.isLive ? quote.price : null,
    pill: row?.[1] ?? "不可用",
    pillEn: quote?.isLive ? englishVolatility(row?.[1]) : "NO SOURCE",
    active,
    rows,
    source: quote?.source,
    isLive: Boolean(quote?.isLive),
    error: quote?.error ?? null
  };
}

function buildRsiCard(title, subtitle, rsi) {
  const value = numberOrNull(rsi?.value);
  const previous = numberOrNull(rsi?.change);
  const delta = typeof value === "number" && typeof previous === "number" ? value - previous : null;
  const active = typeof value === "number" ? [30, 50, 70, 80, Infinity].findIndex((limit) => value < limit) : -1;
  const labels = ["超卖", "偏弱", "中性偏强", "偏热", "过热"];
  return {
    kind: "band",
    accent: title.startsWith("S&P") ? "green" : "purple",
    title: `${title} · ${formatSignedNumber(delta, 1)}`,
    subtitle,
    value,
    pill: active >= 0 ? labels[active] : "不可用",
    pillEn: active >= 0 ? (active >= 3 ? "STRONG" : active === 0 ? "OVERSOLD" : "NEUTRAL") : "NO SOURCE",
    active,
    rows: [
      { range: "< 30", mood: "超卖", action: "可增加定投" },
      { range: "30-50", mood: "偏弱", action: "分批观察" },
      { range: "50-70", mood: "中性偏强", action: "按计划执行" },
      { range: "70-80", mood: "偏热", action: "控制追高" },
      { range: "> 80", mood: "过热", action: "降低新增" }
    ],
    source: rsi?.source,
    isLive: Boolean(rsi?.isLive),
    error: rsi?.error ?? null
  };
}

function buildFearGreedCard(fearGreed) {
  const score = numberOrNull(fearGreed?.score);
  const active = typeof score === "number" ? [25, 45, 56, 76, Infinity].findIndex((limit) => score < limit) : -1;
  const moods = ["极度恐惧", "恐惧", "中性", "贪婪", "极度贪婪"];
  const english = ["EXTREME FEAR", "FEAR", "NEUTRAL", "GREED", "EXTREME GREED"];
  return {
    kind: "fear",
    accent: "yellow",
    title: fearGreed?.isLive ? "FEAR & GREED" : "FEAR & GREED · 实时源不可用",
    subtitle: "恐惧与贪婪指数 · 针对标普500",
    value: score,
    pill: active >= 0 ? moods[active] : "不可用",
    pillEn: active >= 0 ? english[active] : "NO SOURCE",
    active,
    source: fearGreed?.source,
    isLive: Boolean(fearGreed?.isLive),
    error: fearGreed?.error ?? null
  };
}

function buildPlaybookCard(fearGreed) {
  const score = numberOrNull(fearGreed?.score);
  const active = typeof score === "number" ? [25, 45, 56, 76, Infinity].findIndex((limit) => score < limit) : -1;
  return {
    kind: "playbook",
    accent: "yellow",
    title: "F&G PLAYBOOK",
    subtitle: "F&G · 针对标普500",
    active,
    rows: [
      { range: "0-24", mood: "极度恐惧", action: "分批低吸" },
      { range: "25-44", mood: "恐惧", action: "分批观察" },
      { range: "45-55", mood: "中性", action: "按计划执行" },
      { range: "56-75", mood: "贪婪", action: "控制追高" },
      { range: "76-100", mood: "极度贪婪", action: "降低新增" }
    ],
    source: fearGreed?.source,
    isLive: Boolean(fearGreed?.isLive),
    error: fearGreed?.error ?? null
  };
}

function buildMiniCard(title, subtitle, quote, format) {
  return {
    kind: "mini",
    accent: title.startsWith("GOLD") ? "yellow" : title.startsWith("BTC") ? "orange" : "blue",
    title,
    subtitle,
    value: quote?.isLive ? quote.price : null,
    valueFormat: format,
    badge: title.startsWith("10Y") ? formatSignedBasisPoint(quote?.change) : formatPercentBadge(quote?.changePercent),
    change: quote?.change ?? null,
    changePercent: quote?.changePercent ?? null,
    series: quote?.series ?? [],
    seriesLabels: quote?.seriesLabels ?? [],
    seriesSource: quote?.seriesSource ?? quote?.source,
    seriesPeriodLabel: quote?.seriesPeriodLabel ?? null,
    source: quote?.source,
    isLive: Boolean(quote?.isLive),
    error: quote?.error ?? null
  };
}

function buildStrategy(spRsi, ndxRsi, mvrv) {
  return [
    buildStrategyItem("sp", "标普500", spRsi),
    buildStrategyItem("ndx", "纳指100", ndxRsi),
    buildBtcStrategyItem(mvrv)
  ];
}

function buildBtcStrategyItem(mvrv) {
  const value = mvrv?.isLive ? numberOrNull(mvrv.value) : null;
  const active = mvrvActiveIndex(value);
  const scores = [2, 1, 0, -1, -2, -2];
  return {
    key: "btc",
    score: active >= 0 ? scores[active] : null,
    action: active >= 0 ? mvrvBands[active][2] : "等待实时源",
    detail:
      active >= 0
        ? `比特币 MVRV Z ${value.toFixed(2)} · ${mvrvBands[active][1]}`
        : "比特币 MVRV Z · 实时源不可用",
    isLive: Boolean(mvrv?.isLive)
  };
}

function buildStrategyItem(key, label, rsi) {
  const value = numberOrNull(rsi?.value);
  const score = typeof value === "number" ? (value >= 70 ? -1 : value < 30 ? 1 : 0) : null;
  const action = typeof value === "number" ? (value >= 70 ? "控制追高" : value < 30 ? "增加定投" : "按计划执行") : "等待实时源";
  const state = typeof value === "number" ? (value >= 70 ? "偏热" : value < 30 ? "超卖" : "中性") : "不可用";
  return {
    key,
    score,
    action,
    detail: typeof value === "number" ? `${label} RSI ${value.toFixed(1)} · ${state}` : `${label} RSI · 实时源不可用`,
    isLive: Boolean(rsi?.isLive)
  };
}

function calculateRsi(values, period) {
  if (values.length <= period) return null;
  const changes = values.slice(1).map((value, index) => value - values[index]);
  let gains = 0;
  let losses = 0;
  for (const change of changes.slice(0, period)) {
    if (change >= 0) gains += change;
    else losses -= change;
  }
  let averageGain = gains / period;
  let averageLoss = losses / period;
  for (const change of changes.slice(period)) {
    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);
    averageGain = (averageGain * (period - 1) + gain) / period;
    averageLoss = (averageLoss * (period - 1) + loss) / period;
  }
  if (averageLoss === 0) return 100;
  return 100 - 100 / (1 + averageGain / averageLoss);
}

function buildQuoteSeries(open, low, high, close) {
  const values = [open, low, high, close].filter((value) => typeof value === "number" && Number.isFinite(value));
  if (values.length >= 4) return values;
  if (values.length >= 2) return values;
  return [];
}

function sampleSeries(values, maxPoints) {
  if (!Array.isArray(values) || values.length <= maxPoints) return values;
  const sampled = [];
  const step = (values.length - 1) / (maxPoints - 1);
  for (let index = 0; index < maxPoints; index += 1) {
    sampled.push(values[Math.round(index * step)]);
  }
  return sampled;
}

function describeMove(change) {
  if (typeof change !== "number") return "实时源不可用";
  if (Math.abs(change) < 0.01) return "持平";
  return change > 0 ? "上涨" : "下跌";
}

function englishVolatility(label) {
  const map = {
    极低波动: "LOW",
    正常波动: "NORMAL",
    波动抬升: "ELEVATED",
    恐慌区间: "FEAR",
    极端恐慌: "PANIC"
  };
  return map[label] ?? "LIVE";
}

function formatChineseDate(date) {
  const local = new Date(date.toLocaleString("en-US", { timeZone: "Asia/Shanghai" }));
  const weekdays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  return `${local.getFullYear()} · ${String(local.getMonth() + 1).padStart(2, "0")} · ${String(
    local.getDate()
  ).padStart(2, "0")} / ${weekdays[local.getDay()]}`;
}

function formatMarketDate(value) {
  if (!value) return "实时";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "实时";
  return `${date.getUTCMonth() + 1}月${date.getUTCDate()}日`;
}

function formatAxisDate(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  return `${date.getUTCFullYear()}.${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function formatPercentBadge(value) {
  if (typeof value !== "number") return "实时源不可用";
  return `${value >= 0 ? "▲ +" : "▼ "}${value.toFixed(2)}%`;
}

function formatSignedPercent(value) {
  if (typeof value !== "number") return "实时源不可用";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function formatSignedNumber(value, digits = 2) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "实时源不可用";
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;
}

function formatSignedBasisPoint(value) {
  if (typeof value !== "number") return "实时源不可用";
  return `${value >= 0 ? "▲ +" : "▼ "}${value.toFixed(2)}pp`;
}

async function fetchNasdaqQuote(asset, existingData) {
  const url = new URL(`https://api.nasdaq.com/api/quote/${asset.symbol}/info`);
  url.searchParams.set("assetclass", asset.type);

  const remoteResponse = await fetchWithTimeout(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36",
      Accept: "application/json"
    },
    timeoutMs: quoteRequestTimeoutMs
  });

  if (!remoteResponse.ok) {
    if (existingData) return existingData;
    throw new Error(`${asset.symbol} Nasdaq returned ${remoteResponse.status}`);
  }

  const payload = await remoteResponse.json();
  const data = payload.data;
  const primary = data?.primaryData;
  if (!data || !primary) {
    if (existingData) return existingData;
    throw new Error(`${asset.symbol} Nasdaq returned no quote data`);
  }

  const price = parseMarketNumber(primary.lastSalePrice);
  const change = parseMarketNumber(primary.netChange) ?? 0;
  const changePercent = parsePercent(primary.percentageChange) ?? 0;
  const previous = price !== null ? price - change : null;
  const chartPoints = await fetchYahooChart(asset.symbol).catch(() => null);
  const points = chartPoints?.length ? chartPoints : buildFallbackPoints(previous, price, changePercent);
  const pointValues = points.map((point) => point.value).filter((value) => typeof value === "number");

  return {
    symbol: asset.symbol,
    name: data.companyName || asset.name,
    displayName: asset.name,
    sector: asset.sector,
    currency: "USD",
    exchange: data.exchange || "Market",
    marketState: data.marketStatus || "UNKNOWN",
    price,
    previousClose: previous,
    change,
    changePercent,
    dayHigh: pointValues.length ? Math.max(...pointValues) : null,
    dayLow: pointValues.length ? Math.min(...pointValues) : null,
    volume: parseMarketNumber(primary.volume),
    points,
    source: "Nasdaq",
    isRealTime: Boolean(primary.isRealTime),
    isStale: false,
    updatedAt: parseNasdaqTime(primary.lastTradeTimestamp)
  };
}

async function fetchYahooChart(symbol) {

  const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}`);
  url.searchParams.set("interval", "5m");
  url.searchParams.set("range", "1d");
  url.searchParams.set("includePrePost", "true");

  const remoteResponse = await fetchWithTimeout(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36"
    },
    timeoutMs: chartRequestTimeoutMs
  });

  if (!remoteResponse.ok) {
    throw new Error(`${symbol} returned ${remoteResponse.status}`);
  }

  const payload = await remoteResponse.json();
  const result = payload.chart?.result?.[0];
  if (!result) {
    throw new Error(`${symbol} returned no chart data`);
  }

  const closes = result.indicators?.quote?.[0]?.close ?? [];
  const timestamps = result.timestamp ?? [];
  return closes
    .map((close, index) => ({
      time: timestamps[index] ? timestamps[index] * 1000 : null,
      value: typeof close === "number" ? close : null
    }))
    .filter((point) => point.value !== null);
}

async function fetchCryptoQuotes(assets) {
  const result = new Map();
  const uncached = assets.filter((asset) => {
    const existing = cache.get(asset.symbol);
    if (existing && Date.now() - existing.fetchedAt < cacheTtlMs) {
      result.set(asset.symbol, existing.data);
      return false;
    }
    return true;
  });

  if (!uncached.length) return result;

  const url = new URL("https://api.coingecko.com/api/v3/coins/markets");
  url.searchParams.set("vs_currency", "usd");
  url.searchParams.set("ids", uncached.map((asset) => asset.coinGeckoId).join(","));
  url.searchParams.set("sparkline", "true");
  url.searchParams.set("price_change_percentage", "24h");

  const remoteResponse = await fetchWithTimeout(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36"
    },
    timeoutMs: quoteRequestTimeoutMs
  });

  if (!remoteResponse.ok) {
    for (const asset of uncached) {
      const existing = cache.get(asset.symbol);
      if (existing) result.set(asset.symbol, existing.data);
    }
    return result;
  }

  const payload = await remoteResponse.json();
  for (const asset of uncached) {
    const coin = payload.find((item) => item.id === asset.coinGeckoId);
    if (!coin) {
      const existing = cache.get(asset.symbol);
      if (existing) result.set(asset.symbol, existing.data);
      continue;
    }
    const points = (coin?.sparkline_in_7d?.price ?? []).map((value, index) => ({
      time: Date.now() - (coin.sparkline_in_7d.price.length - index) * 60 * 60 * 1000,
      value
    }));
    const price = numberOrNull(coin?.current_price);
    const change = numberOrNull(coin?.price_change_24h) ?? 0;
    const changePercent = numberOrNull(coin?.price_change_percentage_24h) ?? 0;
    const data = {
      symbol: asset.symbol,
      name: coin?.name || asset.name,
      displayName: asset.name,
      sector: asset.sector,
      currency: "USD",
      exchange: "CoinGecko",
      marketState: "24H",
      price,
      previousClose: price !== null ? price - change : null,
      change,
      changePercent,
      dayHigh: numberOrNull(coin?.high_24h),
      dayLow: numberOrNull(coin?.low_24h),
      volume: numberOrNull(coin?.total_volume),
      points: points.length ? points : buildFallbackPoints(price - change, price, changePercent),
      source: "CoinGecko",
      isRealTime: true,
      isStale: false,
      updatedAt: coin?.last_updated || new Date().toISOString()
    };

    cache.set(asset.symbol, { fetchedAt: Date.now(), data });
    result.set(asset.symbol, data);
  }

  return result;
}

function buildFallbackPoints(previous, current, changePercent) {
  if (typeof previous !== "number" || typeof current !== "number") return [];
  const points = [];
  for (let index = 0; index < 36; index += 1) {
    const progress = index / 35;
    const wave = Math.sin(progress * Math.PI * 3) * Math.abs(changePercent) * 0.002 * previous;
    points.push({
      time: Date.now() - (35 - index) * 5 * 60 * 1000,
      value: previous + (current - previous) * progress + wave
    });
  }
  return points;
}

function parseMarketNumber(value) {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return null;
  const parsed = Number(value.replace(/[$,%+,\s]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function parsePercent(value) {
  return parseMarketNumber(value);
}

function parseNasdaqTime(value) {
  if (!value) return new Date().toISOString();
  const parsed = Date.parse(value.replace(" ET", " -0400"));
  return Number.isNaN(parsed) ? new Date().toISOString() : new Date(parsed).toISOString();
}

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseUsDate(value) {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

function percentileRank(series, value) {
  if (typeof value !== "number" || !Array.isArray(series) || !series.length) return null;
  const values = series.map((item) => numberOrNull(item.value)).filter((item) => typeof item === "number");
  if (!values.length) return null;
  const lowerOrEqual = values.filter((item) => item <= value).length;
  return (lowerOrEqual / values.length) * 100;
}

async function fetchWithTimeout(url, options = {}) {
  const { timeoutMs = 8_000, ...fetchOptions } = options;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...fetchOptions, signal: controller.signal });
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`${url} timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchWithRetries(url, options = {}) {
  const { retries = 2, retryDelayMs = 2_000, ...fetchOptions } = options;
  let lastResponse = null;
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetchWithTimeout(url, fetchOptions);
      if (response.status !== 429 || attempt === retries) return response;
      lastResponse = response;
      const retryAfter = Number(response.headers.get("Retry-After"));
      const delayMs = Number.isFinite(retryAfter) ? retryAfter * 1000 : retryDelayMs * (attempt + 1);
      await sleep(delayMs);
    } catch (error) {
      lastError = error;
      if (attempt === retries) throw error;
      await sleep(retryDelayMs * (attempt + 1));
    }
  }

  if (lastError) throw lastError;
  return lastResponse;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildPortfolio(quotes) {
  const quoteBySymbol = new Map(quotes.map((quote) => [quote.symbol, quote]));
  const positions = portfolioHoldings
    .map((holding) => {
      const quote = quoteBySymbol.get(holding.symbol);
      if (!quote || quote.price === null) return null;

      const value = quote.price * holding.shares;
      const previousPrice = quote.previousClose ?? quote.price - quote.change;
      const previousValue = previousPrice * holding.shares;
      return {
        symbol: holding.symbol,
        name: quote.displayName,
        sector: quote.sector,
        shares: holding.shares,
        price: quote.price,
        value,
        previousValue,
        dayChange: value - previousValue,
        dayChangePercent: previousValue ? ((value - previousValue) / previousValue) * 100 : 0,
        quoteChangePercent: quote.changePercent,
        source: quote.source,
        updatedAt: quote.updatedAt
      };
    })
    .filter(Boolean);

  const investedValue = positions.reduce((total, position) => total + position.value, 0);
  const previousInvestedValue = positions.reduce((total, position) => total + position.previousValue, 0);
  const totalValue = investedValue + cashBalance;
  const previousTotalValue = previousInvestedValue + cashBalance;
  const dayChange = totalValue - previousTotalValue;
  const positionsWithAllocation = positions.map((position) => ({
    ...position,
    allocationPercent: investedValue ? (position.value / investedValue) * 100 : 0
  }));

  return {
    cash: cashBalance,
    investedValue,
    totalValue,
    previousTotalValue,
    dayChange,
    dayChangePercent: previousTotalValue ? (dayChange / previousTotalValue) * 100 : 0,
    allocations: buildAllocations(positionsWithAllocation, totalValue),
    positions: positionsWithAllocation
  };
}

function buildAllocations(positions, totalValue) {
  const allocationMap = new Map();
  for (const position of positions) {
    const key = position.sector || "Other";
    const existing = allocationMap.get(key) ?? { name: key, value: 0, dayChange: 0, symbols: [] };
    existing.value += position.value;
    existing.dayChange += position.dayChange;
    existing.symbols.push(position.symbol);
    allocationMap.set(key, existing);
  }

  if (cashBalance > 0) {
    allocationMap.set("Cash", {
      name: "Cash",
      value: cashBalance,
      dayChange: 0,
      symbols: ["USD"]
    });
  }

  return Array.from(allocationMap.values())
    .map((allocation) => ({
      ...allocation,
      percent: totalValue ? (allocation.value / totalValue) * 100 : 0
    }))
    .sort((a, b) => b.value - a.value);
}

async function fetchMarketNews() {
  if (Date.now() - newsCache.fetchedAt < newsCacheTtlMs && newsCache.data.length) {
    return newsCache.data;
  }

  const sources = [
    {
      name: "Nasdaq",
      url: "https://www.nasdaq.com/feed/rssoutbound?category=Markets"
    },
    {
      name: "MarketWatch",
      url: "https://feeds.marketwatch.com/marketwatch/topstories/"
    }
  ];

  for (const source of sources) {
    try {
      const response = await fetchWithTimeout(source.url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36",
          Accept: "application/rss+xml, application/xml, text/xml"
        },
        timeoutMs: newsRequestTimeoutMs
      });
      if (!response.ok) throw new Error(`${source.name} news returned ${response.status}`);

      const xml = await response.text();
      const items = parseRssItems(xml, source.name).slice(0, 6);
      if (items.length) {
        newsCache = { fetchedAt: Date.now(), data: items };
        return items;
      }
    } catch {
      continue;
    }
  }

  return newsCache.data;
}

function parseRssItems(xml, sourceName) {
  const itemMatches = xml.match(/<item\b[\s\S]*?<\/item>/gi) ?? [];
  return itemMatches
    .map((item) => {
      const summary = stripHtml(decodeXml(readXmlTag(item, "description")));
      return {
        title: decodeXml(readXmlTag(item, "title")),
        link: decodeXml(readXmlTag(item, "link")),
        source: sourceName,
        publishedAt: normalizeDate(readXmlTag(item, "pubDate") || readXmlTag(item, "dc:date")),
        summary: /^Image source:/i.test(summary) ? "" : summary.slice(0, 140)
      };
    })
    .filter((item) => item.title && item.link);
}

function readXmlTag(xml, tagName) {
  const escapedTag = tagName.replace(":", "\\:");
  const match = xml.match(new RegExp(`<${escapedTag}[^>]*>([\\s\\S]*?)<\\/${escapedTag}>`, "i"));
  return match?.[1]?.trim() ?? "";
}

function decodeXml(value) {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function stripHtml(value) {
  return value
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/@media[\s\S]*?\}\s*\}/gi, "")
    .replace(/\{[^{}]*\}/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/^Image source:\s*[^.。!?]*[.。!?]?\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeDate(value) {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? new Date().toISOString() : new Date(parsed).toISOString();
}

export default app;

if (process.env.VERCEL !== "1") {
  const server = app.listen(port, () => {
    console.log(`Investment dashboard running at http://localhost:${port}`);
  });

  globalThis.investDashboardServer = server;
}
