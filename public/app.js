const colors = {
  green: "#10aa82",
  purple: "#8150de",
  red: "#d93f36",
  yellow: "#e3bf13",
  blue: "#2f82bd",
  orange: "#f7931a"
};

const grid = document.querySelector("#dashboardGrid");
const datePill = document.querySelector(".date-pill");
const strategyGrid = document.querySelector(".strategy-grid");
const periodButtons = Array.from(document.querySelectorAll(".period-button"));
const CLIENT_CACHE_VERSION = "v1";
const CLIENT_CACHE_MAX_AGE_MS = 24 * 60 * 60_000;
const CLIENT_REFRESH_INTERVAL_MS = 5 * 60_000;
let selectedPeriod = localStorage.getItem("sentimentChartPeriod") || "1y";

const restoredFromCache = restoreCachedSentiment(selectedPeriod);

periodButtons.forEach((button) => {
  button.addEventListener("click", () => {
    selectedPeriod = button.dataset.period;
    localStorage.setItem("sentimentChartPeriod", selectedPeriod);
    updatePeriodButtons(selectedPeriod);
    const restored = restoreCachedSentiment(selectedPeriod);
    if (!restored) renderLoadingState();
    loadSentiment({ preserveExisting: restored });
  });
});
updatePeriodButtons(selectedPeriod);
loadSentiment({ preserveExisting: restoredFromCache });
window.setInterval(() => loadSentiment({ preserveExisting: true }), CLIENT_REFRESH_INTERVAL_MS);

async function loadSentiment({ preserveExisting = false } = {}) {
  const requestedPeriod = selectedPeriod;
  try {
    const response = await fetch(`/api/sentiment?period=${encodeURIComponent(requestedPeriod)}`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.failures?.map((item) => item.message).join("; ") || `HTTP ${response.status}`);
    if (requestedPeriod !== selectedPeriod) return;
    saveCachedSentiment(requestedPeriod, payload);
    renderDashboard(payload);
  } catch (error) {
    if (preserveExisting || restoreCachedSentiment(requestedPeriod)) return;
    grid.innerHTML = `<article class="card loading-card error">实时数据获取失败<br /><small>${escapeHtml(error.message)}</small></article>`;
    strategyGrid.innerHTML = "";
  }
}

function renderDashboard(payload, { cached = false } = {}) {
  datePill.textContent = payload.displayDate;
  datePill.title = cached ? "当前显示本机缓存，后台正在更新" : "数据已更新";
  datePill.dataset.cache = cached ? "cached" : "live";
  selectedPeriod = payload.chartPeriod?.key ?? selectedPeriod;
  updatePeriodButtons(selectedPeriod);
  const orderedCards = [
    payload.cards.sp500,
    payload.cards.ndx,
    payload.cards.vix,
    payload.cards.vxn,
    payload.cards.spRsi,
    payload.cards.ndxRsi,
    payload.cards.fearGreed,
    // 趋势曲线卡统一放在底部
    payload.cards.gold,
    payload.cards.treasury,
    payload.cards.btc,
    payload.cards.btcMvrv,
    payload.cards.dollar,
    payload.cards.ashareValue
  ].filter(Boolean);

  grid.innerHTML = orderedCards.map(renderCard).join("");
  strategyGrid.innerHTML = payload.strategy.map(renderStrategy).join("");
  drawAllCharts();
}

function clientCacheKey(period) {
  return `rich:sentiment:${CLIENT_CACHE_VERSION}:${period}`;
}

function restoreCachedSentiment(period) {
  try {
    const cached = JSON.parse(localStorage.getItem(clientCacheKey(period)) ?? "null");
    const ageMs = Date.now() - Number(cached?.storedAt);
    if (!cached?.payload?.cards || !Number.isFinite(ageMs) || ageMs < 0 || ageMs > CLIENT_CACHE_MAX_AGE_MS) {
      if (cached) localStorage.removeItem(clientCacheKey(period));
      return false;
    }
    renderDashboard(cached.payload, { cached: true });
    return true;
  } catch {
    return false;
  }
}

