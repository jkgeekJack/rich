import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YahooFinance from "yahoo-finance2";

// yahoo-finance2 会自动处理 cookie/crumb 鉴权，比裸调 chart 接口更稳、能绕过裸接口的 429。
const yahooFinance = new YahooFinance({ suppressNotices: ["yahooSurvey", "ripHistorical"] });

// range 字符串 → period1 起始日期
function rangeToPeriod1(range) {
  const days = { "5d": 7, "1mo": 31, "3mo": 93, "6mo": 186, "1y": 368, "2y": 735, "3y": 1100, "5y": 1830 }[range] ?? 368;
  return new Date(Date.now() - days * 86_400_000);
}

// chart 数据获取，默认走 yahoo-finance2；测试可通过 globalThis.__INVEST_CHART_PROVIDER__ 注入固定数据。
function fetchChart(symbol, options) {
  const provider = globalThis.__INVEST_CHART_PROVIDER__ ?? yahooFinance.chart.bind(yahooFinance);
  return provider(symbol, options);
}

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
const sentimentCacheTtlMs = Number(process.env.SENTIMENT_TTL_MS) || 60_000;
// stale-while-revalidate：保存每个周期最近一次成功的卡片/策略，
// 当 Yahoo 等数据源临时 429 时回填上一次的好值，避免卡片显示「实时源不可用」。
const lastGoodSentiment = new Map();
const chartPeriods = {
  "1y": { key: "1y", label: "近1年", yahooRange: "1y", maxPoints: 140 },
  "3y": { key: "3y", label: "近3年", yahooRange: "3y", maxPoints: 180 }
};

