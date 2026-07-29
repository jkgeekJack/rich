# rich.jkgeekjk.xyz 静态可抓取内容层 — 设计

- 日期：2026-07-28
- 站点：https://rich.jkgeekjk.xyz（Vercel 项目 `invest_website`，Hobby 套餐）
- 相关研究：`seo-research/REPORT.md`（20 个关键词机会 + 简报）
- 修订：**v7。范围已收窄**——不做定时任务、不加构建步骤，本轮只做页面底部说明 + 主站引导。
  v1–v5 的天级快照方案（cron + Deploy Hook + buildCommand）整体移出本轮范围，保留在 §8 备查。

## 1. 问题

首页 `public/index.html` 只有 5,961 字节，去掉标签后的可见文字 211 字符，其中还包含「正在获取实时市场数据」这类占位符。所有数值由 `public/app.js` 加载后从 `/api/sentiment` 拉取填充。

三个具体缺陷：

1. **解释性内容完全不存在**。指标释义、阈值分档、常见问题在页面上以任何形式都没有。而这才是能排名的东西（「VIX 多少算恐慌」「恐惧贪婪指数 40 代表什么」）。
2. **现有站点介绍被放在 `<noscript>` 里**（`public/index.html:115-123`）。Googlebot 执行 JS，渲染时 `<noscript>` 内容被忽略，因此这段文字对搜索引擎等于不存在。
3. **孤岛单页**：整页 0 个 `<a>`。既没有指向主站与姊妹站的内链，也没有指向数据来源的权威出链。爬虫进来无处可去，主域权重也无法互相传导。

补充判断：Googlebot 能执行 JS，所以仪表盘数值**有可能**被索引。这不是「一定抓不到」，而是依赖渲染预算、不可靠。本轮不追求把实时数值静态化（那需要构建步骤），只补页面本来完全没有的解释性内容与链接结构。

## 2. 目标与非目标

**目标**

- 首页在不执行 JS 的前提下即含完整的解释性内容
- 补上指向主站、姊妹站与权威数据源的链接，解决孤岛单页
- 现有仪表盘 DOM 与 `app.js` 行为完全不变

**非目标**

- **不做定时任务**（cron / Deploy Hook）
- **不加构建步骤**（不动 `vercel.json` 的 buildCommand，不新增 build 脚本）
- 不把实时数值静态化（没有构建步骤就没有注入时机）
- 不新建独立页面（本轮范围仅首页）
- 不改 `public/app.js`
- 不改 `server.js`

## 3. 架构

```
public/index.html   追加静态说明层 + 主站/姊妹站引导；介绍移出 <noscript>
public/styles.css   追加静态层样式，不修改现有选择器
scripts/verify-bands.mjs  新增：比对静态分档表与线上 API，检测不一致
package.json        加 verify:bands 脚本
vercel.json         不动
server.js           不动
public/app.js       不动
```

没有构建步骤，因此 `public/index.html` 就是最终产物，改完即所见。

## 4. 静态说明层规格

插入位置：`.strategy`（`public/index.html:105-113`）的 `</section>` 之后、`</main>`（`:124`）之前。同时把现有介绍从 `<noscript>` 移入真实 DOM，`<noscript>` 只保留「需启用 JavaScript」那一句。

### 4.1 章节结构

| 章节 | 内容 | 目的 |
|---|---|---|
| `<h2>什么是美股市场情绪</h2>` | 40–55 字定义段 | 抢定义型精选摘要 |
| `<h2>指标速查表</h2>` | 静态 `<table>`，见 4.2 | 抢表格型摘要 |
| `<h2>各指标怎么读</h2>` | 4 段：波动率族 / 动量族 / 情绪合成 / 股债性价比，每段说明顺势还是反向 | 主题深度 |
| `<h2>常见问题</h2>` | 6 条 FAQ + `FAQPage` JSON-LD | 抢 FAQ 摘要 |
| `<h2>数据口径与来源</h2>` | 出站链接：Cboe / CNN / US Treasury / 好买基金 / Yahoo Finance | EEAT 权威外链 |
| `<h2>更多作品</h2>` | 主站与姊妹站引导，见 4.5 | 解决孤岛单页 |

免责声明紧贴速查表与 FAQ，不放页脚。

### 4.2 指标速查表：分档写死 + 校验脚本兜底

列：`指标` / `分档` / `含义` / `仪表盘操作提示`

