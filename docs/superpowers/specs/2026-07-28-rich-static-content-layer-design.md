# rich.jkgeekjk.xyz 静态可抓取内容层 — 设计

- 日期：2026-07-28
- 站点：https://rich.jkgeekjk.xyz（Vercel 项目 `invest_website`，Hobby 套餐）
- 相关研究：`seo-research/REPORT.md`（20 个关键词机会 + 简报）
- 修订：v5。经四轮 codex read-only 代码核对，累计修正 5 个阻断项 + 23 条改进；另自行查证并修正了框架预设相关的一处错误结论

## 1. 问题

首页 `public/index.html` 只有 5,961 字节，去掉标签后的可见文字 211 字符，其中还包含「正在获取实时市场数据」这类占位符。所有数值由 `public/app.js` 加载后从 `/api/sentiment` 拉取填充。

两个具体缺陷：

1. **解释性内容完全不存在**。指标释义、阈值分档、常见问题在页面上以任何形式都没有。而这才是能排名的东西（「VIX 多少算恐慌」「恐惧贪婪指数 40 代表什么」）。
2. **现有站点介绍被放在 `<noscript>` 里**（`public/index.html:115-123`）。Googlebot 执行 JS，渲染时 `<noscript>` 内容被忽略，因此这段文字对搜索引擎等于不存在。

补充判断：Googlebot 能执行 JS，所以仪表盘数值**有可能**被索引。这不是「一定抓不到」，而是依赖渲染预算、不可靠。静态化的目的是消除这个不确定性，不是从 0 到 1。

## 2. 目标与非目标

**目标**

- 首页在不执行 JS 的前提下即含完整的解释性内容与当日关键读数
- 阈值分档与仪表盘**同源**，不出现两套互相矛盾的数字
- 读数每天刷新一次（Hobby 套餐 cron 的最小间隔就是每天一次）
- 现有仪表盘 DOM 与 `app.js` 行为完全不变

**非目标**

- 不新建独立页面（本轮范围仅首页）
- 不做分钟级/小时级更新（Hobby 套餐会直接部署失败）
- 不改 `public/app.js`
- 不改 `server.js` 的**取数与算档逻辑**（唯一例外见 §4.3，一行序列化补充）

## 3. 架构

```
public/index.html          追加静态内容层；速查表 <tbody> 用标记包裹
public/styles.css          追加静态层样式，不修改现有选择器
scripts/build-snapshot.mjs 新增：构建时拉 API，生成速查表 <tbody>
scripts/verify-snapshot.mjs 新增：fixture 驱动的断言（幂等/边界/降级/转义）
server.js                  新增 app.get("/api/rebuild")；A股 rows 补 action（§4.3）
vercel.json                加 buildCommand / crons（不设 outputDirectory，见 §5.4）
package.json               加 build 与 verify:snapshot 脚本
public/app.js              不改
```

### 3.1 数据来源与可注入性

构建脚本默认请求 `https://rich.jkgeekjk.xyz/api/sentiment?period=1y`，但**输入必须可注入**，否则 fixture 测试无法进行：

- `SENTIMENT_FIXTURE`：本地 JSON 文件路径。设置时直接读文件，不发网络请求
- `SENTIMENT_URL`：覆盖默认 API 地址
- 核心转换逻辑必须导出为**纯函数** `renderSnapshotTbody(payload) -> string`，不含任何 I/O，供 `verify-snapshot.mjs` 直接调用

**模块必须无顶层副作用**：`build-snapshot.mjs` 的 `main()` 只在直接运行时执行（`if (import.meta.url === pathToFileURL(process.argv[1]).href)`），否则验证脚本 import 纯函数时会触发网络请求并改写 `public/index.html`。

### 3.2 构建脚本为什么走 HTTPS 而不是 import server.js

`server.js:1881-1889` 在默认导出 app 之后，仅当 `process.env.VERCEL !== "1"` 时调用 `app.listen`。构建脚本若 import 它，在 Vercel 上安全（构建环境有 `VERCEL=1`），但**本地执行会真的启动监听并让进程一直存活**。因此构建脚本走 HTTPS：

- 零侵入，不需要为了导出 `loadSentimentSnapshot` 而重构 `server.js`
- 复用线上 API 自身缓存，构建期不重复打上游数据源
- 天然降级：请求失败就保留仓库里已提交的回退内容