// Yahoo Finance 限流：同一 IP 并发拉多个 symbol 容易触发 429，限制并发数并排队。
const YAHOO_MAX_CONCURRENT = 2;
let yahooActive = 0;
const yahooQueue = [];
function runYahoo(task) {
  return new Promise((resolve, reject) => {
    const start = () => {
      yahooActive += 1;
      Promise.resolve()
        .then(task)
        .then(resolve, reject)
        .finally(() => {
          yahooActive -= 1;
          const next = yahooQueue.shift();
          if (next) next();
        });
    };
    if (yahooActive < YAHOO_MAX_CONCURRENT) start();
    else yahooQueue.push(start);
  });
}

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
  // Stooq 行情源已失效（^spx/^ndx/xauusd 返回 404），统一改用 Yahoo Finance 拉行情+折线。
  // RSI 也从已失效的 nfin 切到 Yahoo。
  const needSeparateHigh = chartPeriod.key !== "1y";
  const [
    sp500,
    ndx,
    gold,
    vix,
    vxn,
    treasury,
    fearGreed,
    spRsi,
    ndxRsi,
    spPe,
    ndxPe,
    btc,
    dxy,
    mvrv,
    ashareValue,
    spHighRaw,
    ndxHighRaw
  ] = await Promise.all([
    fetchYahooMarketQuote("^GSPC", chartPeriod).catch((error) => failedValue(failures, "S&P 500", error)),
    fetchYahooMarketQuote("^NDX", chartPeriod).catch((error) => failedValue(failures, "NASDAQ 100", error)),
    fetchYahooMarketQuote("GC=F", chartPeriod).catch((error) => failedValue(failures, "XAU/USD", error)),
    fetchCboeQuote("_VIX").catch((error) => failedValue(failures, "VIX", error)),
    fetchCboeQuote("_VXN").catch((error) => failedValue(failures, "VXN", error)),
    fetchTreasury10Year(chartPeriod).catch((error) => failedValue(failures, "10Y Treasury", error)),
    fetchCnnFearGreed().catch((error) => failedValue(failures, "CNN Fear & Greed", error)),
    fetchYahooRsi("SPY").catch((error) => failedValue(failures, "S&P RSI", error)),
    fetchYahooRsi("QQQ").catch((error) => failedValue(failures, "NDX RSI", error)),
    fetchSp500Pe().catch((error) => failedValue(failures, "S&P PE", error)),
    fetchNasdaq100Pe().catch((error) => failedValue(failures, "Nasdaq 100 PE", error)),
    fetchYahooMarketQuote("BTC-USD", chartPeriod).catch((error) => failedValue(failures, "BTC", error)),
    fetchYahooMarketQuote("DX-Y.NYB", chartPeriod).catch((error) => failedValue(failures, "US Dollar Index", error)),
    fetchBtcMvrv().catch((error) => failedValue(failures, "BTC MVRV", error)),
    fetchAshareValue().catch((error) => failedValue(failures, "A股性价比", error)),
    needSeparateHigh ? fetchYearHigh("^GSPC").catch(() => null) : Promise.resolve(null),
    needSeparateHigh ? fetchYearHigh("^NDX").catch(() => null) : Promise.resolve(null)
  ]);

  // 近 1 年最高点：1y 周期下直接用行情折线的高点，避免重复请求；3y 周期则单独取 1 年序列。
  const spYearHigh = needSeparateHigh
    ? spHighRaw
    : sp500?.isLive
      ? { high: sp500.high, isLive: true, source: "Yahoo Finance chart" }
      : null;
  const ndxYearHigh = needSeparateHigh
    ? ndxHighRaw
    : ndx?.isLive
      ? { high: ndx.high, isLive: true, source: "Yahoo Finance chart" }
      : null;

  const liveCount = [sp500, ndx, gold, vix, vxn, treasury, fearGreed, spRsi, ndxRsi, spPe, ndxPe, btc, dxy, mvrv, ashareValue].filter(
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
      "Yahoo Finance",
      "Cboe delayed quotes",
      "US Treasury",
      "CNN Fear & Greed",
      "History of Market",
      "VCP Scanner",
      "bitcoin-data.com",
      "好买基金 估值性价比"
    ],
    failures,
    cards: {
      sp500: buildIndexCard({
        key: "sp500",
        title: "S&P 500 · ^GSPC",
        subtitleLabel: "标普500",
        quote: sp500,
        pe: spPe,
        accent: "green",
        yearHigh: spYearHigh
      }),
      ndx: buildIndexCard({
        key: "ndx",
        title: "NASDAQ 100 · ^NDX",
        subtitleLabel: "纳指100",
        quote: ndx,
        pe: ndxPe,
        accent: "purple",
        yearHigh: ndxYearHigh
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
      // 恐惧与贪婪指数：仪表盘 + 操作手册合并为一张卡（kind: fear，含 rows）。
      fearGreed: buildFearGreedCard(fearGreed),
      // 黄金 / 十年期美债 / BTC / 美元指数：与标普500同款趋势曲线卡（kind: trend），放在卡片底部。
      gold: buildTrendCard({
        title: "GOLD · XAU/USD",
        subtitle: "伦敦金 · 美元/盎司",
        quote: gold,
        accent: "yellow",
        valueFormat: "currency",
        badgeKind: "percent"
      }),
      treasury: buildTrendCard({
        title: "10Y · UST · ^TNX",
        subtitle: "十年期美国国债收益率",
        quote: treasury,
        accent: "blue",
        valueFormat: "percent",
        badgeKind: "basis"
      }),
      btc: buildTrendCard({
        title: "BTC · BTC/USD",
        subtitle: "比特币 · 美元",
        quote: btc,
        accent: "orange",
        valueFormat: "currency0",
        badgeKind: "percent"
      }),
      btcMvrv: buildBtcMvrvCard(mvrv),
      dollar: buildTrendCard({
        title: "DXY · 美元指数",
        subtitle: "美元指数 · ICE U.S. Dollar",
        quote: dxy,
        accent: "#0f9488",
        valueFormat: "number",
        badgeKind: "percent"
      }),
      ashareValue: buildAshareValueCard(ashareValue)
    },
    strategy: buildStrategy(spRsi, ndxRsi, mvrv, ashareValue)
  };

  applyStaleWhileRevalidate(snapshot, chartPeriod.key);

  sentimentCache.set(chartPeriod.key, { fetchedAt: Date.now(), data: snapshot });
  return snapshot;
}