**没有构建步骤，分档只能写死在 HTML 里。** 这是本轮范围收窄的直接后果：v1–v5 依赖构建时拉 API 来保证「分档与仪表盘同源、绝不手写」，该保证现已失效。

替代处置：`scripts/verify-bands.mjs` 拉 `/api/sentiment` 并断言静态表中每一档的文字与 `cards[*].rows` 一致，不一致则非零退出。把「防止不一致」降级为「检测到不一致」。该脚本不进构建、不进部署，手动或并入现有 `npm run verify` 执行。

**解析契约必须显式定义，否则脚本会退化成脆弱正则**：

- HTML 侧给每个指标的行组加机器可读标记 `data-card-key="vix|vxn|spRsi|ndxRsi|fearGreed|ashareValue"`，脚本按该属性定位，不依赖行序或标题文字
- 比较对象是**HTML 实体解码后的文本**，并把连续空白折叠为单个空格后再比（避免 `< 12` 与 `<&nbsp;12` 之类的假失败）
- API 地址默认 `https://rich.jkgeekjk.xyz/api/sentiment?period=1y`，可用 `SENTIMENT_URL` 覆盖
- 退出策略：分档不一致 → 退出码 1 并打印差异；**API 不可达或返回非 200 → 退出码 2 并明确提示「未能校验」**，不要伪装成通过

初始写入的分档（取自 2026-07-28 的线上 API，覆盖 6 张卡片 `vix`/`vxn`/`spRsi`/`ndxRsi`/`fearGreed`/`ashareValue`）：

| 指标 | 分档 |
|---|---|
| VIX | `<12` 极低波动 / `12-20` 正常波动 / `20-30` 波动抬升 / `30-50` 恐慌区间 / `>50` 极端恐慌 |
| VXN | `<15` / `15-22` / `22-32` / `32-55` / `>55`（语义同上，纳指版） |
| S&P RSI(14) | `<30` 超卖 / `30-50` 偏弱 / `50-70` 中性偏强 / `70-80` 偏热 / `>80` 过热 |
| NDX RSI(14) | 同 S&P RSI |
| 恐惧与贪婪 | `0-24` 极度恐惧 / `25-44` 恐惧 / `45-55` 中性 / `56-75` 贪婪 / `76-100` 极度贪婪 |
| A股股债性价比 | 分位 `前0%-10%` 高 / `10%-30%` 较高 / `30%-70%` 中等 / `70%-90%` 较低 / `90%-100%` 低 |

`仪表盘操作提示` 列保留 API 的 `action` 原文。列头写「仪表盘操作提示」而非「建议」，并在表格紧邻处声明：以上为仪表盘依据阈值自动生成的提示，仅供研究参考，不构成投资建议。

### 4.3 校验脚本必须处理两种 rows 结构

**A股卡片与其他卡片的 rows 字段名不同**：

- `vix` / `vxn`（`server.js:1131-1158`）、`spRsi` / `ndxRsi`（`:1160-1181`）、`fearGreed`（`:1188-1209`）→ `{ range, mood, action }`
- `ashareValue`（`server.js:673-700`）→ `{ rank, value, tone }`。`action`（积极配置 / 逢低布局 / 均衡持有 / 谨慎控仓 / 落袋观望）存在于内部 `ashareValueBands`（`server.js:621-626`）但**未进入 API**

因此校验脚本按字段名归一化：`range ?? rank` 作分档、`mood ?? value` 作含义。

关于 A股的 `action`，准确表述是：**API 不提供五档 action 列表，只提供当前所处档位的 action**（经由 `strategy`，`server.js:442`、`:707`）。因此校验脚本对 A股的操作提示列**跳过逐档比对**，并在输出中标注「A股五档操作提示无 API 依据，人工维护，来源 `server.js:621-626`」；可选地对**当前档**那一格与 `strategy` 返回值做交叉验证。

本轮**不改 `server.js`** 去给 A股 rows 补 `action`——那是为构建时注入服务的，本轮没有构建步骤，不值得为此改 API。

### 4.4 静态表不标注当前档，但必须消除边界歧义

没有构建步骤就没有实时读数，静态表只列分档，不高亮当前档。当前档由上方 JS 渲染的仪表盘呈现（`public/app.js:196` 用 `index === card.active` 高亮）。因此**不需要在静态层重算 `active`**。

