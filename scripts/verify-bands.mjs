#!/usr/bin/env node
// 校验 public/index.html 里写死的「指标速查表」分档是否仍与线上 API 一致。
//
// 背景：本页没有构建步骤，分档只能写死在 HTML 里，因此无法像构建期注入那样
// 保证「与仪表盘同源」。本脚本把这个保证降级为「检测到不一致」——一旦
// server.js 里改了阈值而 HTML 没跟上，这里会报出来。
//
// 不进构建、不进部署。手动或并入 npm run verify 执行。
//
// 退出码：0 一致 / 1 存在不一致 / 2 未能校验（API 不可达或页面结构不符预期）

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HTML_PATH = path.join(ROOT, "public/index.html");
const API_URL = process.env.SENTIMENT_URL || "https://rich.jkgeekjk.xyz/api/sentiment?period=1y";
const TIMEOUT_MS = 20000;

// 速查表覆盖的卡片。顺序仅用于输出可读性。
const CARD_KEYS = ["vix", "vxn", "spRsi", "ndxRsi", "fearGreed", "ashareValue"];

// API 只提供 A 股「当前档」的 action（经 strategy），不提供五档列表，
// 故该卡片的操作提示列跳过逐档比对。见设计文档 §4.3。
const SKIP_ACTION = new Set(["ashareValue"]);

const ENTITIES = {
  "&lt;": "<",
  "&gt;": ">",
  "&amp;": "&",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " "
};

function decode(value) {
  return value.replace(/&(?:lt|gt|amp|quot|#39|apos|nbsp);/g, (m) => ENTITIES[m] ?? m);
}

/** HTML 片段 → 可比较的纯文本：去标签、解码实体、折叠空白。 */
function cellText(html) {
  return decode(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

/** 从 HTML 中抽出每个 data-card-key 行组的 [range, mood, action] 列表。 */
function parseTable(html) {
  const out = {};
  const tbodyRe = /<tbody\b[^>]*\bdata-card-key="([^"]+)"[^>]*>([\s\S]*?)<\/tbody>/g;
  let match;
  while ((match = tbodyRe.exec(html)) !== null) {
    const rows = [];
    for (const tr of match[2].match(/<tr\b[\s\S]*?<\/tr>/g) ?? []) {
      const cells = (tr.match(/<td\b[^>]*>[\s\S]*?<\/td>/g) ?? []).map((td) =>
        cellText(td.replace(/^<td\b[^>]*>/, "").replace(/<\/td>$/, ""))
      );
      if (cells.length) rows.push(cells);
    }
    out[match[1]] = rows;
  }
  return out;
}

/** API 两种 rows shape 归一化：普通卡 {range,mood,action}，A股 {rank,value,tone}。 */
function normalizeApiRow(row) {
  return {
    range: cellText(String(row.range ?? row.rank ?? "")),
    mood: cellText(String(row.mood ?? row.value ?? "")),
    action: row.action === undefined || row.action === null ? null : cellText(String(row.action))
  };
}

async function fetchSnapshot() {
  let response;
  try {
    response = await fetch(API_URL, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    throw new Error(`请求失败：${error.message}`);
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function main() {
  if (!fs.existsSync(HTML_PATH)) {
    console.error(`[未能校验] 找不到 ${HTML_PATH}`);
    process.exit(2);
  }
  const table = parseTable(fs.readFileSync(HTML_PATH, "utf8"));

  const missing = CARD_KEYS.filter((key) => !table[key]?.length);
  if (missing.length) {
    console.error(`[未能校验] HTML 中缺少 data-card-key 行组：${missing.join(", ")}`);
    console.error("           速查表结构可能被改动，请检查 public/index.html");
    process.exit(2);
  }

  let payload;
  try {
    payload = await fetchSnapshot();
  } catch (error) {
    console.error(`[未能校验] 无法取得 ${API_URL}`);
    console.error(`           ${error.message}`);
    console.error("           这不代表分档一致，只代表本次没校验成功。");
    process.exit(2);
  }

  const problems = [];
  const notes = [];

  for (const key of CARD_KEYS) {
    const apiRows = payload?.cards?.[key]?.rows;
    if (!Array.isArray(apiRows) || apiRows.length === 0) {
      problems.push(`${key}: API 未返回 rows，无法比对`);
      continue;
    }
    const htmlRows = table[key];
    if (htmlRows.length !== apiRows.length) {
      problems.push(`${key}: 档数不一致 — HTML ${htmlRows.length} 档，API ${apiRows.length} 档`);
      continue;
    }
    const skipAction = SKIP_ACTION.has(key);
    if (skipAction) {
      notes.push(
        `${key}: 五档操作提示无 API 依据（API 只经 strategy 提供当前档），跳过该列比对；人工维护，来源 server.js 的 ashareValueBands`
      );
    }
    apiRows.forEach((raw, index) => {
      const api = normalizeApiRow(raw);
      const [range, mood, action] = htmlRows[index];
      if (range !== api.range) problems.push(`${key}[${index}] 分档：HTML「${range}」≠ API「${api.range}」`);
      if (mood !== api.mood) problems.push(`${key}[${index}] 含义：HTML「${mood}」≠ API「${api.mood}」`);
      if (!skipAction && api.action !== null && action !== api.action) {
        problems.push(`${key}[${index}] 操作提示：HTML「${action}」≠ API「${api.action}」`);
      }
    });
  }

  for (const note of notes) console.log(`  note  ${note}`);

  if (problems.length) {
    console.error(`\n[不一致] 共 ${problems.length} 处：`);
    for (const problem of problems) console.error(`  ✗ ${problem}`);
    console.error("\n请同步 public/index.html 的速查表，或确认 server.js 的阈值改动是否有意。");
    process.exit(1);
  }

  console.log(`\n[一致] ${CARD_KEYS.length} 张卡片的分档与含义均与 API 相符（数据源 ${API_URL}）`);
  process.exit(0);
}

main().catch((error) => {
  console.error(`[未能校验] 意外错误：${error.stack || error.message}`);
  process.exit(2);
});