代价：构建依赖「上一个部署」可用。可接受——上一个部署始终在线。

### 3.3 cron 路径能命中 Express 路由（已实测）

现有 rewrite 是 `/api/(.*)` → `/api`（`vercel.json:2-7`），`api/index.js` 导出完整 Express app。关键问题是被 rewrite 之后 Express 收到的是 `/api` 还是原始路径。**实测判定**：请求 `/api/zzz-not-a-route` 返回 Express 默认 404 `Cannot GET /api/zzz-not-a-route`，且多段路由 `/api/asset/AAPL`（`server.js:222`）返回 200。证明 Express 收到完整原始路径，因此新增 `app.get("/api/rebuild")` 可被 cron 命中。

## 4. 静态内容层规格

插入位置：`.strategy`（`public/index.html:105-113`）之后、`</main>`（`:124`）之前。同时把现有介绍从 `<noscript>` 移入真实 DOM，`<noscript>` 只保留「需启用 JavaScript」那一句。

### 4.1 章节结构

| 章节 | 内容 | SEO 目的 |
|---|---|---|
| `<h2>什么是美股市场情绪</h2>` | 40–55 字定义段 | 抢定义型精选摘要 |
| `<h2>指标速查表</h2>` | 单张 `<table>`，见 4.2 | 抢表格型摘要；静态科普与活数据一体化 |
| `<h2>各指标怎么读</h2>` | 4 段：波动率族 / 动量族 / 情绪合成 / 股债性价比。每段说明顺势还是反向 | 主题深度 |
| `<h2>常见问题</h2>` | 6 条 FAQ + `FAQPage` JSON-LD | 抢 FAQ 摘要 |
| `<h2>数据口径与来源</h2>` | 出站链接到 Cboe / CNN / US Treasury / 好买基金 / Yahoo Finance | 补齐 EEAT 权威外链缺口 |

免责声明紧贴速查表与 FAQ，不放页脚。

### 4.2 指标速查表

列：`指标` / `分档` / `含义` / `仪表盘操作提示` / `最近快照（日期）`

分档文字**全部取自 `/api/sentiment` 的 `cards[*].rows`，不手写**，保证静态表与仪表盘同源。覆盖 6 张卡片：`vix`、`vxn`、`spRsi`、`ndxRsi`、`fearGreed`、`ashareValue`（key 与 `server.js:388-440`、`public/app.js:60-71` 一致）。

`仪表盘操作提示` 列保留 API 的 `action` 原文。列头写「仪表盘操作提示」而非「建议」，并在表格紧邻处声明：以上为仪表盘依据阈值自动生成的提示，仅供研究参考，不构成投资建议。

### 4.3 两种 rows 结构必须分别处理

**A股卡片与其他卡片的 rows 字段名不同**：

- `vix` / `vxn`（`server.js:1131-1158`）、`spRsi` / `ndxRsi`（`:1160-1181`）、`fearGreed`（`:1188-1209`）→ `{ range, mood, action }`
- `ashareValue`（`server.js:673-700`）→ `{ rank, value, tone }`。`action`（积极配置 / 逢低布局 / 均衡持有 / 谨慎控仓 / 落袋观望）存在于内部 `ashareValueBands`（`server.js:621-626`）但**未进入 API**

处置：在 `buildAshareValueCard` 的 rows 映射里补 `action: band.action`。这是**序列化层一行追加**，不触碰取数与算档逻辑。已核实 `public/app.js:132-155` 的 `renderRank` 只读 `row.tone` / `row.rank` / `row.value` 与 `card.active`，且 `app.js` 全文无 `Object.keys/entries/for-in` 遍历 rows 的代码，因此多出的字段对前端是**可证明惰性**的。

构建脚本按字段名归一化：`range ?? rank` 作分档、`mood ?? value` 作含义、`action` 作操作提示。

**部署时序**：构建脚本读的是「上一个部署」的 API。本次改动首次上线时，上一个部署的 A股 rows 还没有 `action`，因此该格渲染为 `—`；新生产部署生效后，下一次 cron 或任何后续重建即自动补齐。脚本必须容忍 `action` 缺失，不得因此失败。

