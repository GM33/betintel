// api/_lib/wsClient.js
// BetIntel browser-side WebSocket client
// Drop this into your index.html as a <script> or import from your frontend bundle.

(function (global) {
  'use strict';

  const WS_URL = global.BETINTEL_WS_URL || 'wss://your-ws-host.example.com';
  const HEARTBEAT_INTERVAL_MS = 30000;
  const RECONNECT_BASE_MS     = 1500;
  const RECONNECT_MAX_MS      = 30000;
  const RECONNECT_JITTER_MS   = 500;

  let ws = null;
  let heartbeatTimer = null;
  let reconnectTimer = null;
  let reconnectAttempts = 0;
  let subscribedSports = new Set();
  let lastOffset = 0;
  let onSnapshotFn = null;
  let onDeltaFn    = null;
  let onStatusFn   = null;

  function getReconnectDelay() {
    const base  = Math.min(RECONNECT_BASE_MS * Math.pow(2, reconnectAttempts), RECONNECT_MAX_MS);
    const jitter = Math.random() * RECONNECT_JITTER_MS;
    return base + jitter;
  }

  function sendStatus(mode, sport, message) {
    if (typeof onStatusFn === 'function') {
      onStatusFn({ mode, sport, message, ts: new Date().toISOString() });
    }
  }

  function startHeartbeat() {
    clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  function stopHeartbeat() {
    clearInterval(heartbeatTimer);
  }

  function handleMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'snapshot') {
      if (typeof onSnapshotFn === 'function') onSnapshotFn(msg);
      sendStatus('live', msg.sport, 'Live snapshot received');
    } else if (msg.type === 'delta') {
      if (msg.offset) lastOffset = msg.offset;
      if (typeof onDeltaFn === 'function') onDeltaFn(msg);
    } else if (msg.type === 'status') {
      sendStatus(msg.mode, msg.sport, msg.message);
    } else if (msg.type === 'resync_required') {
      // Server says our offset is too stale — resubscribe to get a fresh snapshot
      resubscribeAll();
    }
  }

  function resubscribeAll() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    for (const sport of subscribedSports) {
      ws.send(JSON.stringify({ type: 'subscribe', sport, lastOffset }));
    }
  }

  function connect() {
    if (ws && ws.readyState === WebSocket.CONNECTING) return;

    ws = new WebSocket(WS_URL);

    ws.addEventListener('open', () => {
      reconnectAttempts = 0;
      startHeartbeat();
      resubscribeAll();
      sendStatus('live', null, 'WebSocket connected');
    });

    ws.addEventListener('message', (event) => handleMessage(event.data));

    ws.addEventListener('close', () => {
      stopHeartbeat();
      sendStatus('cached', null, 'WebSocket disconnected — reconnecting');
      scheduleReconnect();
    });

    ws.addEventListener('error', () => {
      stopHeartbeat();
      sendStatus('cached', null, 'WebSocket error — reconnecting');
      ws.close();
    });
  }

  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    reconnectAttempts++;
    const delay = getReconnectDelay();
    reconnectTimer = setTimeout(connect, delay);
  }

  // ---- Public API ----
  global.BetIntelOddsClient = {
    connect,

    subscribe(sport) {
      subscribedSports.add(sport);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'subscribe', sport, lastOffset }));
      }
    },

    unsubscribe(sport) {
      subscribedSports.delete(sport);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'unsubscribe', sport }));
      }
    },

    onSnapshot(fn)  { onSnapshotFn = fn; },
    onDelta(fn)     { onDeltaFn    = fn; },
    onStatus(fn)    { onStatusFn   = fn; },

    getConnectionState() {
      if (!ws) return 'disconnected';
      return ['connecting', 'open', 'closing', 'closed'][ws.readyState] || 'unknown';
    },
  };

})(window);
