import { chromium } from "playwright";
import { readFile } from "node:fs/promises";

const baseUrl = process.env.BASE_URL || "http://localhost:3001";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Yahoo 偶发 429（单机并发拉行情会被限流），轮询直到行情类卡片就绪或超时。
const yahooCards = ["sp500", "ndx", "gold", "btc", "dollar", "spRsi", "ndxRsi"];
let sentiment = null;
for (let attempt = 1; attempt <= 8; attempt += 1) {
  const response = await fetch(`${baseUrl}/api/sentiment?period=1y&t=${Date.now()}`);
  if (!response.ok && response.status !== 200) {
    if (attempt === 8) throw new Error(`/api/sentiment returned ${response.status}`);
    await sleep(15000);
    continue;
  }
  sentiment = await response.json();
  const ready = yahooCards.every((key) => sentiment.cards?.[key]?.isLive);
  if (ready) break;
  if (attempt === 8) {
    const stillDown = yahooCards.filter((key) => !sentiment.cards?.[key]?.isLive);
    throw new Error(`Yahoo-backed cards never went live after retries: ${stillDown.join(", ")}`);
  }
  console.log(`attempt ${attempt}: waiting for Yahoo cards (${yahooCards.filter((k) => !sentiment.cards?.[k]?.isLive).join(", ")})`);
  await sleep(15000);
}

// 1) 卡片集合与顺序
const expectedCards = [
  "sp500",
  "ndx",
  "vix",
  "vxn",
  "spRsi",
  "ndxRsi",
  "fearGreed",
  "gold",
  "treasury",
  "btc",
  "btcMvrv",
  "dollar",
  "ashareValue"
];
const cardKeys = Object.keys(sentiment.cards ?? {});
const missingKeys = expectedCards.filter((key) => !cardKeys.includes(key));
if (missingKeys.length) throw new Error(`Missing cards: ${missingKeys.join(", ")}`);
if (sentiment.cards.playbook) throw new Error("Fear & Greed playbook should be merged into fearGreed, but a separate playbook card still exists");

// 2) 必须实时的卡片
const requiredLiveCards = [
  "sp500",
  "ndx",
  "vix",
  "vxn",
  "spRsi",
  "ndxRsi",
  "fearGreed",
  "gold",
  "treasury",
  "btc",
  "btcMvrv",
  "dollar",
  "ashareValue"
];
const missingLiveCards = requiredLiveCards.filter((key) => !sentiment.cards?.[key]?.isLive);
if (missingLiveCards.length) {
  throw new Error(`Expected core cards to use realtime sources: ${missingLiveCards.join(", ")}`);
}

// 3) 标普500 / 纳指100 回撤 DD（含 >10% 加仓提示逻辑）
for (const key of ["sp500", "ndx"]) {
  const card = sentiment.cards[key];
  if (card.kind !== "index") throw new Error(`${key} should be an index card`);
  if (typeof card.drawdown !== "number" || card.drawdown > 0) {
    throw new Error(`${key} drawdown should be a non-positive number, got ${card.drawdown}`);
  }
  if (typeof card.drawdownHigh !== "number") throw new Error(`${key} drawdownHigh missing`);
  if (card.drawdownAlert !== card.drawdown <= -10) {
    throw new Error(`${key} drawdownAlert (${card.drawdownAlert}) inconsistent with DD ${card.drawdown}`);
  }
}

// 4) 恐惧与贪婪合并卡
const fg = sentiment.cards.fearGreed;
if (fg.kind !== "fear" || !Array.isArray(fg.rows) || fg.rows.length !== 5) {
  throw new Error(`Merged fearGreed card must be kind=fear with 5 playbook rows, got kind=${fg.kind} rows=${fg.rows?.length}`);
}

// 5) 黄金 / 美债 / BTC / 美元指数 为趋势曲线卡；btcMvrv 为估值带
for (const key of ["gold", "treasury", "btc", "dollar"]) {
  if (sentiment.cards[key].kind !== "trend") {
    throw new Error(`${key} should be a trend card, got ${sentiment.cards[key].kind}`);
  }
}
if (sentiment.cards.btcMvrv.kind !== "band") throw new Error("btcMvrv should be a band card");
if (!sentiment.cards.dollar.title.includes("美元指数")) throw new Error("dollar card missing 美元指数 title");