### 4.4 高亮当前分档只能用 API 的 `active`

所有目标卡片的选档逻辑都是**严格小于**：波动率 `server.js:1142`、RSI `:1164`、恐惧贪婪 `:1191`、A股 `:668`。而波动率最后一档的展示文字是 `> 50` / `> 55`。因此**读数恰好等于 50 时会落入标签为「> 50」的那一档**，RSI 在 80 时同理。rows 是可靠的**展示同源依据**，但不是数学上完备的阈值定义。

结论：静态表高亮当前分档**必须直接使用 API 返回的 `active` 索引**，禁止在构建脚本里解析 range 字符串自行判断。这与前端一致——`public/app.js:196` 也是直接比较索引与 `card.active`。

### 4.5 为什么不做独立的「今日快照」区块

若单独开一个快照区块，页面上会同时存在实时仪表盘数值与快照数值两套数字，同一交易日内必然不一致。合并成速查表的一列可避免这个矛盾，并且正好命中 `seo-research/REPORT.md` 指出的最大内容缺口：「静态科普与实时活数据割裂，没人做成一体化页面」。

## 5. 天级快照规格

### 5.1 数据流

```
每天 01:00 UTC（Hobby 精度：该小时内任意时刻）
  → GET /api/rebuild，校验 Authorization: Bearer $CRON_SECRET
  → POST $DEPLOY_HOOK_URL
  → Vercel 重新构建，执行 buildCommand: node scripts/build-snapshot.mjs
       GET /api/sentiment（或 SENTIMENT_FIXTURE）
       生成 <tbody>，替换 <!--SNAPSHOT:START--> … <!--SNAPSHOT:END--> 之间的内容
  → 部署完成：CDN 上的 index.html 含当日读数
浏览器端：app.js 行为不变，照旧拉 /api/sentiment 渲染实时仪表盘
```

`crons` 只对**生产部署**生效，灰度部署不会触发。

### 5.2 幂等、转义与降级

- 脚本对标记块做**替换**而非追加
- 写入前断言：`<!--SNAPSHOT:START-->` 与 `<!--SNAPSHOT:END-->` 各恰好出现一次且顺序正确，否则报错退出（避免静默写坏页面）
- API 返回的所有文本插入 HTML 前必须转义 `& < > "`（可参照 `public/app.js:471` 的既有实现）
- 仓库中提交的标记块内容 = 完整阈值表 + 快照列显示 `—`。这是回退态，本身已是有效内容
- 拉取失败：打印警告，**以退出码 0 结束**，保留回退态，构建照常成功
- 任何情况下首页都不因上游 API 故障而变慢或返回 5xx（首页始终是 CDN 上的静态文件）

### 5.3 `/api/rebuild` 必须 fail-closed

**这是安全要求，不是可选项。** 若实现为 ``req.headers.authorization === `Bearer ${process.env.CRON_SECRET}` ``，当 `CRON_SECRET` 未配置时 `undefined` 会被插值成字符串，攻击者发送 `Bearer undefined` 即可通过。

**检查顺序是规格的一部分**，必须严格按此顺序，确保未认证请求永远得到 401、且不泄露 Hook 是否已配置：

| 顺序 | 条件 | 响应 | 是否调用 Deploy Hook |
|---|---|---|---|
| 1 | `!process.env.CRON_SECRET` | 401 | 否 |
| 2 | Authorization 缺失 / 长度不等 / 等长但内容不符 | 401 | 否 |
| 3 | `!process.env.DEPLOY_HOOK_URL` | 500 | 否 |
| 4 | Hook 返回非 2xx | 502 | 是，失败需记录 |
| 5 | Hook 超时或抛错 | 502 | 是，失败需记录 |
| 6 | Hook 成功 | 200 | 是 |

密钥比较：先比长度，长度不等直接判否（不进入下一步），等长再用 `crypto.timingSafeEqual`。

**必须有主动超时机制**：原生 `fetch` 无默认超时，可能永久 pending，导致永远进不了 502 分支。实现必须传入 `signal: AbortSignal.timeout(8000)`（Vercel 的 Node 20+ 支持），abort 后按第 5 行返回 502。8 秒远小于函数默认执行上限，且 Deploy Hook 正常响应在百毫秒级。

