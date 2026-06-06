# chargeco-proxy

Transparent OCPP-J WebSocket relay for chargeco.nl. Chargers connect to
`wss://proxy.chargeco.nl/v1/{deviceId}`; everything is forwarded to PlugChoice
unchanged, and the billing-relevant messages are teed to the `chargeco-data`
queue (consumed by the separate `chargeco-consumer` worker).

```
chargeco-proxy/
├── wrangler.toml     # bindings (authoritative for Git deploys)
└── src/index.js      # the worker
```

## Deploy (Cloudflare Workers Builds, Git-connected)
1. Push this repo to GitHub.
2. Cloudflare → Workers & Pages → Create → import this repository.
   Root directory: repo root (default). Production branch: `main`.
3. The deploy applies everything from `wrangler.toml`:
   - Variables `PLUGCHOICE_WS` and `LOG_RAW`
   - Queue producer `DATA_QUEUE` → `chargeco-data`
   - Custom domain `proxy.chargeco.nl` (the zone must be Active first)

No bindings are set in the dashboard — `wrangler.toml` is the source of truth.
Flip `LOG_RAW` to `true` only for short debugging windows.