function saveCachedSentiment(period, payload) {
  try {
    const sourceTimestamp = Date.parse(payload?.cache?.storedAt ?? payload?.generatedAt ?? "");
    const storedAt = Number.isFinite(sourceTimestamp) ? sourceTimestamp : Date.now();
    localStorage.setItem(clientCacheKey(period), JSON.stringify({ storedAt, payload }));
  } catch {
    // localStorage 受限或空间不足时继续使用网络数据。
  }
}

function renderLoadingState() {
  grid.innerHTML = Array.from(
    { length: 13 },
    (_, index) =>
      `<article class="card loading-card skeleton-card" ${index ? 'aria-hidden="true"' : 'role="status"'}>${
        index ? "" : "正在获取实时市场数据"
      }</article>`
  ).join("");
  strategyGrid.innerHTML = Array.from(
    { length: 4 },
    () => '<article class="strategy-card skeleton-strategy" aria-hidden="true"></article>'
  ).join("");
}

function renderCard(card) {
  const accentStyle = `style="--accent:${colors[card.accent] ?? card.accent}"`;
  if (card.kind === "index") return renderIndex(card, accentStyle);
  if (card.kind === "band") return renderBand(card, accentStyle);
  if (card.kind === "rank") return renderRank(card, accentStyle);
  if (card.kind === "fear") return renderFear(card, accentStyle);
  if (card.kind === "trend") return renderTrend(card, accentStyle);
  return renderMini(card, accentStyle);
}

function renderRank(card, accentStyle) {
  return `
    <article class="card band-card rank-card ${card.isLive ? "" : "unavailable"}" ${accentStyle}>
      <div class="accent-bar"></div>
      <h2>${escapeHtml(card.title)}</h2>
      <p class="sub">${escapeHtml(card.subtitle)}</p>
      <div class="rank-summary">
        <span>当前排名</span>
        <strong>前 ${formatNumber(card.value, 2)}%</strong>
      </div>
      <div class="state-pill"><b>${escapeHtml(card.pill)}</b><span>${escapeHtml(card.pillEn)}</span></div>
      <div class="rank-table">
        <div class="rank-row head"><span>排名</span><span>性价比</span></div>
        ${card.rows
          .map(
            (row, index) => `
              <div class="rank-row ${index === card.active ? "active" : ""}" style="--rank-color:${colors[row.tone] ?? colors.red}">
                <span>${escapeHtml(row.rank)}</span><strong>${escapeHtml(row.value)}</strong>
              </div>
            `
          )
          .join("")}
      </div>
      ${renderSource(card)}
    </article>
  `;
}

function renderIndex(card, accentStyle) {
  return `
    <article class="card index-card ${card.accent === "green" ? "sp" : "ndx"} ${card.isLive ? "" : "unavailable"}" ${accentStyle}>
      <div class="accent-bar"></div>
      <div class="title-row">
        <h2>${escapeHtml(card.title)}</h2>
        <span class="change-badge ${card.badgeTone}">${escapeHtml(card.badge)}</span>
      </div>
      <p class="sub">${escapeHtml(card.subtitle)}</p>
      <strong class="big-number">${formatNumber(card.value, 2)}</strong>
      <p class="move ${card.badgeTone}">${formatSignedMoney(card.change)} · ${escapeHtml(card.moveLabel)}</p>
      ${renderDrawdown(card)}
      <div class="metrics">
        ${renderMetricLine("PE", card.pe, card.peRank, card, card.peRankLabel)}
        ${typeof card.forwardPe === "number" ? renderMetricLine("Fwd", card.forwardPe, card.forwardRank, card, card.forwardRankLabel) : ""}
      </div>
      <div class="metrics-source">${escapeHtml(formatMetricSource(card))}</div>
      <div class="trend-label">PRICE TREND · ${escapeHtml(card.seriesPeriodLabel ?? "当日")}日线 · ${escapeHtml(card.seriesSource ?? card.source ?? "不可用")}</div>
      <canvas class="trend-canvas" width="440" height="112" data-marker="true" data-color="${colors[card.accent]}" data-series="${seriesData(card.series)}" data-labels="${labelData(card.seriesLabels)}"></canvas>
      ${renderSource(card)}
    </article>
  `;
}

