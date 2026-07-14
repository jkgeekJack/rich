// 确定性验证：用 stub fetch 喂固定行情，跑通 server 数据塑形 + 前端渲染，
// 不依赖外网（Yahoo 对单机限流时也能验证），并专门覆盖 DD>10% 加仓提示路径。
import { chromium } from "playwright";

const PORT = 3077;
const DAY = 86_400_000;
const now = Date.now();
process.env.SENTIMENT_TTL_MS = "200"; // 让缓存快速过期，便于测试 stale-while-revalidate
let yahooDown = false; // 第二阶段翻转为 true，模拟 Yahoo 临时 429

function makeChart(closes) {
  const timestamp = closes.map((_, i) => Math.floor((now - (closes.length - 1 - i) * DAY) / 1000));
  return {
    chart: {
      result: [
        {
          timestamp,
          indicators: { quote: [{ close: closes }], adjclose: [{ adjclose: closes }] }
        }
      ]
    }
  };
}

// 生成 N 个点：从 start 线性升到 peak（在 peakIdx），再线性降到 end。控制 1 年高点用于 DD。
function series(start, peak, end, n = 260, peakIdx = 130) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    if (i <= peakIdx) out.push(start + (peak - start) * (i / peakIdx));
    else out.push(peak + (end - peak) * ((i - peakIdx) / (n - 1 - peakIdx)));
  }
  return out;
}

// 标普500：1 年高点 8300，现价 7357 → DD ≈ -11.36% → 触发加仓提示
const SP_CLOSES = series(7000, 8300, 7357.49);
// 纳指100：高点 30350，现价 29440 → DD ≈ -3.0% → 不触发
const NDX_CLOSES = series(28000, 30350, 29440.32);
const GOLD_CLOSES = series(3200, 4100, 4033.1);
const BTC_CLOSES = series(40000, 73000, 59793.99);
const DXY_CLOSES = series(98, 106, 101.38);
const TNX_CLOSES = series(3.8, 4.9, 4.4, 140, 70);
const SPY_CLOSES = series(560, 700, 735.7, 140, 70);
const QQQ_CLOSES = series(470, 620, 588.0, 140, 70);

const treasuryXml = `<?xml version="1.0"?><feed>
<entry><content><m:properties>
<d:NEW_DATE>2026-06-24T00:00:00</d:NEW_DATE><d:BC_10YEAR>4.41</d:BC_10YEAR>
</m:properties></content></entry>
<entry><content><m:properties>
<d:NEW_DATE>2026-06-25T00:00:00</d:NEW_DATE><d:BC_10YEAR>4.40</d:BC_10YEAR>
</m:properties></content></entry>
</feed>`;

const vcpHtml = `<html><body>The Nasdaq 100 P/E ratio is 30.5x as of 2026-06-25, with a forward P/E of 28.1x today.</body></html>`;

function jsonResponse(obj) {
  return new Response(JSON.stringify(obj), { status: 200, headers: { "content-type": "application/json" } });
}
function textResponse(text) {
  return new Response(text, { status: 200, headers: { "content-type": "text/plain" } });
}

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input?.url ?? input);
  if (url.includes("localhost") || url.includes("127.0.0.1")) return realFetch(input, init);

  if (url.includes("finance.yahoo.com")) {
    // chart 数据走 __INVEST_CHART_PROVIDER__ 注入；这里仅兜底 PE quoteSummary
    if (url.includes("quoteSummary")) return jsonResponse({ quoteSummary: { result: [{ summaryDetail: { trailingPE: { raw: 30.5 }, forwardPE: { raw: 28.1 } } }] } });
    return jsonResponse({});
  }
  if (url.includes("cboe.com")) {
    const sym = url.includes("_VXN") ? "VXN" : "VIX";
    const price = sym === "VXN" ? 30.91 : 18.89;
    return jsonResponse({ data: { symbol: sym, current_price: price, price_change: 0.26, price_change_percent: 1.38, open: price - 0.2, high: price + 0.3, low: price - 0.4, last_trade_time: "2026-06-25T20:00:00Z" }, timestamp: "2026-06-25T20:00:00Z" });
  }
  if (url.includes("home.treasury.gov")) return textResponse(treasuryXml);
  if (url.includes("dataviz.cnn.io")) return jsonResponse({ fear_and_greed: { score: 25.54, rating: "fear", timestamp: now } });
  if (url.includes("bitcoin-data.com")) return jsonResponse({ d: "2026-06-25", unixTs: 1782345600, mvrvZscore: 0.2678 });
  if (url.includes("historyofmarket.com")) {
    // 120 个点的历史(≥ 阈值)以便算 forward 百分位;trailing 会被 Siblis 覆盖
    const hist = (base, span) => Array.from({ length: 120 }, (_, i) => ({ value: base + (i / 119) * span }));
    return jsonResponse({ updated: "2026-06-26", current: { trailing: 24.5, forward: 22.1 }, trailing: hist(15, 20), forward: hist(14, 18) });
  }
  if (url.includes("siblisresearch.com")) {
    // 假的 Siblis TTM PE 季度表(2020-2025,TTM PE 30→20),用于验证 trailing 分位计算
    const rows = [
      ["12/31/2025", "20000.00", "30.0"],
      ["12/31/2024", "18000.00", "28.0"],
      ["12/31/2023", "16000.00", "26.0"],
      ["12/31/2022", "14000.00", "24.0"],
      ["12/31/2021", "12000.00", "22.0"],
      ["12/31/2020", "10000.00", "20.0"]
    ];
    const body =
      "<table>" +
      rows.map((r) => `<tr><td>${r[0]}</td><td>${r[1]}</td><td>${r[2]}</td><td>1</td><td>1</td></tr>`).join("") +
      "</table>";
    return textResponse(body);
  }
  if (url.includes("vcpscanner.com")) return textResponse(vcpHtml);
  if (url.includes("nasdaq.com") || url.includes("marketwatch.com")) return textResponse("<rss></rss>");
  return jsonResponse({});
};

