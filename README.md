# Market Dashboard Proxy

REST proxy server for the [Market Dashboard](https://ambermlysak.github.io/MarketDashboard/). Proxies Alpaca Market Data API for stocks, Yahoo Finance for futures and fundamentals, with aggressive SQLite caching.

## Endpoints

| Endpoint | Description | Cache TTL |
|----------|-------------|-----------|
| `GET /health` | Health check | — |
| `GET /api/quotes?symbols=SPY,QQQ` | Batch stock quotes | 5s |
| `GET /api/bars?symbol=NVDA&timeframe=1Day&limit=60` | OHLCV bars | 60s |
| `GET /api/snapshot?symbols=SPY,QQQ` | Full snapshots | 5s |
| `GET /api/fundamentals?symbol=NVDA` | PE, analyst PTs, earnings | 1h |
| `GET /api/futures` | ES, NQ, YM, CL, GC, 10Y | 30s |

## Setup

```bash
cp .env.example .env
# Edit .env with your Alpaca API keys
npm install
npm start
```

## Deployment (systemd)

```bash
systemctl --user enable market-proxy
systemctl --user start market-proxy
```

## Environment Variables

- `ALPACA_API_KEY` — Alpaca API key ID
- `ALPACA_SECRET_KEY` — Alpaca secret key
- `ALPACA_BASE_URL` — `https://data.alpaca.markets` (live) or `https://paper-api.alpaca.markets` (paper)
- `ALPACA_FEED` — `iex` (free) or `sip` (paid)
- `PORT` — Server port (default: 3010)

## Notes

- Server works without Alpaca keys (futures/fundamentals still work via Yahoo Finance)
- Stock endpoints return 503 with helpful error when keys aren't configured
- Stale cache is served when upstream fails (with `stale: true` flag)
- Rate limited to 200 requests/minute per IP
- CORS configured for `https://ambermlysak.github.io` and `localhost`
