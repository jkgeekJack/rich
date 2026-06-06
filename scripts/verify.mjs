import { chromium } from "playwright";
import { readFile } from "node:fs/promises";

const baseUrl = process.env.BASE_URL || "http://localhost:3001";

const sentimentResponse = await fetch(`${baseUrl}/api/sentiment`);
if (!sentimentResponse.ok) {
  throw new Error(`/api/sentiment returned ${sentimentResponse.status}`);
}

const sentiment = await sentimentResponse.json();
const requiredLiveCards = [
  "sp500",
  "ndx",
  "vix",
  "vxn",
  "spRsi",
  "ndxRsi",
  "fearGreed",
  "playbook",
  "gold",
  "treasury"
];
const missingLiveCards = requiredLiveCards.filter((key) => !sentiment.cards?.[key]?.isLive);
if (missingLiveCards.length) {
  throw new Error(`Expected core cards to use realtime sources: ${missingLiveCards.join(", ")}`);
}
if (typeof sentiment.cards.sp500.pe !== "number" || typeof sentiment.cards.sp500.forwardPe !== "number") {
  throw new Error(`Expected live S&P PE metrics, got ${JSON.stringify(sentiment.cards.sp500)}`);
}
if (sentiment.cards.sp500.metricsSource !== "History of Market") {
  throw new Error(`Expected S&P PE metrics from History of Market, got ${sentiment.cards.sp500.metricsSource}`);
}
if (typeof sentiment.cards.ndx.pe !== "number" || typeof sentiment.cards.ndx.forwardPe !== "number") {
  throw new Error(`Expected live Nasdaq 100 PE metrics, got ${JSON.stringify(sentiment.cards.ndx)}`);
}
if (sentiment.cards.ndx.metricsSource !== "VCP Scanner") {
  throw new Error(`Expected Nasdaq 100 PE metrics from VCP Scanner, got ${sentiment.cards.ndx.metricsSource}`);
}
if (!sentiment.cards.ndx.metricsUpdatedAt) {
  throw new Error(`Expected Nasdaq 100 PE update date, got ${JSON.stringify(sentiment.cards.ndx)}`);
}
if (sentiment.chartPeriod?.key !== "1y") {
  throw new Error(`Expected default chart period to be 1y, got ${JSON.stringify(sentiment.chartPeriod)}`);
}
for (const key of ["sp500", "ndx", "gold", "treasury"]) {
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
if (!sentiment.displayDate || sentiment.displayDate.includes("05 · 28")) {
  throw new Error(`Display date was not generated live: ${sentiment.displayDate}`);
}
if (!sentiment.sources?.length || !sentiment.generatedAt || typeof sentiment.latencyMs !== "number") {
  throw new Error(`Realtime metadata missing: ${JSON.stringify(sentiment)}`);
}

const frontendSources = await Promise.all([
  readFile(new URL("../public/index.html", import.meta.url), "utf8"),
  readFile(new URL("../public/app.js", import.meta.url), "utf8")
]);
const forbiddenFixedValues = [
  "7,520.40",
  "29,973.60",
  "16.29",
  "23.39",
  "74.30",
  "79.20",
  "$4,500",
  "2026 · 05 · 28 / 周四",
  "标普500 RSI 74.3 · 偏热",
  "纳指100 RSI 79.2 · 偏热"
];
const leakedFixedValues = forbiddenFixedValues.filter((value) => frontendSources.some((source) => source.includes(value)));
if (leakedFixedValues.length) {
  throw new Error(`Frontend still contains fixed screenshot values: ${leakedFixedValues.join(", ")}`);
}
if (frontendSources.some((source) => source.includes('["起", "中", "今"]'))) {
  throw new Error("Frontend still uses non-date axis labels");
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1125, height: 2000 }, deviceScaleFactor: 1 });
const errors = [];

page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});
page.on("pageerror", (error) => errors.push(error.message));

await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
await page.waitForFunction(
  () =>
    document.querySelectorAll(".card").length === 10 &&
    document.querySelectorAll(".source-note").length >= 10 &&
    !document.body.textContent.includes("正在获取实时市场数据"),
  undefined,
  { timeout: 15000 }
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
    text: document.body.textContent,
    canvasCount: document.querySelectorAll("canvas").length,
    paintedCanvas,
    width: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth
  };
});

await page.setViewportSize({ width: 390, height: 1600 });
await page.waitForTimeout(300);
await page.screenshot({ path: "dashboard-mobile.png", fullPage: true });

const mobile = await page.evaluate(() => ({
  cards: document.querySelectorAll(".card").length,
  strategyCards: document.querySelectorAll(".strategy-card").length,
  sourceNotes: document.querySelectorAll(".source-note").length,
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
  "估值来源：VCP Scanner",
  "PRICE TREND · 近1年日线",
  "VIX",
  "VXN",
  "FEAR & GREED",
  "GOLD",
  "10Y",
  "今日美股定投策略",
  "来源："
];
const missingText = requiredPageText.filter((text) => !desktop.text.includes(text));
if (missingText.length) {
  throw new Error(`Rendered page is missing expected live labels: ${missingText.join(", ")}`);
}
if (desktop.cards !== 10 || mobile.cards !== 10) {
  throw new Error(`Expected 10 content cards, got ${desktop.cards}/${mobile.cards}`);
}
if (desktop.strategyCards !== 2 || mobile.strategyCards !== 2) {
  throw new Error(`Expected 2 strategy cards, got ${desktop.strategyCards}/${mobile.strategyCards}`);
}
if (desktop.sourceNotes < 10 || mobile.sourceNotes < 10) {
  throw new Error(`Expected source notes on every card, got ${desktop.sourceNotes}/${mobile.sourceNotes}`);
}
if (desktop.text.includes("10Y分位: --")) {
  throw new Error("Rendered page still shows missing percentile as 10Y分位: --");
}
if (desktop.canvasCount < 4 || desktop.paintedCanvas.some((count) => count < 100)) {
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
        sources: sentiment.sources,
        liveCoreCards: requiredLiveCards.length,
        failures: sentiment.failures
      },
      desktop: {
        title: desktop.title,
        date: desktop.date,
        cards: desktop.cards,
        strategyCards: desktop.strategyCards,
        sourceNotes: desktop.sourceNotes,
        canvasCount: desktop.canvasCount
      },
      mobile,
      screenshots: ["dashboard-desktop.png", "dashboard-mobile.png"]
    },
    null,
    2
  )
);
