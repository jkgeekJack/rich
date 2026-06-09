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
let selectedPeriod = localStorage.getItem("sentimentChartPeriod") || "1y";

grid.innerHTML = `<article class="card loading-card">正在获取实时市场数据</article>`;
strategyGrid.innerHTML = "";

periodButtons.forEach((button) => {
  button.addEventListener("click", () => {
    selectedPeriod = button.dataset.period;
    localStorage.setItem("sentimentChartPeriod", selectedPeriod);
    updatePeriodButtons(selectedPeriod);
    loadSentiment();
  });
});
updatePeriodButtons(selectedPeriod);
loadSentiment();
window.setInterval(loadSentiment, 60_000);

async function loadSentiment() {
  try {
    const response = await fetch(`/api/sentiment?period=${encodeURIComponent(selectedPeriod)}&t=${Date.now()}`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.failures?.map((item) => item.message).join("; ") || `HTTP ${response.status}`);
    renderDashboard(payload);
  } catch (error) {
    grid.innerHTML = `<article class="card loading-card error">实时数据获取失败<br /><small>${escapeHtml(error.message)}</small></article>`;
  }
}

function renderDashboard(payload) {
  datePill.textContent = payload.displayDate;
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
    payload.cards.playbook,
    payload.cards.gold,
    payload.cards.treasury,
    payload.cards.btc,
    payload.cards.btcMvrv
  ].filter(Boolean);

  grid.innerHTML = orderedCards.map(renderCard).join("");
  strategyGrid.innerHTML = payload.strategy.map(renderStrategy).join("");
  drawAllCharts();
}

function renderCard(card) {
  const accentStyle = `style="--accent:${colors[card.accent] ?? card.accent}"`;
  if (card.kind === "index") return renderIndex(card, accentStyle);
  if (card.kind === "band") return renderBand(card, accentStyle);
  if (card.kind === "fear") return renderFear(card, accentStyle);
  if (card.kind === "playbook") return renderPlaybook(card, accentStyle);
  return renderMini(card, accentStyle);
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
      <div class="metrics">
        ${renderMetricLine("PE", card.pe, card.peRank, card)}
        ${typeof card.forwardPe === "number" ? renderMetricLine("Fwd", card.forwardPe, card.forwardRank, card) : ""}
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
      ${renderSource(card)}
    </article>
  `;
}

function renderPlaybook(card, accentStyle) {
  return `
    <article class="card playbook-card fg ${card.isLive ? "" : "unavailable"}" ${accentStyle}>
      <div class="accent-bar yellow"></div>
      <h2>${escapeHtml(card.title)}</h2>
      <p class="sub">${escapeHtml(card.subtitle)}</p>
      <div class="playbook-table">
        <div class="play-row head"><span>区间</span><span>情绪</span><span>策略</span></div>
        ${card.rows
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

function renderMetricLine(label, value, rank, card) {
  const detail =
    typeof rank === "number"
      ? `| 10Y分位: ${formatPercent(rank)}`
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
    ctx.font = "700 18px Noto Sans SC, sans-serif";
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
  ctx.font = "800 11px Inter, sans-serif";
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