该路由不返回任何业务数据。

### 5.4 vercel.json 变更

```jsonc
{
  "buildCommand": "node scripts/build-snapshot.mjs",
  "crons": [{ "path": "/api/rebuild", "schedule": "0 1 * * *" }]
  // 现有 rewrites 与 headers 保持不变
  // 明确不设 outputDirectory，理由见下
}
```

**不设 `outputDirectory`。** 经查 Vercel API，本项目的框架预设是 **`framework: "express"`**（不是 "Other"，`nodeVersion: 24.x`，`buildCommand` 与 `outputDirectory` 当前均为空）。Express 预设的官方文档明确：

> To serve static assets, place them in the `public/**` directory. They will be served as a part of our CDN
> `express.static()` will be ignored and will not serve static assets.

即 **express 预设下 `public/**` 本来就由 CDN 托管，无需 `outputDirectory`**。反过来，给一个*后端*框架预设显式声明 `outputDirectory` 不是文档中的用法，有可能让平台按「静态产物目录」处理，进而影响 Express 函数的构建与路由——那会直接搞挂 `/api/*`。因此这里**不设**该项。

顺带澄清一个既有事实：`server.js:98` 的 `app.use(express.static(...))` 在 Vercel 上是**惰性的**（按上述文档会被忽略），它只在本地 `npm run dev` 时起作用。因此本设计与它无交互。

**剩余不确定性**：在 express 预设下新增自定义 `buildCommand` 不是文档覆盖的组合。这一点不靠推断解决，靠灰度实测——见校验 11。

### 5.5 需要人工配置的环境变量

| 变量 | 来源 | 用途 |
|---|---|---|
| `DEPLOY_HOOK_URL` | Vercel 项目设置 → Git → Deploy Hooks 创建后复制 | cron 触发重新构建 |
| `CRON_SECRET` | 自行生成随机串 | 保护 `/api/rebuild` |

两者都存为 Vercel 环境变量，**不写入仓库**。缺任一项时按 §5.3 fail-closed。

## 6. 校验方案

本轮**会改动可见内容**（这是本次目的），因此校验重点从「内容零变化」改为「现有部分零变化 + 新增部分正确」。

1. **现有仪表盘节点未被改动**：基线取自**固定 commit** `a58de90`（改动前的 `HEAD`）的 `public/index.html`（`git show a58de90:public/index.html`）。从基线与改动后文件中各抽取两个切片做字节比较：
   - dashboard：以 `<section class="grid"` 起、至其对应 `</section>` 止（基线 `:89-103`）
   - strategy：以 `<section class="strategy"` 起、至其对应 `</section>` 止（基线 `:105-113`）

   **不使用浏览器 `outerHTML`** —— 它会规范化属性与空白，且 `app.js` 运行后会重写 `#dashboardGrid` 内容
2. **分档同源**：在**转义前的中间模型**上断言每一档文字与 `cards[*].rows` 一致（按 §4.3 归一化规则）；不在已转义的 HTML 字符串上比较
3. **高亮正确（行为断言，非代码检查）**：用边界 fixture 至少覆盖 `VIX=50`、`VXN=55`、`RSI=80`，断言高亮行索引恒等于 API 的 `active`
4. **结构化数据合法**：`FAQPage` JSON-LD 通过 `JSON.parse`，`mainEntity` 数量等于页面 FAQ 条数
5. **构建幂等**：用**同一份固定 fixture**（`SENTIMENT_FIXTURE`）连续执行两次，产物逐字节相同。不可用两次真实 API 调用验证——行情与日期会变
6. **A股旧 shape 兼容**：专门一份 fixture 模拟 A股 rows 无 `action`，断言该列输出 `—` 且脚本退出码 0
7. **降级可用**：从**已提交的回退态**（`git checkout public/index.html` 或临时副本）开始，模拟 API 不可达执行构建，断言退出码 0 且页面含完整阈值表。不可在一次成功构建后直接断网重跑——那样「保留现有内容」会保留上一次的快照，证明不了回退表完整
8. **cron 端点**：逐例覆盖 §5.3 的六种情形，**每例都断言 Deploy Hook 的调用次数**（前三例必须为 0 次）：

   | 用例 | 期望状态码 | 期望 Hook 调用次数 |
   |---|---|---|
   | `CRON_SECRET` 未配置 | 401 | 0 |
   | 无 Authorization 头 | 401 | 0 |
   | bearer 长度与密钥不等 | 401 | 0 |
   | bearer 等长但内容错误 | 401 | 0 |
   | 鉴权通过但 `DEPLOY_HOOK_URL` 未配置 | 500 | 0 |
   | Hook 返回 500 | 502 | 1 |
   | Hook 保持 pending 直至收到 abort | 502 | 1 |
   | Hook 返回 200 | 200 | 1 |

   用 `scripts/verify-fixture.mjs:70-117` 的全局 fetch stub 模式。超时用例的 stub 须返回一个**永不 resolve、仅在 `signal` 触发 abort 时 reject** 的 Promise，以真正验证主动超时生效