const ashareValue = sentiment.cards.ashareValue;
if (ashareValue.kind !== "rank" || typeof ashareValue.value !== "number") {
  throw new Error(`Expected live A-share value rank card, got ${JSON.stringify(ashareValue)}`);
}
const expectedAshareBand = [10, 30, 70, 90, Infinity].findIndex((limit) => ashareValue.value < limit);
const expectedAshareRanges = ["前0%-10%", "前10%-30%", "前30%-70%", "前70%-90%", "前90%-100%"];
const expectedAshareValues = ["高", "较高", "中等", "较低", "低"];
const expectedAshareTones = ["green", "blue", "yellow", "orange", "red"];
if (
  ashareValue.active !== expectedAshareBand ||
  ashareValue.rows?.map((row) => row.rank).join("|") !== expectedAshareRanges.join("|") ||
  ashareValue.rows?.map((row) => row.value).join("|") !== expectedAshareValues.join("|") ||
  ashareValue.rows?.map((row) => row.tone).join("|") !== expectedAshareTones.join("|") ||
  ashareValue.accent !== expectedAshareTones[expectedAshareBand] ||
  ashareValue.pill !== `性价比：${expectedAshareValues[expectedAshareBand]}`
) {
  throw new Error(`A-share rank mapping is invalid: ${JSON.stringify(ashareValue)}`);
}

// 6) 折线数据（指数卡 + 趋势卡都使用 1 年 Yahoo 日线）
for (const key of ["sp500", "ndx", "gold", "treasury", "btc", "dollar"]) {
  const card = sentiment.cards[key];
  if (
    card.seriesPeriodLabel !== "近1年" ||
    card.seriesSource !== "Yahoo Finance chart" ||
    card.series.length < 100 ||
    card.seriesLabels?.length !== card.series.length ||
    card.seriesLabels[0] === card.seriesLabels.at(-1)
  ) {
    throw new Error(`Expected ${key} chart to use 1y Yahoo daily history, got ${JSON.stringify({
      points: card.series?.length,
      labels: card.seriesLabels?.length,
      firstLabel: card.seriesLabels?.[0],
      lastLabel: card.seriesLabels?.at(-1),
      period: card.seriesPeriodLabel,
      source: card.seriesSource
    })}`);
  }
}

if (sentiment.chartPeriod?.key !== "1y") {
  throw new Error(`Expected default chart period to be 1y, got ${JSON.stringify(sentiment.chartPeriod)}`);
}
if (!sentiment.displayDate) throw new Error(`Display date was not generated live: ${sentiment.displayDate}`);
if (!sentiment.sources?.length || !sentiment.generatedAt || typeof sentiment.latencyMs !== "number") {
  throw new Error(`Realtime metadata missing: ${JSON.stringify(sentiment)}`);
}
if (!Array.isArray(sentiment.strategy) || sentiment.strategy.length !== 4 || sentiment.strategy.at(-1)?.key !== "ashare") {
  throw new Error(`Expected 4 strategy cards (sp/ndx/btc/ashare), got ${JSON.stringify(sentiment.strategy)}`);
}

// 前端不得残留写死的截图数值
const frontendSources = await Promise.all([
  readFile(new URL("../public/index.html", import.meta.url), "utf8"),
  readFile(new URL("../public/app.js", import.meta.url), "utf8")
]);
const forbiddenFixedValues = ["7,520.40", "29,973.60", "$4,500", "2026 · 05 · 28 / 周四"];
const leakedFixedValues = forbiddenFixedValues.filter((value) => frontendSources.some((source) => source.includes(value)));
if (leakedFixedValues.length) {
  throw new Error(`Frontend still contains fixed screenshot values: ${leakedFixedValues.join(", ")}`);
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1125, height: 2400 }, deviceScaleFactor: 1 });
const errors = [];

page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});
page.on("pageerror", (error) => errors.push(error.message));
await page.route("**/_vercel/insights/script.js", (route) =>
  route.fulfill({ status: 200, contentType: "application/javascript", body: "" })
);

await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
await page.waitForFunction(
  () =>
    document.querySelectorAll(".card").length === 13 &&
    document.querySelectorAll(".source-note").length >= 13 &&
    !document.body.textContent.includes("正在获取实时市场数据"),
  undefined,
  { timeout: 20000 }
);
await page.screenshot({ path: "dashboard-desktop.png", fullPage: true });