// 注入受控 chart 数据（替代 yahoo-finance2 实网请求），可控制 DD 与模拟 429
const CLOSES = {
  "^GSPC": SP_CLOSES,
  "^NDX": NDX_CLOSES,
  "GC=F": GOLD_CLOSES,
  "BTC-USD": BTC_CLOSES,
  "DX-Y.NYB": DXY_CLOSES,
  "^TNX": TNX_CLOSES,
  SPY: SPY_CLOSES,
  QQQ: QQQ_CLOSES
};
globalThis.__INVEST_CHART_PROVIDER__ = async (symbol) => {
  if (yahooDown) throw new Error(`${symbol} simulated 429`);
  const closes = CLOSES[symbol] ?? series(100, 120, 110);
  const quotes = closes.map((c, i) => ({
    date: new Date(now - (closes.length - 1 - i) * DAY),
    open: c,
    high: c,
    low: c,
    close: c,
    adjclose: c,
    volume: 1
  }));
  return { quotes, meta: { symbol } };
};

process.env.PORT = String(PORT);
process.env.VERCEL = "";
await import(new URL("../server.js", import.meta.url));
await new Promise((r) => setTimeout(r, 400));

// ---------- API assertions ----------
const res = await realFetch(`http://localhost:${PORT}/api/sentiment?period=1y`);
const data = await res.json();
const cards = data.cards;
const fail = (msg) => {
  throw new Error(`API CHECK FAILED: ${msg}`);
};

const expected = ["sp500", "ndx", "vix", "vxn", "spRsi", "ndxRsi", "fearGreed", "gold", "treasury", "btc", "btcMvrv", "dollar"];
for (const k of expected) if (!cards[k]) fail(`missing card ${k}`);
if (cards.playbook) fail("playbook card should be merged away");

// 回撤 DD + 加仓提示
const sp = cards.sp500;
if (sp.kind !== "index") fail("sp500 kind");
if (Math.abs(sp.drawdown - -11.3601) > 0.5) fail(`sp500 DD expected ~-11.36, got ${sp.drawdown}`);
if (sp.drawdownAlert !== true) fail(`sp500 DD>10% should alert, got ${sp.drawdownAlert}`);
const nd = cards.ndx;
if (Math.abs(nd.drawdown - -3.0) > 1) fail(`ndx DD expected ~-3, got ${nd.drawdown}`);
if (nd.drawdownAlert !== false) fail(`ndx DD<10% should NOT alert, got ${nd.drawdownAlert}`);

// 合并的恐惧贪婪卡
if (cards.fearGreed.kind !== "fear" || cards.fearGreed.rows?.length !== 5) fail("fearGreed must be one card with 5 rows");

// 趋势卡 + 美元指数
for (const k of ["gold", "treasury", "btc", "dollar"]) {
  if (cards[k].kind !== "trend") fail(`${k} should be trend`);
  if (!cards[k].isLive) fail(`${k} should be live`);
  if (!(cards[k].series?.length >= 100)) fail(`${k} series too short: ${cards[k].series?.length}`);
}
if (!cards.dollar.title.includes("美元指数")) fail("dollar title missing 美元指数");
if (cards.dollar.value == null) fail("dollar value missing");
// 纳指100 PE/FPE 双百分位:trailing 来自 Siblis 历史(近N年分位),forward 来自 HoM(默认 10Y分位)
const ndxc = cards.ndx;
if (typeof ndxc.peRank !== "number") fail(`ndx trailing PE percentile missing, got ${ndxc.peRank}`);
// 假数据 ndx PE=24.5,排在 [30,28,26,24,22,20] 中 ≤24.5 的有 3 个 → 50%
if (Math.abs(ndxc.peRank - 50) > 1) fail(`ndx trailing percentile expected ~50, got ${ndxc.peRank}`);
if (!/^近\d+年分位$/.test(ndxc.peRankLabel || "")) fail(`ndx peRankLabel should be 近N年分位, got ${ndxc.peRankLabel}`);
if (typeof ndxc.forwardRank !== "number") fail(`ndx forward PE percentile missing, got ${ndxc.forwardRank}`);
if (cards.btcMvrv.kind !== "band" || Math.abs(cards.btcMvrv.value - 0.2678) > 1e-6) fail("btcMvrv card wrong");
if (data.strategy?.length !== 3 || data.strategy[2].key !== "btc") fail("strategy should have sp/ndx/btc");