function renderBand(card, accentStyle) {
  return `
    <article class="card band-card ${card.accent === "green" ? "sp" : "ndx"} ${card.isLive ? "" : "unavailable"}" ${accentStyle}>
      <div class="accent-bar"></div>
      <h2>${escapeHtml(card.title)}</h2>
      <p class="sub">${escapeHtml(card.subtitle)}</p>
      <strong class="center-number">${formatNumber(card.value, 2)}</strong>
      <div class="state-pill"><b>${escapeHtml(card.pill)}</b><span>${escapeHtml(card.pillEn)}</span></div>
      <div class="band-table">
        ${card.rows
          .map(
            (row, index) => `
              <div class="band-row ${index === card.active ? "active" : ""}">
                <span>${escapeHtml(row.range)}</span><b>${escapeHtml(row.mood)}</b><strong>${escapeHtml(row.action)}</strong>
              </div>
            `
          )
          .join("")}
      </div>
      ${renderSource(card)}
    </article>
  `;
}

function renderFear(card, accentStyle) {
  return `
    <article class="card fear-card fg ${card.isLive ? "" : "unavailable"}" ${accentStyle}>
      <div class="accent-bar yellow"></div>
      <h2>${escapeHtml(card.title)}</h2>
      <p class="sub">${escapeHtml(card.subtitle)}</p>
      <strong class="fear-number">${formatNumber(card.value, 0)}</strong>
      <div class="state-pill fear"><b>${escapeHtml(card.pill)}</b><span>${escapeHtml(card.pillEn)}</span></div>
      <div class="fear-scale">
        <div class="pointer" style="left:${pointerPosition(card.value)}%"></div>
        <div class="scale-bar">
          <span class="pink"></span><span class="yellow"></span><span class="blue"></span><span class="yellow"></span><span class="slate"></span>
        </div>
        <div class="scale-labels"><span>0-24</span><span>25-44</span><span>45-55</span><span>56-75</span><span>76-100</span></div>
      </div>
      <div class="playbook-table">
        <div class="play-row head"><span>区间</span><span>情绪</span><span>策略</span></div>
        ${(card.rows ?? [])
          .map(
            (row, index) => `
              <div class="play-row ${index === card.active ? "active" : ""}">
                <span>${escapeHtml(row.range)}</span><b>${escapeHtml(row.mood)}</b><strong>${escapeHtml(row.action)}</strong>${
                  index === card.active ? "<em>NOW</em>" : ""
                }
              </div>
            `
          )
          .join("")}
      </div>
      ${renderSource(card)}
    </article>
  `;
}

// 黄金 / 美债 / BTC / 美元指数：与标普500同款趋势曲线卡。
function renderTrend(card, accentStyle) {
  const color = colors[card.accent] ?? card.accent;
  return `
    <article class="card trend-card ${card.isLive ? "" : "unavailable"}" ${accentStyle}>
      <div class="accent-bar"></div>
      <div class="title-row">
        <h2>${escapeHtml(card.title)}</h2>
        <span class="change-badge ${card.badgeTone}">${escapeHtml(card.badge)}</span>
      </div>
      <p class="sub">${escapeHtml(card.subtitle)}</p>
      <strong class="big-number">${formatValue(card.value, card.valueFormat)}</strong>
      <p class="move ${card.badgeTone}">${escapeHtml(card.moveLabel)}</p>
      <div class="trend-label">PRICE TREND · ${escapeHtml(card.seriesPeriodLabel ?? "当日")}日线 · ${escapeHtml(card.seriesSource ?? card.source ?? "不可用")}</div>
      <canvas class="trend-canvas" width="440" height="112" data-marker="true" data-color="${color}" data-series="${seriesData(card.series)}" data-labels="${labelData(card.seriesLabels)}"></canvas>
      ${renderSource(card)}
    </article>
  `;
}