const desktop = await page.evaluate(() => {
  const paintedCanvas = Array.from(document.querySelectorAll("canvas")).map((canvas) => {
    const context = canvas.getContext("2d");
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let painted = 0;
    for (let index = 3; index < pixels.length; index += 4) {
      if (pixels[index] !== 0) painted += 1;
    }
    return painted;
  });

  return {
    title: document.querySelector("h1")?.textContent,
    date: document.querySelector(".date-pill")?.textContent,
    cards: document.querySelectorAll(".card").length,
    strategyCards: document.querySelectorAll(".strategy-card").length,
    sourceNotes: document.querySelectorAll(".source-note").length,
    drawdowns: document.querySelectorAll(".drawdown").length,
    trendCards: document.querySelectorAll(".trend-card").length,
    text: document.body.textContent,
    canvasCount: document.querySelectorAll("canvas").length,
    paintedCanvas,
    width: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth
  };
});

await page.setViewportSize({ width: 390, height: 2200 });
await page.waitForTimeout(300);
await page.screenshot({ path: "dashboard-mobile.png", fullPage: true });

const mobile = await page.evaluate(() => ({
  cards: document.querySelectorAll(".card").length,
  strategyCards: document.querySelectorAll(".strategy-card").length,
  horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  width: document.documentElement.clientWidth,
  scrollWidth: document.documentElement.scrollWidth
}));

await browser.close();

const requiredPageText = [
  "今日美股情绪观察",
  "近1年",
  "近3年",
  "S&P 500 · ^GSPC",
  "NASDAQ 100 · ^NDX",
  "PRICE TREND · 近1年日线",
  "近1年回撤 DD",
  "VIX",
  "VXN",
  "FEAR & GREED",
  "GOLD",
  "10Y",
  "BTC",
  "MVRV",
  "美元指数",
  "A股性价比",
  "前0%-10%",
  "前90%-100%",
  "今日定投策略"
];
const missingText = requiredPageText.filter((text) => !desktop.text.includes(text));
if (missingText.length) {
  throw new Error(`Rendered page is missing expected live labels: ${missingText.join(", ")}`);
}
if (desktop.cards !== 13 || mobile.cards !== 13) {
  throw new Error(`Expected 13 content cards, got ${desktop.cards}/${mobile.cards}`);
}
if (desktop.strategyCards !== 4 || mobile.strategyCards !== 4) {
  throw new Error(`Expected 4 strategy cards, got ${desktop.strategyCards}/${mobile.strategyCards}`);
}
if (desktop.trendCards !== 4) {
  throw new Error(`Expected 4 trend cards (gold/treasury/btc/dollar), got ${desktop.trendCards}`);
}
if (desktop.drawdowns !== 2) {
  throw new Error(`Expected 2 drawdown rows (sp500/ndx), got ${desktop.drawdowns}`);
}
if (desktop.sourceNotes < 13) {
  throw new Error(`Expected source notes on every card, got ${desktop.sourceNotes}`);
}
if (desktop.canvasCount < 6 || desktop.paintedCanvas.some((count) => count < 100)) {
  throw new Error(`Expected painted chart canvases, got ${JSON.stringify(desktop.paintedCanvas)}`);
}
if (desktop.scrollWidth > desktop.width || mobile.horizontalOverflow) {
  throw new Error(`Viewport overflow: desktop ${desktop.scrollWidth}/${desktop.width}, mobile ${mobile.scrollWidth}/${mobile.width}`);
}
if (errors.length) {
  throw new Error(`Browser errors: ${errors.join(" | ")}`);
}

console.log(
  JSON.stringify(
    {
      api: {
        status: sentiment.status,
        generatedAt: sentiment.generatedAt,
        displayDate: sentiment.displayDate,
        cards: cardKeys.length,
        spDrawdown: sentiment.cards.sp500.drawdown,
        ndxDrawdown: sentiment.cards.ndx.drawdown,
        spAlert: sentiment.cards.sp500.drawdownAlert,
        ndxAlert: sentiment.cards.ndx.drawdownAlert,
        failures: sentiment.failures
      },
      desktop: {
        title: desktop.title,
        cards: desktop.cards,
        strategyCards: desktop.strategyCards,
        trendCards: desktop.trendCards,
        drawdowns: desktop.drawdowns,
        canvasCount: desktop.canvasCount
      },
      mobile,
      screenshots: ["dashboard-desktop.png", "dashboard-mobile.png"]
    },
    null,
    2
  )
);