console.log("API OK:", JSON.stringify({
  status: data.status,
  cards: Object.keys(cards).length,
  spDD: Number(sp.drawdown.toFixed(2)),
  spAlert: sp.drawdownAlert,
  ndxDD: Number(nd.drawdown.toFixed(2)),
  ndxAlert: nd.drawdownAlert,
  dollar: cards.dollar.value,
  mvrv: cards.btcMvrv.value
}));

// ---------- stale-while-revalidate：Yahoo 临时 429 时仍保留上一次好值 ----------
yahooDown = true;
await new Promise((r) => setTimeout(r, 300)); // 等缓存过期，强制重新拉取（此时 Yahoo 全 429）
const res2 = await realFetch(`http://localhost:${PORT}/api/sentiment?period=1y&t=${Date.now()}`);
const data2 = await res2.json();
for (const k of ["sp500", "ndx", "gold", "btc", "dollar"]) {
  if (!data2.cards[k]?.isLive) fail(`SWR: ${k} should keep last-good value when Yahoo 429s, got isLive=${data2.cards[k]?.isLive}`);
  if (!data2.cards[k]?.stale) fail(`SWR: ${k} should be flagged stale`);
}
if (Math.abs(data2.cards.sp500.drawdown - -11.36) > 0.5) fail(`SWR: sp500 DD lost, got ${data2.cards.sp500.drawdown}`);
console.log("SWR OK: Yahoo 429 fell back to last-good values (sp500/ndx/gold/btc/dollar still populated)");
yahooDown = false; // 恢复，供后续浏览器渲染检查
await new Promise((r) => setTimeout(r, 300));

// ---------- Frontend (real browser) assertions ----------
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1125, height: 2600 }, deviceScaleFactor: 1 });
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(e.message));

await page.goto(`http://localhost:${PORT}`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(
  () => document.querySelectorAll(".card").length === 12 && !document.body.textContent.includes("正在获取实时市场数据"),
  undefined,
  { timeout: 20000 }
);
await page.screenshot({ path: "verify-fixture-desktop.png", fullPage: true });

const dom = await page.evaluate(() => ({
  cards: document.querySelectorAll(".card").length,
  trendCards: document.querySelectorAll(".trend-card").length,
  drawdowns: document.querySelectorAll(".drawdown").length,
  alerts: document.querySelectorAll(".drawdown.alert .dd-alert").length,
  strategy: document.querySelectorAll(".strategy-card").length,
  fearPlaybookRows: document.querySelectorAll(".fear-card .play-row").length,
  text: document.body.textContent,
  scrollWidth: document.documentElement.scrollWidth,
  width: document.documentElement.clientWidth,
  painted: Array.from(document.querySelectorAll("canvas")).map((c) => {
    const px = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    let p = 0;
    for (let i = 3; i < px.length; i += 4) if (px[i] !== 0) p += 1;
    return p;
  })
}));

await page.setViewportSize({ width: 390, height: 2400 });
await page.waitForTimeout(300);
const mobileOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
await page.screenshot({ path: "verify-fixture-mobile.png", fullPage: true });
await browser.close();

const dfail = (msg) => {
  throw new Error(`DOM CHECK FAILED: ${msg}`);
};
if (dom.cards !== 12) dfail(`cards ${dom.cards}`);
if (dom.trendCards !== 4) dfail(`trendCards ${dom.trendCards}`);
if (dom.drawdowns !== 2) dfail(`drawdown rows ${dom.drawdowns}`);
if (dom.alerts !== 1) dfail(`expected exactly 1 加仓提示 badge, got ${dom.alerts}`);
if (dom.strategy !== 3) dfail(`strategy cards ${dom.strategy}`);
if (dom.fearPlaybookRows < 5) dfail(`merged fear card playbook rows ${dom.fearPlaybookRows}`);
for (const t of ["近1年回撤 DD", "提示加仓", "美元指数", "MVRV", "FEAR & GREED", "PRICE TREND"]) {
  if (!dom.text.includes(t)) dfail(`missing text: ${t}`);
}
if (dom.painted.some((p) => p < 100)) dfail(`unpainted canvas: ${JSON.stringify(dom.painted)}`);
if (dom.scrollWidth > dom.width) dfail(`desktop overflow ${dom.scrollWidth}/${dom.width}`);
if (mobileOverflow) dfail("mobile horizontal overflow");
if (errors.length) dfail(`browser errors: ${errors.join(" | ")}`);

console.log("DOM OK:", JSON.stringify({ ...dom, text: undefined, painted: dom.painted.length + " canvases painted" }));
console.log("\n✅ ALL FIXTURE CHECKS PASSED");
process.exit(0);