9. **静态资源仍可达**：灰度环境验证 `/robots.txt`、`/sitemap.xml`、`/og-default.png` 均 200
10. **灰度对比只比静态部分**：**不比较渲染后文本** —— 灰度与生产各自独立拉实时 API（`public/app.js:35`）并重写日期、仪表盘、策略（`:51`），行情与时间戳必然不同，会产生大量无关误报。改为比较两边**服务端下发的原始 HTML**（`curl` 取得，不经浏览器）。

    判定规则（首次上线与后续上线**统一**，不分情况）：

    1. 对两端各自做同一次归一化：把 `.strategy` 的结束 `</section>` 之后、`</main>` 之前的**整段**替换为固定占位符 `<!--REGION-->`
    2. 归一化后的两份 HTML 必须**逐字节相同**。任何差异都判失败，尤其 `<head>` 与 dashboard/strategy 两个节点
    3. 标记数量单独断言：灰度端 `<!--SNAPSHOT:START-->` 与 `<!--SNAPSHOT:END-->` 各恰好 1 次

    为什么必须整段归一化：现有介绍位于 `<noscript>`（`public/index.html:115-123`），而该区间正在 `.strategy` 结束与 `</main>` 之间。本次改动会把介绍移出 `<noscript>` 并新增章节，因此这一整段在两端必然不同，生产端 HTML **不可能**是灰度端的字节子集。把整段一并归一化才能得到确定、可通过的断言

11. **灰度必须确认 Express 函数未被破坏**（因本轮新增 `buildCommand`，见 §5.4）：灰度环境上 `/api/health`、`/api/sentiment?period=1y`、`/api/asset/AAPL` 三个端点均须返回 200，证明 Express 函数仍被正常构建与路由
12. **上线流程**：灰度部署 → 执行第 9、10、11 条 → promote

## 7. 风险

| 风险 | 处置 |
|---|---|
| 构建期 API 不可达 | 退出码 0 + 回退态，构建不失败（校验 7） |
| `CRON_SECRET` 未配置导致 `Bearer undefined` 绕过 | §5.3 fail-closed，缺密钥直接 401（校验 8） |
| Deploy Hook 无响应导致函数挂住、永不返回 502 | `AbortSignal.timeout(8000)` 主动超时；用「pending 直到 abort」的 stub 验证（§5.3、校验 8） |
| Deploy Hook URL 泄露 | **每日限制只约束 cron，不约束 Hook 本身**——泄露的 URL 可被直接反复请求、完全绕过 `/api/rebuild`。处置：URL 只存环境变量、发现异常立即在项目设置中轮换、关注部署次数异常 |
| 静态分档与仪表盘将来不一致 | 分档不手写，构建时从 API 取并断言（校验 2） |
| 边界值高亮错档 | 只用 API 的 `active`，不解析 range 字符串（§4.4、校验 3） |
| A股 rows 字段名不同导致取值为空 | 按 §4.3 归一化，容忍 `action` 缺失渲染 `—`（校验 6） |
| YMYL：操作提示被索引后被当作投资建议引用 | 列头写「仪表盘操作提示」，紧邻免责声明；措辞与仪表盘现有展示一致，不新增更强表述 |
| express 预设下新增 buildCommand 可能影响函数构建/路由 | **不设** `outputDirectory`（§5.4）；灰度实测三个 `/api` 端点均 200（校验 11）与静态资源可达（校验 9），通过后才 promote |
