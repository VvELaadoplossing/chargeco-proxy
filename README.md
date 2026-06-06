# chargeco-proxy

A transparent OCPP-J 1.6 WebSocket proxy that sits between EV chargers and
PlugChoice (the CSMS). It forwards **all** traffic in both directions unchanged,
and quietly copies the four billing-relevant message types into a queue for
storage. Chargers connect to `wss://proxy.chargeco.nl/v1/{deviceId}`.

```
 charger  <-- WebSocket -->  this proxy  <-- WebSocket -->  PlugChoice
                                  |
                                  | tee (StartTransaction, StopTransaction,
                                  v        MeterValues, BootNotification)
                            DATA_QUEUE  -->  chargeco-consumer  -->  D1
```

## What it does

- **Forwards everything, transparently.** Every frame from the charger goes to
  PlugChoice and every frame from PlugChoice goes to the charger, byte-for-byte.
  From either side's perspective nothing has changed — charging, smart-charging
  profiles, remote start/stop all behave exactly as before. The proxy is invisible.
- **Captures only what billing needs.** It tees a copy of StartTransaction,
  StopTransaction, MeterValues, and BootNotification onto a queue. Everything else
  — heartbeats, StatusNotification, and especially SetChargingProfile (which is
  ~62% of all traffic) — is forwarded but never parsed or stored.
- **Stitches the transaction id.** A StartTransaction's `transactionId` only comes
  back in PlugChoice's reply, not in the charger's original message, so the proxy
  briefly remembers the outgoing StartTransaction and matches it to the reply to
  capture that id. That id is the session key for everything downstream.

## Why it's built this way

- **Plain Worker, not a Durable Object.** A DO that held the upstream socket to
  PlugChoice could not hibernate, so it would be billed wall-clock duration for
  every connected charger around the clock — roughly $4/charger/month doing
  nothing, which is untenable at fleet scale. A plain Worker is billed on CPU and
  connection only; an idle WebSocket costs effectively nothing.
- **Forward first, capture second.** Each frame is forwarded to its destination
  *before* any inspection happens, so the proxy adds no latency to the live path.
  The capture is fire-and-forget (`ctx.waitUntil`), and the ~62% of traffic we
  don't care about fails a cheap substring check and returns immediately without
  being JSON-parsed. Longer code, but the hot path is as fast as a bare relay.
- **Capture can never break forwarding.** The inspection runs inside a try/catch,
  so a malformed frame or a queue hiccup can't interrupt the relay.
- **No app-level keep-alive.** An earlier version pinged the charger with a fake
  OCPP message; that was removed. The charger's own `WebSocketPingInterval` keeps
  the connection alive, which is cleaner and correct.

## Configuration (`wrangler.toml`)

- `PLUGCHOICE_WS` — upstream base URL. Default `https://proxy.plugchoice.com`
  (the same upstream the old `proxy.occp.nl` proxy used).
- `LOG_RAW` — `"false"` normally. Set to `"true"` only for a short debugging
  window: it tees *every* frame verbatim into the `raw_log` table (the full
  firehose, including all the SetChargingProfile traffic). Switch it back off and
  prune the table afterwards.

## How it fits

- Companion worker **chargeco-consumer** reads the queue and writes the structured
  `sessions` and `intervals` rows to the shared D1 database `chargeco`. A
  StopTransaction is split there into a session summary plus its 15-minute
  interval rows — it is not stored as a single record.
- Session energy is computed as the **sum of the interval kWh**, never
  meterStop - meterStart, because the meter register on these chargers is
  unreliable.

## Deploy (Cloudflare Workers Builds, Git-connected)

1. Push this repo to GitHub.
2. Cloudflare -> Workers & Pages -> Create -> import this repository
   (root directory = repo root, production branch = `main`).
3. The deploy applies everything from `wrangler.toml`: the `PLUGCHOICE_WS` and
   `LOG_RAW` variables, the `DATA_QUEUE` producer binding, and the
   `proxy.chargeco.nl` custom domain (the zone must be Active first).

Bindings are not set in the dashboard — `wrangler.toml` is the source of truth.
