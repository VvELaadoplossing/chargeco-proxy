// ============================================================================
//  chargeco-proxy / proxy  —  transparent OCPP-J WebSocket relay
//  Chargers connect to:  wss://proxy.chargeco.nl/v1/{deviceId}
//  Forwards EVERYTHING to PlugChoice unchanged; tees the billing-relevant
//  messages to the DATA_QUEUE. Plain Worker (not a Durable Object) on purpose.
//
//  Env:
//    PLUGCHOICE_WS  upstream base, default https://proxy.plugchoice.com
//    LOG_RAW        "true" to also tee EVERY frame to raw_log (debug only)
// ============================================================================

const CAPTURE = new Set([
  "StartTransaction",
  "StopTransaction",
  "MeterValues",
  "BootNotification",
]);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Guard: only an OCPP WebSocket upgrade on /v1/* is legitimate. Everything
    // else is internet noise hitting the public hostname — reject it instead of
    // relaying it to PlugChoice (don't be an open proxy). Fail fast, before we
    // open any upstream socket.
    const isWebSocket = request.headers.get("Upgrade") === "websocket";
    const isOcppPath  = url.pathname.startsWith("/v1/");
    if (!isWebSocket || !isOcppPath) {
      return new Response("Not found", { status: 404 });
    }

    const base = env.PLUGCHOICE_WS || "https://proxy.plugchoice.com";
    const deviceId = url.pathname.split("/").filter(Boolean).pop() || "unknown";
    const target = base + url.pathname + url.search;
    const rawOn = env.LOG_RAW === "true";

    const headers = new Headers(request.headers);
    headers.set("Host", new URL(base).host);

    const upstream = await fetch(target, { headers });
    const pcSocket = upstream.webSocket;
    if (!pcSocket) return upstream;

    const pair = new WebSocketPair();
    const [client, charger] = Object.values(pair);
    charger.accept();
    pcSocket.accept();

    const pendingStart = new Map(); // messageId -> StartTransaction payload

    charger.addEventListener("message", (e) => {
      pcSocket.send(e.data); // forward FIRST
      try { onInbound(e.data, deviceId, pendingStart, env, ctx, rawOn); } catch (_) {}
    });

    pcSocket.addEventListener("message", (e) => {
      charger.send(e.data);
      try { onOutbound(e.data, deviceId, pendingStart, env, ctx, rawOn); } catch (_) {}
    });

    // Keepalive — REQUIRED. Cloudflare drops a WebSocket after ~100s with no data
    // in either direction (Free/Pro idle timeout), so any quiet gap kills the
    // link and the charger reconnects. This is the proven mechanism from the
    // original proxy: a frame to the charger every 45s.
    const keepAlive = setInterval(() => {
      try {
        charger.send(JSON.stringify([2, "InternalPing", "Heartbeat", {}]));
      } catch (_) {
        clearInterval(keepAlive);
      }
    }, 45000);

    const closeBoth = () => {
      clearInterval(keepAlive);
      try { charger.close(); } catch (_) {}
      try { pcSocket.close(); } catch (_) {}
    };
    charger.addEventListener("close", closeBoth);
    pcSocket.addEventListener("close", closeBoth);
    charger.addEventListener("error", closeBoth);
    pcSocket.addEventListener("error", closeBoth);

    return new Response(null, { status: 101, webSocket: client });
  },
};

function onInbound(data, deviceId, pendingStart, env, ctx, rawOn) {
  if (typeof data !== "string") return;
  if (rawOn) tee(env, ctx, { kind: "raw", deviceId, direction: "in", raw: data, recvTs: new Date().toISOString() });

  if (data.indexOf("Transaction") === -1 &&
      data.indexOf("MeterValues") === -1 &&
      data.indexOf("BootNotification") === -1) return;

  const msg = JSON.parse(data);
  if (!Array.isArray(msg) || msg[0] !== 2) return;
  const [, messageId, action, payload] = msg;
  if (!CAPTURE.has(action)) return;

  if (action === "StartTransaction") {
    pendingStart.set(messageId, payload);
    if (pendingStart.size > 50) pendingStart.delete(pendingStart.keys().next().value);
    return;
  }
  tee(env, ctx, { kind: action, deviceId, payload, recvTs: new Date().toISOString() });
}

function onOutbound(data, deviceId, pendingStart, env, ctx, rawOn) {
  if (typeof data !== "string") return;
  if (rawOn) tee(env, ctx, { kind: "raw", deviceId, direction: "out", raw: data, recvTs: new Date().toISOString() });

  if (data.indexOf("transactionId") === -1) return;
  const msg = JSON.parse(data);
  if (!Array.isArray(msg) || msg[0] !== 3) return;
  const [, messageId, result] = msg;

  const startPayload = pendingStart.get(messageId);
  if (!startPayload) return;
  pendingStart.delete(messageId);

  tee(env, ctx, {
    kind: "StartTransaction",
    deviceId,
    payload: startPayload,
    result, // transactionId, idTagInfo
    recvTs: new Date().toISOString(),
  });
}

function tee(env, ctx, body) {
  ctx.waitUntil(env.DATA_QUEUE.send(body).catch(() => {}));
}