**但这并不意味着可以忽略边界问题。** 静态表虽然不判档，它仍在**向读者定义区间**——而这些标签本身在边界上是有歧义的：

各卡片选档逻辑都是**严格小于**（波动率 `server.js:1131,1142`、RSI `:1164`、恐惧贪婪 `:1191`、A股 `:668`），而最后一档的展示文字是 `> 50` / `> 55` / `> 80`。于是 VIX = 50、VXN = 55、RSI = 80 时，**仪表盘会进入最后一档，而静态表的文字把该值排除在外**。若不处理，页面上最具解释权威感的那张表会在边界值上与工具自相矛盾。

处置：**标签文字保持与 API 的 `rows` 逐字一致**（这样 §4.2 的校验脚本可以做简单的字面比对），另在表格下方加一条边界说明：

> 分档按严格小于判定，读数恰好等于某档上界时归入更高一档。例如 VIX = 50 计入「> 50」档，RSI = 80 计入「> 80」档。

不采用把标签改写成 `≥` 的方案——那会让静态表与 API 文字不再一致，校验脚本被迫做语义等价判断，反而更易出错。

### 4.5 主站与姊妹站引导

现状整页 0 个 `<a>`。补一个「更多作品」区块，链接结构对齐 `ai-podcast` 已有的页脚做法（**相邻仓库参考**，非本仓库路径：`/Users/jack/personal/ai-podcast/build.js:377-383` 就链了主站、Rich、竹子、侨批）：

| 链接 | 目标 |
|---|---|
| Jack's Workshop 主站 | `https://jkgeekjk.xyz/` |
| 顶级 AI 播客中文摘要 | `https://ai-podcast.jkgeekjk.xyz/` |
| 竹子 · 思维框架 | `https://jkgeekjk.xyz/zhuzi` |
| 侨批 · AI 家书 | `https://jkgeekjk.xyz/qiaopi` |

跨站链接不加 `nofollow`（同一站长的作品集互链是正常的内部结构）。外部数据源链接加 `rel="noopener"`，`target="_blank"`。

这也让 `ai-podcast` ↔ `rich` 从单向变双向。

## 5. 校验方案

本轮**会改动可见内容**（这是本次目的），因此校验重点是「现有部分零变化 + 新增部分正确」。

1. **现有仪表盘节点未被改动**：基线取自固定 commit `a58de90` 的 `public/index.html`（`git show a58de90:public/index.html`）。各抽两个切片做字节比较：
   - dashboard：以 `<section class="grid"` 起、至其对应 `</section>` 止（基线 `:89-103`）
   - strategy：以 `<section class="strategy"` 起、至其对应 `</section>` 止（基线 `:105-113`）

   **不使用浏览器 `outerHTML`** —— 它会规范化属性与空白，且 `app.js` 运行后会重写 `#dashboardGrid` 内容
2. **分档一致**：`npm run verify:bands` 通过（按 §4.3 的归一化与跳过规则）
3. **结构化数据合法**：`FAQPage` JSON-LD 通过 `JSON.parse`，`mainEntity` 数量等于页面 FAQ 条数；原有 `WebApplication` JSON-LD 保持不变
4. **链接可达**：逐个 **GET**（跟随跳转后检查最终状态）。站内 4 个必须 200；外链记录状态，非 200 需人工确认后再决定是否保留：

   | 类型 | URL |
   |---|---|
   | 站内 | `https://jkgeekjk.xyz/`、`https://ai-podcast.jkgeekjk.xyz/`、`https://jkgeekjk.xyz/zhuzi`、`https://jkgeekjk.xyz/qiaopi` |
   | Cboe VIX | `https://www.cboe.com/tradable_products/vix/` |
   | CNN Fear & Greed | `https://www.cnn.com/markets/fear-and-greed` |
   | US Treasury 利率 | `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/` |
   | 好买股债性价比 | `https://data.howbuy.com/` |
   | Yahoo Finance | `https://finance.yahoo.com/` |

   注：外链目标站可能对自动请求返回 403/429（尤其 CNN），这不等于链接坏了，需人工在浏览器确认

