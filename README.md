# Invest Website

Local investment dashboard clone with live market data, streaming updates, portfolio analytics, market news, and responsive layouts.

## Run

```bash
npm install
PORT=3001 npm run dev
```

Open:

```text
http://localhost:3001
```

If port `3001` is busy, choose another port:

```bash
PORT=3002 npm run dev
```

## Realtime Data

The server proxies public data sources so the browser does not depend on direct third-party CORS access.

- Stocks and ETFs: Nasdaq quote endpoint
- Crypto: CoinGecko markets endpoint
- Charts: Yahoo chart endpoint when available, with generated intraday fallback
- News: Nasdaq RSS, with MarketWatch RSS fallback
- Streaming: `/api/stream` Server-Sent Events every 15 seconds
- JSON snapshot: `/api/market`
- Single asset: `/api/asset/:symbol`
- Health check: `/api/health`

The frontend prefers SSE and falls back to polling when streaming is unavailable.
External source calls use request timeouts and cached fallbacks so one slow provider does not block the whole dashboard.

## Implemented UI

- Responsive dashboard shell with sidebar navigation
- Live market ticker tape
- Summary cards for portfolio value, top mover, breadth, and data status
- Watchlist search, filters, and sorting
- Selected asset chart and quote detail
- Selected asset holding metrics
- Portfolio positions with allocation bars
- Portfolio allocation by sector plus cash
- Market news feed
- Data source health panel

## Verify

Run the automated verification:

```bash
npm run verify
```

The verifier checks:

- `/api/market` returns live quotes, portfolio, allocations, and news
- `/api/health` reports service status, cache sizes, intervals, and configured sources
- The page renders 8 watchlist rows and 8 ticker items
- SSE transport is displayed
- Chart canvas is nonblank
- Watchlist sorting works
- Ticker click changes the selected asset
- Sidebar navigation works
- Portfolio, allocation, news, and data health sections render
- Mobile viewport has no horizontal overflow

It also writes:

```text
dashboard-desktop.png
dashboard-mobile.png
```

## Notes

The original screenshot is not available in this workspace context, so visual matching is implemented as a polished investment dashboard using the current visible requirements and realtime data behavior. Pixel-level matching can be tightened once the source screenshot is available again.