// 数据源临时失败时，用上一次成功的卡片/策略回填，保持页面有数据可看。
function applyStaleWhileRevalidate(snapshot, periodKey) {
  const store = lastGoodSentiment.get(periodKey) ?? { cards: new Map(), strategy: null };
  for (const [key, card] of Object.entries(snapshot.cards)) {
    if (card?.isLive) {
      store.cards.set(key, card);
    } else if (store.cards.has(key)) {
      snapshot.cards[key] = { ...store.cards.get(key), stale: true };
    }
  }
  const strategy = snapshot.strategy;
  if (Array.isArray(strategy) && strategy.every((item) => item?.isLive)) {
    store.strategy = strategy;
  } else if (store.strategy) {
    snapshot.strategy = store.strategy.map((item) => ({ ...item, stale: true }));
  }
  lastGoodSentiment.set(periodKey, store);

  // 计入回填后的卡片重新计算状态
  const cards = Object.values(snapshot.cards);
  const liveCount = cards.filter((card) => card?.isLive).length;
  snapshot.status = liveCount ? (liveCount === cards.length ? "live" : "partial") : "offline";
}

function failedValue(failures, symbol, error) {
  failures.push({ symbol, message: error.message });
  return { isLive: false, error: error.message, source: null };
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

// A股性价比 = 好买“股债性价比”估值模型（沪深300），日更。
// fedfwz 是近3年股债性价比排名分位，数值越小性价比越高。
const ashareValueBands = [
  { upperExclusive: 10, rank: "前0%-10%", value: "高", action: "积极配置", english: "HIGH VALUE", score: 2, tone: "green" },
  { upperExclusive: 30, rank: "前10%-30%", value: "较高", action: "逢低布局", english: "GOOD VALUE", score: 1, tone: "blue" },
  { upperExclusive: 70, rank: "前30%-70%", value: "中等", action: "均衡持有", english: "FAIR", score: 0, tone: "yellow" },
  { upperExclusive: 90, rank: "前70%-90%", value: "较低", action: "谨慎控仓", english: "RICH", score: -1, tone: "orange" },
  { upperExclusive: Infinity, rank: "前90%-100%", value: "低", action: "落袋观望", english: "EXPENSIVE", score: -2, tone: "red" }
];
let ashareValueCache = null;
const ashareValueCacheTtlMs = 3 * 60 * 60 * 1000;

async function fetchAshareValue() {
  if (ashareValueCache && Date.now() - ashareValueCache.fetchedAt < ashareValueCacheTtlMs) {
    return ashareValueCache.data;
  }
  try {
    const url =
      "https://data.howbuy.com/cgi/fund/gzxjb/moduleData.json" +
      "?h5req=1&corpId=100009&coopId=RO1906W01&zqdm=000300&time=3N&tab=1&callback=cb";
    const response = await fetchWithTimeout(url, {
      timeoutMs: quoteRequestTimeoutMs,
      headers: { Accept: "*/*", "User-Agent": "Mozilla/5.0" }
    });
    if (!response.ok) throw new Error(`Howbuy 估值性价比 returned ${response.status}`);
    const text = await response.text();
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("Howbuy 估值性价比 返回无法解析");
    const body = JSON.parse(match[0]).body ?? {};
    const fedRank = numberOrNull(Number.parseFloat(body.fedfwz));
    if (fedRank === null || fedRank < 0 || fedRank > 100) {
      throw new Error("Howbuy 估值性价比 缺少有效分位值");
    }
    const data = {
      pe: numberOrNull(Number.parseFloat(body.pe)),
      dividendYield: numberOrNull(Number.parseFloat(body.gxl)),
      dividendRank: numberOrNull(Number.parseFloat(body.gxlfwz)),
      fedRank,
      source: "好买基金 data.howbuy.com",
      isLive: true
    };
    ashareValueCache = { fetchedAt: Date.now(), data };
    return data;
  } catch (error) {
    if (ashareValueCache?.data) return { ...ashareValueCache.data, stale: true };
    throw error;
  }
}

function ashareValueBandIndex(rank) {
  if (typeof rank !== "number" || !Number.isFinite(rank) || rank < 0 || rank > 100) return -1;
  return ashareValueBands.findIndex((band) => rank < band.upperExclusive);
}

function buildAshareValueCard(value) {
  const rows = ashareValueBands.map((band) => ({ rank: band.rank, value: band.value, tone: band.tone }));
  const fedRank = value?.isLive ? numberOrNull(value.fedRank) : null;
  const active = ashareValueBandIndex(fedRank);
  const band = active >= 0 ? ashareValueBands[active] : null;
  const pe = numberOrNull(value?.pe);
  const dividend = numberOrNull(value?.dividendYield);
  const dividendRank = numberOrNull(value?.dividendRank);
  const detail = [];
  if (pe !== null) detail.push(`PE ${pe.toFixed(2)}`);
  if (dividend !== null) {
    detail.push(
      dividendRank !== null
        ? `股息率 ${dividend.toFixed(2)}%(分位${dividendRank.toFixed(0)}%)`
        : `股息率 ${dividend.toFixed(2)}%`
    );
  }
  return {
    kind: "rank",
    accent: band?.tone ?? "red",
    title: "A股性价比 · 沪深300",
    subtitle: `好买股债性价比 · 近3年${detail.length ? ` · ${detail.join(" · ")}` : ""}`,
    value: fedRank,
    pill: band ? `性价比：${band.value}` : "不可用",
    pillEn: band?.english ?? "NO SOURCE",
    active,
    rows,
    source: value?.source ?? "好买基金 data.howbuy.com",
    isLive: Boolean(value?.isLive),
    stale: Boolean(value?.stale),
    error: value?.error ?? null
  };
}

function buildAshareStrategyItem(value) {
  const rank = value?.isLive ? numberOrNull(value.fedRank) : null;
  const active = ashareValueBandIndex(rank);
  const band = active >= 0 ? ashareValueBands[active] : null;
  return {
    key: "ashare",
    score: band?.score ?? null,
    action: band?.action ?? "等待实时源",
    detail: band
      ? `沪深300 排名前${rank.toFixed(2)}% · 性价比${band.value}`
      : "沪深300 估值性价比 · 实时源不可用",
    isLive: Boolean(value?.isLive)
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

// History of Market 同时提供 trailing/forward PE 与历史序列(可算百分位)。
// 仅当历史点数足够(≥100)才算百分位,避免短历史被误标成「10Y分位」。
const PE_PERCENTILE_MIN_POINTS = 100;
async function fetchHistoryOfMarketPe(indexPath, label) {
  const response = await fetchWithRetries(`https://historyofmarket.com/api/${indexPath}/forward-pe.json`, {
    timeoutMs: newsRequestTimeoutMs,
    retries: 2,
    retryDelayMs: 2500
  });
  if (!response.ok) throw new Error(`History of Market ${label} PE returned ${response.status}`);
  const payload = await response.json();
  const trailing = numberOrNull(payload.current?.trailing);
  const forward = numberOrNull(payload.current?.forward);
  if (typeof trailing !== "number" && typeof forward !== "number") {
    throw new Error(`History of Market returned no ${label} PE data`);
  }
  const trailingHistory = Array.isArray(payload.trailing) ? payload.trailing : [];
  const forwardHistory = Array.isArray(payload.forward) ? payload.forward : [];
  return {
    pe: trailing,
    forwardPe: forward,
    peRank: trailingHistory.length >= PE_PERCENTILE_MIN_POINTS ? percentileRank(trailingHistory, trailing) : null,
    forwardRank: forwardHistory.length >= PE_PERCENTILE_MIN_POINTS ? percentileRank(forwardHistory, forward) : null,
    updatedAt: payload.updated ?? null,
    source: "History of Market",
    isLive: true
  };
}

async function fetchSp500Pe() {
  return fetchHistoryOfMarketPe("sp500", "S&P");
}

// 纳指100 PE：主用 History of Market(trailing/forward + forward 百分位，历史回溯到 2001），
// VCP Scanner 已改前端渲染抓不到、故下线；兜底用 Yahoo QQQ(仅 trailing)。
async function fetchNasdaq100Pe() {
  let base;
  try {
    base = await fetchHistoryOfMarketPe("ndx", "Nasdaq 100");
  } catch (primaryError) {
    try {
      return await fetchYahooPe("QQQ");
    } catch (fallbackError) {
      throw new Error(`History of Market: ${primaryError.message}; Yahoo fallback: ${fallbackError.message}`);
    }
  }
  // History of Market 的纳指 trailing 历史太短(数周)→ trailing 分位用 Siblis 的 TTM PE 季度历史补齐。
  // forward 分位仍用 History of Market(月度回溯到 2001，更深)。失败则 trailing 分位留空，不影响其它字段。
  try {
    const siblis = await fetchSiblisNdxTtmHistory();
    if (typeof base.pe === "number" && siblis.values.length >= 4) {
      base.peRank = percentileRank(siblis.values.map((value) => ({ value })), base.pe);
      base.peRankLabel = `近${siblis.spanYears}年分位`;
      base.peRankSource = siblis.source;
    }
  } catch {
    // 保持 base.peRank = null
  }
  return base;
}

// Siblis Research 公布纳指100 季度 TTM PE(免费页约近 3 年）。用于计算 trailing PE 的历史百分位。
async function fetchSiblisNdxTtmHistory() {
  const response = await fetchWithTimeout("https://siblisresearch.com/data/nasdaq-100-pe-ratio/", {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36",
      Accept: "text/html"
    },
    timeoutMs: newsRequestTimeoutMs
  });
  if (!response.ok) throw new Error(`Siblis returned ${response.status}`);
  const html = await response.text();
  const flat = html.replace(/<[^>]+>/g, " | ").replace(/[ \t]+/g, " ");
  // 行: date | price | TTM_PE | TTM_EPS | Forward_PE | ...，取第 3 列 TTM PE。
  const rowRe = /(\d{1,2}\/\d{1,2}\/\d{4})\s*(?:\|\s*)+[\d,]+\.\d+\s*(?:\|\s*)+([\d.]+)/g;
  const rows = [];
  let match;
  while ((match = rowRe.exec(flat))) {
    const value = Number(match[2]);
    const year = Number(match[1].split("/")[2]);
    if (Number.isFinite(value) && Number.isFinite(year)) rows.push({ year, value });
  }
  const values = rows.map((row) => row.value);
  if (values.length < 4) throw new Error("Siblis parsed too few TTM PE rows");
  const years = rows.map((row) => row.year);
  const spanYears = Math.max(...years) - Math.min(...years) + 1;
  return { values, count: values.length, spanYears, source: "Siblis Research" };
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
  // 经 yahoo-finance2(自动处理 crumb)取 quoteSummary，比裸调 v10 接口稳。
  const result = await runYahoo(() =>
    yahooFinance.quoteSummary(symbol, { modules: ["summaryDetail", "defaultKeyStatistics"] })
  );
  const sd = result?.summaryDetail ?? {};
  const ks = result?.defaultKeyStatistics ?? {};
  const pe = numberOrNull(sd.trailingPE ?? ks.trailingPE);
  const forwardPe = numberOrNull(sd.forwardPE ?? ks.forwardPE);
  if (typeof pe !== "number" && typeof forwardPe !== "number") throw new Error(`${symbol} returned no PE metrics`);
  return {
    pe,
    forwardPe,
    peRank: null,
    forwardRank: null,
    source: "Yahoo Finance quoteSummary",
    isLive: true
  };
}

async function fetchYahooHistoricalSeries(symbol, chartPeriod = chartPeriods["1y"]) {
  const result = await runYahoo(() =>
    fetchChart(symbol, { period1: rangeToPeriod1(chartPeriod.yahooRange), interval: "1d" })
  );
  const quotes = result?.quotes ?? [];
  const points = quotes
    .map((quote) => ({
      value: numberOrNull(quote.adjclose ?? quote.close),
      label: quote.date ? formatAxisDate(new Date(quote.date)) : null
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
  const result = await runYahoo(() => fetchChart(symbol, { period1: rangeToPeriod1(range), interval: "1d" }));
  const quotes = result?.quotes ?? [];
  return quotes
    .map((quote) => ({
      time: quote.date ? new Date(quote.date).toISOString() : null,
      value: numberOrNull(quote.close)
    }))
    .filter((point) => point.time && typeof point.value === "number");
}

// 用 Yahoo Finance 日线同时拿到现价/涨跌（取最近两根收盘）与折线（按周期采样）。
async function fetchYahooMarketQuote(symbol, chartPeriod = chartPeriods["1y"]) {
  const points = await fetchYahooDailySeries(symbol, chartPeriod.yahooRange);
  const clean = points.filter((point) => Number.isFinite(point.value));
  if (clean.length < 2) throw new Error(`${symbol} Yahoo returned insufficient data`);
  const values = clean.map((point) => point.value);
  const price = values.at(-1);
  const previous = values.at(-2);
  const change = price - previous;
  const changePercent = previous ? (change / previous) * 100 : 0;
  const sampled = sampleSeries(clean, chartPeriod.maxPoints);
  return {
    symbol,
    price,
    change,
    changePercent,
    open: previous,
    high: Math.max(...values),
    low: Math.min(...values),
    updatedAt: clean.at(-1).time,
    source: "Yahoo Finance",
    isLive: true,
    series: sampled.map((point) => point.value),
    seriesLabels: sampled.map((point) => formatAxisDate(new Date(point.time))),
    seriesSource: "Yahoo Finance chart",
    seriesPeriodLabel: chartPeriod.label
  };
}

// 近 1 年最高收盘价（用于计算回撤 DD）。
async function fetchYearHigh(symbol) {
  const points = await fetchYahooDailySeries(symbol, "1y");
  const values = points.map((point) => point.value).filter(Number.isFinite);
  if (!values.length) throw new Error(`${symbol} returned no 1y data for drawdown`);
  return { high: Math.max(...values), isLive: true, source: "Yahoo Finance chart" };
}

// 比特币 MVRV Z-Score（链上估值指标）。
async function fetchBtcMvrv() {
  const response = await fetchWithTimeout("https://bitcoin-data.com/v1/mvrv-zscore/last", {
    headers: {
      Accept: "application/json",
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36"
    },
    timeoutMs: newsRequestTimeoutMs
  });
  if (!response.ok) throw new Error(`bitcoin-data.com returned ${response.status}`);
  const payload = await response.json();
  const value = numberOrNull(Number(payload?.mvrvZscore));
  if (typeof value !== "number") throw new Error("bitcoin-data.com returned no MVRV Z-Score");
  return { value, date: payload?.d ?? null, source: "bitcoin-data.com", isLive: true };
}

function buildIndexCard({ title, subtitleLabel, quote, pe, accent, yearHigh }) {
  const unavailable = !quote?.isLive;
  const change = numberOrNull(quote?.change);
  const changePercent = numberOrNull(quote?.changePercent);
  const price = unavailable ? null : numberOrNull(quote.price);
  // 近 1 年最高点 → 现价的回撤（DD）。DD 超过 10% 时提示加仓。
  let drawdown = null;
  let drawdownHigh = null;
  let drawdownAlert = false;
  if (typeof price === "number" && yearHigh?.isLive && typeof yearHigh.high === "number") {
    const high = Math.max(yearHigh.high, price);
    drawdownHigh = high;
    drawdown = high ? ((price - high) / high) * 100 : null;
    drawdownAlert = typeof drawdown === "number" && drawdown <= -10;
  }
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
    drawdown,
    drawdownHigh,
    drawdownAlert,
    moveLabel: describeMove(change),
    pe: pe?.isLive ? pe.pe : null,
    peRank: pe?.isLive ? pe.peRank : null,
    peRankLabel: pe?.isLive ? pe.peRankLabel ?? null : null,
    forwardPe: pe?.isLive ? pe.forwardPe : null,
    forwardRank: pe?.isLive ? pe.forwardRank : null,
    forwardRankLabel: pe?.isLive ? pe.forwardRankLabel ?? null : null,
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

// 恐惧与贪婪指数：仪表盘 + 操作手册合并成一张卡（kind: fear，rows 为操作区间）。
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

// 趋势曲线卡：与标普500同款（大号折线 + 标记点 + 坐标），用于黄金 / 美债 / BTC / 美元指数。
function buildTrendCard({ title, subtitle, quote, accent, valueFormat, badgeKind = "percent" }) {
  const unavailable = !quote?.isLive;
  const change = numberOrNull(quote?.change);
  const changePercent = numberOrNull(quote?.changePercent);
  const badge = unavailable
    ? "实时源不可用"
    : badgeKind === "basis"
      ? formatSignedBasisPoint(change)
      : formatPercentBadge(changePercent);
  const moveLabel = unavailable
    ? "实时源不可用"
    : `${badgeKind === "basis" ? `${formatSignedNumber(change, 2)}pp` : formatSignedNumber(change, 2)} · ${describeMove(change)}`;
  return {
    kind: "trend",
    accent,
    title,
    subtitle: unavailable ? `${subtitle} · 实时源不可用` : subtitle,
    value: unavailable ? null : quote.price,
    valueFormat,
    badge,
    badgeTone: (change ?? 0) >= 0 ? "red" : "green",
    change,
    changePercent,
    moveLabel,
    series: quote?.series ?? [],
    seriesLabels: quote?.seriesLabels ?? [],
    seriesSource: quote?.seriesSource ?? quote?.source,
    seriesPeriodLabel: quote?.seriesPeriodLabel ?? null,
    source: quote?.source,
    isLive: Boolean(quote?.isLive),
    error: quote?.error ?? null
  };
}

// 比特币 MVRV Z-Score 估值带（kind: band）。
function buildBtcMvrvCard(mvrv) {
  const value = numberOrNull(mvrv?.value);
  const thresholds = [
    [0, "历史底部区", "重仓买入"],
    [2, "低估积累区", "坚持定投"],
    [3.5, "合理偏高", "持有观察"],
    [6, "牛市偏热", "分批止盈"],
    [7, "顶部预警", "大幅减仓"],
    [Infinity, "极度泡沫", "清仓离场"]
  ];
  const english = ["BOTTOM", "ACCUMULATE", "FAIR", "HOT", "WARNING", "BUBBLE"];
  const active = typeof value === "number" ? thresholds.findIndex(([limit]) => value < limit) : -1;
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
  return {
    kind: "band",
    accent: "orange",
    title: "BTC MVRV Z-Score",
    subtitle: `比特币估值 · (市值−已实现市值)/市值标准差${mvrv?.date ? ` · ${mvrv.date}` : ""}`,
    value,
    pill: active >= 0 ? thresholds[active][1] : "不可用",
    pillEn: active >= 0 ? english[active] : "NO SOURCE",
    active,
    rows,
    source: mvrv?.source,
    isLive: Boolean(mvrv?.isLive),
    error: mvrv?.error ?? null
  };
}

function buildStrategy(spRsi, ndxRsi, mvrv, ashareValue) {
  return [
    buildStrategyItem("sp", "标普500", spRsi),
    buildStrategyItem("ndx", "纳指100", ndxRsi),
    buildBtcStrategyItem(mvrv),
    buildAshareStrategyItem(ashareValue)
  ];
}

function buildBtcStrategyItem(mvrv) {
  const value = numberOrNull(mvrv?.value);
  let score = null;
  let action = "等待实时源";
  let state = "不可用";
  if (typeof value === "number") {
    if (value < 0) {
      score = 1;
      action = "重仓买入";
      state = "历史底部区";
    } else if (value < 2) {
      score = 1;
      action = "坚持定投";
      state = "低估积累区";
    } else if (value < 3.5) {
      score = 0;
      action = "持有观察";
      state = "合理偏高";
    } else if (value < 6) {
      score = -1;
      action = "分批止盈";
      state = "牛市偏热";
    } else if (value < 7) {
      score = -1;
      action = "大幅减仓";
      state = "顶部预警";
    } else {
      score = -1;
      action = "清仓离场";
      state = "极度泡沫";
    }
  }
  return {
    key: "btc",
    score,
    action,
    detail: typeof value === "number" ? `比特币 MVRV Z ${value.toFixed(2)} · ${state}` : "比特币 MVRV Z · 实时源不可用",
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