// 近 1 年回撤（DD），DD 超过 10% 时显示加仓提示。
function renderDrawdown(card) {
  if (typeof card.drawdown !== "number") return "";
  const ddText = `${card.drawdown.toFixed(2)}%`;
  const highText = typeof card.drawdownHigh === "number" ? `距1年高点 ${formatNumber(card.drawdownHigh, 2)}` : "";
  const alert = card.drawdownAlert
    ? `<em class="dd-alert">DD &gt; 10% · 提示加仓</em>`
    : "";
  return `
    <div class="drawdown ${card.drawdownAlert ? "alert" : ""}">
      <span>近1年回撤 DD</span>
      <b>${ddText}</b>
      ${alert}
      <i>${escapeHtml(highText)}</i>
    </div>
  `;
}

function renderMini(card, accentStyle) {
  const variant = card.accent === "yellow" ? "gold" : card.accent === "orange" ? "btc" : "tnx";
  return `
    <article class="card mini-card ${variant} ${card.isLive ? "" : "unavailable"}" ${accentStyle}>
      <div class="accent-bar"></div>
      <div class="mini-copy">
        <h2>${escapeHtml(card.title).replace(/\n/g, "<br />")}</h2>
        <p class="sub">${escapeHtml(card.subtitle).replace(/\n/g, "<br />")}</p>
        <strong>${formatValue(card.value, card.valueFormat)}</strong>
      </div>
      <span class="change-badge green">${escapeHtml(card.badge)}</span>
      <canvas class="mini-canvas" width="280" height="112" data-color="${colors[card.accent]}" data-series="${seriesData(card.series)}" data-labels="${labelData(card.seriesLabels)}"></canvas>
      <div class="mini-trend-label">折线 · ${escapeHtml(card.seriesPeriodLabel ?? "当日")}日线</div>
      ${renderSource(card)}
    </article>
  `;
}

function renderStrategy(item) {
  return `
    <article class="strategy-card ${item.key} ${item.isLive ? "" : "unavailable"}">
      <strong>${item.score === null ? "--" : item.score}</strong>
      <div>
        <b>${escapeHtml(item.action)}</b>
        <span>${escapeHtml(item.detail)}</span>
      </div>
    </article>
  `;
}

function renderSource(card) {
  const trendDetail = card.seriesSource ? ` · 折线：${card.seriesSource}/${card.seriesPeriodLabel ?? "当日"}` : "";
  const sourceDetail = card.metricsSource
    ? `行情：${card.source ?? "不可用"} · 估值：${card.metricsSource}${trendDetail}`
    : `来源：${card.source}${trendDetail}`;
  const detail = card.isLive ? sourceDetail : `实时源不可用${card.error ? `：${card.error}` : ""}`;
  return `<small class="source-note">${escapeHtml(detail)}</small>`;
}