4b. **新增内容的正向断言**（§5.7 的整段归一化会屏蔽该区间内的一切差异，因此必须单独逐项断言）：介绍已移出 `<noscript>`；`<noscript>` 内只剩「需启用 JavaScript」提示；§4.1 的 6 个章节标题均存在；速查表 6 个 `data-card-key` 行组齐全且各自档数正确；边界说明文字存在；FAQ 的可见文本与 `FAQPage` JSON-LD 的 `mainEntity` 逐条对应；站内链接无 `nofollow`、外链带 `rel="noopener"` 与 `target="_blank"`
5. **静态资源仍可达**：灰度环境验证 `/robots.txt`、`/sitemap.xml`、`/og-default.png` 均 200
6. **`/api` 未受影响**：灰度环境 `/api/health`、`/api/sentiment?period=1y`、`/api/asset/AAPL` 均 200（本轮虽不改 `vercel.json`，仍作为回归确认）
7. **灰度对比只比静态部分**：**不比较渲染后文本** —— 两端各自独立拉实时 API（`public/app.js:35`）并重写日期、仪表盘、策略（`:51`），行情与时间戳必然不同，会产生无关误报。改为比较两边**服务端下发的原始 HTML**：
   1. 两端各自把 `.strategy` 的结束 `</section>` 之后、`</main>` 之前的**整段**替换为固定占位符 `<!--REGION-->`
   2. 归一化后必须**逐字节相同**，任何差异判失败，尤其 `<head>` 与 dashboard/strategy 两节点
   3. 为什么必须整段归一化：现有介绍位于 `<noscript>`（`:115-123`），正在该区间内；本次会把它移出并新增章节，故这一整段两端必然不同，生产端 HTML **不可能**是灰度端的字节子集
8. **改动文件白名单**：最终 `git diff --name-only` 只允许出现 `public/index.html`、`public/styles.css`、`scripts/verify-bands.mjs`、`package.json`、以及本设计文档。出现任何其他文件即判失败——用来直接兑现「不动 `server.js` / `app.js` / `vercel.json`」的承诺

9. **上线流程**：
   - **部署前**（本地）：执行第 1、2、3、4b、8 条
   - **灰度后**：执行第 4、5、6、7 条，并目视灰度页面确认新区块排版正常、未挤压原有仪表盘
   - 全部通过 → promote

## 6. 风险

| 风险 | 处置 |
|---|---|
| 静态分档与仪表盘将来漂移 | 无构建步骤无法根治。`verify:bands` 检测（§4.2），发现即手工同步 |
| A股操作提示无 API 依据 | 明确标注为人工维护，来源 `server.js:621-626`；校验脚本跳过该列并提示（§4.3） |
| YMYL：操作提示被索引后被当作投资建议引用 | 列头写「仪表盘操作提示」，紧邻免责声明；措辞与仪表盘现有展示一致，不新增更强表述 |
| 介绍移出 `<noscript>` 改变了可见内容 | 这是本轮目的；`<noscript>` 保留「需启用 JS」提示，JS 禁用场景不退化 |
| 新增区块影响现有布局 | 只追加新选择器，不修改既有选择器；校验 1 的节点字节比对 + 校验 9 的灰度目视 |
| 静态表在边界值上与仪表盘矛盾 | 标签与 API 逐字一致，另加边界说明（§4.4） |
| 误改 server.js / app.js / vercel.json | 校验 8 的改动文件白名单 |

## 7. 本轮不需要任何人工配置

无环境变量、无 Deploy Hook、无 cron。改完即可灰度部署。

## 8. 已移出本轮范围（备查）

天级数据快照方案在 v1–v5 中已完整设计并经四轮 codex 代码核对，修正了 5 个阻断项（A股 rows 字段名差异、`CRON_SECRET` 未配置可被 `Bearer undefined` 绕过、Deploy Hook 缺 `AbortSignal.timeout` 导致永不返回 502、灰度比对渲染后文本不稳定、首次上线比对规则自相矛盾），以及两处错误结论（`outputDirectory` 并非必须；本项目框架预设是 `express` 而非 `Other`，故不应显式设 `outputDirectory`）。

若将来要恢复，需要：`vercel.json` 加 `buildCommand` 与 `crons`、新增 `scripts/build-snapshot.mjs`（`import.meta.url` 守卫、`SENTIMENT_FIXTURE`/`SENTIMENT_URL` 可注入、纯函数 `renderSnapshotTbody`）、`server.js` 加 fail-closed 的 `/api/rebuild`、给 A股 rows 补 `action`、配置 `DEPLOY_HOOK_URL` 与 `CRON_SECRET`。详见 git 历史中本文件的 v5（commit `4a94ddc`）。