function updatePeriodButtons(period) {
  periodButtons.forEach((button) => {
    const active = button.dataset.period === period;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function formatMetricSource(card) {
  if (!card.metricsSource) return "估值来源：不可用";
  const date = card.metricsUpdatedAt ? ` · ${card.metricsUpdatedAt}` : "";
  return `估值来源：${card.metricsSource}${date}`;
}

function renderMetricLine(label, value, rank, card, rankLabel) {
  const detail =
    typeof rank === "number"
      ? `| ${rankLabel || "10Y分位"}: ${formatPercent(rank)}`
      : `| ${formatCompactMetricSource(card)}`;
  return `<p><span>${escapeHtml(label)}</span> <b>${formatNumber(value, 1)}</b> <em>${escapeHtml(detail)}</em> <i>·</i></p>`;
}

function formatCompactMetricSource(card) {
  if (!card.metricsSource) return "估值源: --";
  const source = card.metricsSource === "VCP Scanner" ? "VCP" : card.metricsSource;
  return card.metricsUpdatedAt ? `${source} ${card.metricsUpdatedAt}` : source;
}

function drawAllCharts() {
  document.querySelectorAll("canvas[data-series]").forEach((canvas) => {
    const series = canvas.dataset.series.split(",").map(Number).filter(Number.isFinite);
    const labels = canvas.dataset.labels ? canvas.dataset.labels.split(",") : [];
    drawSpark(canvas, series, canvas.dataset.color, canvas.dataset.marker === "true", labels);
  });
}

function drawSpark(canvas, series, color, marker, labels = []) {
  const ctx = canvas.getContext("2d");
  const width = canvas.width;
  const height = canvas.height;
  ctx.clearRect(0, 0, width, height);

  if (series.length < 2) {
    ctx.fillStyle = "#7c8491";
    ctx.font = "700 18px sans-serif";
    ctx.fillText("实时趋势不可用", 16, height / 2);
    return;
  }

  const padX = marker ? 18 : 12;
  const padTop = 14;
  const labelPad = 20;
  const plotHeight = height - padTop - labelPad;
  const min = Math.min(...series);
  const max = Math.max(...series);
  const range = max - min || 1;
  const points = series.map((value, index) => ({
    x: padX + (index / (series.length - 1)) * (width - padX * 2),
    y: padTop + (1 - (value - min) / range) * plotHeight
  }));

  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  drawPath(ctx, points, color, marker ? 7 : 5);

  ctx.fillStyle = "#9da2aa";
  ctx.font = "800 11px sans-serif";
  const ticks = buildAxisTicks(labels, series.length);
  ticks.forEach((tick) => {
    const x = padX + tick.ratio * (width - padX * 2);
    ctx.textAlign = tick.align;
    ctx.fillText(tick.label, x, height - 3);
  });
  ctx.textAlign = "start";

  if (marker) {
    const last = points.at(-1);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(last.x, last.y, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 4;
    ctx.stroke();
  }
}

function drawPath(ctx, points, color, width) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  points.forEach((point, index) => {
    if (index === 0) ctx.moveTo(point.x, point.y);
    else ctx.lineTo(point.x, point.y);
  });
  ctx.stroke();
}

function seriesData(series) {
  return Array.isArray(series) ? series.filter((value) => typeof value === "number").join(",") : "";
}

function labelData(labels) {
  return Array.isArray(labels) ? labels.map((label) => String(label).replace(/,/g, " ")).join(",") : "";
}

function buildAxisTicks(labels, pointCount) {
  const fallback = pointCount >= 3 ? ["开始", "中点", "最新"] : ["开始", "最新"];
  const source = labels.length ? labels : fallback;
  const middle = Math.floor((source.length - 1) / 2);
  if (source.length < 3) {
    return [
      { label: source[0] ?? "开始", ratio: 0, align: "left" },
      { label: source.at(-1) ?? "最新", ratio: 1, align: "right" }
    ];
  }
  return [
    { label: source[0], ratio: 0, align: "left" },
    { label: source[middle], ratio: 0.5, align: "center" },
    { label: source.at(-1), ratio: 1, align: "right" }
  ];
}

function pointerPosition(value) {
  return typeof value === "number" ? Math.max(0, Math.min(92, value)) : 50;
}

function formatValue(value, format) {
  if (typeof value !== "number") return "--";
  if (format === "currency") return `$${formatNumber(value, 2)}`;
  if (format === "currency0") return `$${formatNumber(value, 0)}`;
  if (format === "percent") return `${formatNumber(value, 2)}%`;
  return formatNumber(value, 2);
}

function formatNumber(value, digits) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "--";
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  }).format(value);
}

function formatPercent(value) {
  return typeof value === "number" ? `${value.toFixed(1)}%` : "--";
}

function formatSignedMoney(value) {
  if (typeof value !== "number") return "--";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
