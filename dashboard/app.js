/*
  Hole Cards Dashboard (vanilla static site)
  - Builds wss URL: ?room=...&role=sub&token=...
  - Connect/disconnect with cleanup
  - Auto-reconnect w/ exponential backoff (cap 10s)
  - Renders latest 2 cards + metadata
  - Keeps expandable log (max 50)
*/

const MAX_LOG = 50;
const RECONNECT_CAP_MS = 10_000;
const RECONNECT_BASE_MS = 500;

/** @type {WebSocket | null} */
let ws = null;
let manualDisconnect = false;
let reconnectTimer = null;
let reconnectAttempt = 0;
let lastConfigKey = "";
let lastWasAutoReconnect = false;

let configDebounceTimer = null;

const els = {
  hubInput: document.getElementById("hubInput"),
  gameIdInput: document.getElementById("gameIdInput"),
  tokenInput: document.getElementById("tokenInput"),

  connectBtn: document.getElementById("connectBtn"),
  disconnectBtn: document.getElementById("disconnectBtn"),
  clearLogBtn: document.getElementById("clearLogBtn"),

  statusBadge: document.getElementById("statusBadge"),
  statusText: document.getElementById("statusText"),

  card1: document.getElementById("card1"),
  card1Value: document.getElementById("card1Value"),
  card1Suit: document.getElementById("card1Suit"),
  card2: document.getElementById("card2"),
  card2Value: document.getElementById("card2Value"),
  card2Suit: document.getElementById("card2Suit"),

  lastUpdate: document.getElementById("lastUpdate"),
  tableUrlRow: document.getElementById("tableUrlRow"),
  tableUrl: document.getElementById("tableUrl"),

  log: document.getElementById("log"),
};

/**
 * Extract game ID from PokerNow URL or return the raw input
 * Accepts: https://www.pokernow.club/games/pglQ2HgWGgYbDUSq7f9moVbXR
 * Returns: pglQ2HgWGgYbDUSq7f9moVbXR
 */
function extractGameId(input) {
  const s = String(input || "").trim();
  if (!s) return "";

  // Try to extract from URL pattern
  const match = s.match(/\/games\/([a-zA-Z0-9_-]+)/);
  if (match && match[1]) {
    return match[1];
  }

  // Otherwise return as-is (assuming it's already just the ID)
  return s;
}

function normalizeValue(v) {
  if (v == null) return "—";
  const s = String(v).trim().toUpperCase();
  if (s === "10") return "10"; // consistent choice: show 10 as "10"
  if (s.length === 0) return "—";
  return s;
}

function suitSymbol(suit) {
  const s = String(suit || "").trim().toLowerCase();
  if (s === "h") return "♥";
  if (s === "d") return "♦";
  if (s === "c") return "♣";
  if (s === "s") return "♠";
  return "?";
}

function suitColor(suit) {
  const s = String(suit || "").trim().toLowerCase();
  if (s === "h" || s === "d") return "red";
  if (s === "c" || s === "s") return "black";
  return "black";
}

function formatTwoCards(value1, suit1, value2, suit2) {
  const v1 = normalizeValue(value1);
  const v2 = normalizeValue(value2);
  const s1 = suitSymbol(suit1);
  const s2 = suitSymbol(suit2);
  return `${v1}${s1} ${v2}${s2}`;
}

function setStatus(status) {
  // status: connected | disconnected | reconnecting
  els.statusBadge.dataset.status = status;
  els.statusText.textContent = status;

  const isConnected = status === "connected";
  const isConnecting = status === "reconnecting";

  els.connectBtn.disabled = isConnected || isConnecting;
  els.disconnectBtn.disabled = !(isConnected || isConnecting);
}

function updateQueryStringFromInputs() {
  try {
    const url = new URL(window.location.href);
    const hub = els.hubInput.value.trim();
    const gameId = extractGameId(els.gameIdInput.value);
    const token = els.tokenInput.value.trim();

    if (hub) url.searchParams.set("hub", hub);
    else url.searchParams.delete("hub");

    if (gameId) url.searchParams.set("gameId", gameId);
    else url.searchParams.delete("gameId");

    if (token) url.searchParams.set("token", token);
    else url.searchParams.delete("token");

    window.history.replaceState({}, "", url.toString());
  } catch {
    // ignore
  }
}

function currentConfigKey() {
  return `${els.hubInput.value.trim()}|${extractGameId(els.gameIdInput.value)}|${els.tokenInput.value.trim()}`;
}

/**
 * buildWsUrl(hub, gameId, token) -> full WS URL with role=sub
 * Hub can be base like wss://x.onrender.com or wss://x.onrender.com/
 * 
 * Produces URL format: wss://dom-hub.onrender.com/?role=sub&room=...&token=ACTUAL_TOKEN_VALUE
 * Note: Uses 'room' parameter (not 'gameId') to match server expectations
 */
function buildWsUrl(hub, gameId, token) {
  let hubStr = String(hub || "").trim();
  if (!hubStr) throw new Error("Missing hub");

  // If user pasted host without scheme, default to wss://
  if (!/^wss?:\/\//i.test(hubStr)) {
    hubStr = `wss://${hubStr}`;
  }

  const u = new URL(hubStr);
  u.searchParams.set("role", "sub");
  
  // Add room parameter (maps from gameId - this is what the server expects)
  const room = String(gameId || "").trim();
  if (!room) {
    throw new Error("Missing room/gameId");
  }
  u.searchParams.set("room", room);
  
  // Add token (required for authentication) - validate it's not empty
  const tokenValue = String(token || "").trim();
  if (!tokenValue) {
    throw new Error("Missing or empty token");
  }
  u.searchParams.set("token", tokenValue);
  return u.toString();
}

function safeCleanupWs() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  if (!ws) return;

  try {
    ws.onopen = null;
    ws.onmessage = null;
    ws.onerror = null;
    ws.onclose = null;
  } catch {
    // ignore
  }

  try {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close(1000, "client disconnect");
    }
  } catch {
    // ignore
  }

  ws = null;
}

function disconnect() {
  manualDisconnect = true;
  lastWasAutoReconnect = false;
  safeCleanupWs();
  setStatus("disconnected");
}

function scheduleReconnect() {
  if (manualDisconnect) return;
  if (reconnectTimer) return;

  const delay = Math.min(RECONNECT_CAP_MS, RECONNECT_BASE_MS * Math.pow(2, reconnectAttempt));
  reconnectAttempt += 1;
  lastWasAutoReconnect = true;

  setStatus("reconnecting");
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect({ isAuto: true });
  }, delay);
}

function connect(opts = {}) {
  const hub = els.hubInput.value.trim();
  const gameId = extractGameId(els.gameIdInput.value);
  const token = els.tokenInput.value.trim();

  // Validate all required fields are present and non-empty
  if (!hub) {
    appendLog({
      kind: "error",
      time: Date.now(),
      cardsText: "—",
      raw: JSON.stringify({ error: "Missing hub URL" }, null, 2),
    });
    setStatus("disconnected");
    return;
  }

  if (!gameId) {
    appendLog({
      kind: "error",
      time: Date.now(),
      cardsText: "—",
      raw: JSON.stringify({ error: "Missing gameId/room" }, null, 2),
    });
    setStatus("disconnected");
    return;
  }

  if (!token) {
    appendLog({
      kind: "error",
      time: Date.now(),
      cardsText: "—",
      raw: JSON.stringify({ error: "Missing or empty token - ensure token matches HUB_TOKEN from Render" }, null, 2),
    });
    setStatus("disconnected");
    return;
  }

  const configKey = currentConfigKey();
  lastConfigKey = configKey;
  updateQueryStringFromInputs();

  manualDisconnect = false;

  // ensure any existing socket is gone
  safeCleanupWs();

  let url;
  try {
    url = buildWsUrl(hub, gameId, token);
    // Log the constructed URL for debugging (without exposing full token)
    const urlForLog = url.replace(/token=([^&]+)/, 'token=***');
    appendLog({
      kind: "message",
      time: Date.now(),
      cardsText: "Connecting...",
      raw: JSON.stringify({ action: "connect", url: urlForLog, room: gameId }, null, 2),
    });
  } catch (e) {
    appendLog({
      kind: "error",
      time: Date.now(),
      cardsText: "—",
      raw: JSON.stringify({ error: String(e && e.message ? e.message : e) }, null, 2),
    });
    setStatus("disconnected");
    return;
  }

  try {
    ws = new WebSocket(url);
  } catch (e) {
    appendLog({
      kind: "error",
      time: Date.now(),
      cardsText: "—",
      raw: JSON.stringify({ error: "Failed to create WebSocket", detail: String(e) }, null, 2),
    });
    setStatus("disconnected");
    scheduleReconnect();
    return;
  }

  setStatus("reconnecting");

  ws.onopen = () => {
    reconnectAttempt = 0;
    setStatus("connected");
  };

  ws.onmessage = (evt) => {
    handleIncomingMessage(evt && evt.data);
  };

  ws.onerror = () => {
    // Most browsers don't give useful error details.
    appendLog({
      kind: "error",
      time: Date.now(),
      cardsText: "(ws error)",
      raw: JSON.stringify({ event: "error" }, null, 2),
    });
  };

  ws.onclose = (evt) => {
    ws = null;

    if (manualDisconnect) {
      setStatus("disconnected");
      return;
    }

    setStatus("reconnecting");

    scheduleReconnect();
  };
}

function renderCards(value1, suit1, value2, suit2) {
  const v1 = normalizeValue(value1);
  const v2 = normalizeValue(value2);
  const s1 = suitSymbol(suit1);
  const s2 = suitSymbol(suit2);

  els.card1Value.textContent = v1;
  els.card1Suit.textContent = s1;
  els.card1.dataset.color = suitColor(suit1);

  els.card2Value.textContent = v2;
  els.card2Suit.textContent = s2;
  els.card2.dataset.color = suitColor(suit2);
}

function setLastUpdate(ts) {
  if (!ts || Number.isNaN(Number(ts))) {
    els.lastUpdate.textContent = "—";
    return;
  }
  els.lastUpdate.textContent = new Date(Number(ts)).toLocaleString();
}

function setTableUrl(url) {
  if (!url) {
    els.tableUrlRow.hidden = true;
    els.tableUrl.textContent = "—";
    els.tableUrl.href = "#";
    return;
  }

  els.tableUrlRow.hidden = false;
  els.tableUrl.textContent = url;
  els.tableUrl.href = url;
}

function prettyJson(objOrStr) {
  if (typeof objOrStr === "string") return objOrStr;
  try {
    return JSON.stringify(objOrStr, null, 2);
  } catch {
    return String(objOrStr);
  }
}

function extractHandFields(msg) {
  const data = (msg && msg.data) || {};
  return {
    value1: data.value1,
    suit1: data.suit1,
    value2: data.value2,
    suit2: data.suit2,
    url: data.url,
    ts: data.timestamp != null ? data.timestamp : msg && msg.timestamp,
  };
}

function handleIncomingMessage(raw) {
  const receivedAt = Date.now();

  if (typeof raw !== "string") {
    appendLog({
      kind: "error",
      time: receivedAt,
      cardsText: "—",
      raw: JSON.stringify({ error: "Non-text WS message", receivedType: typeof raw }, null, 2),
    });
    return;
  }

  /** @type {any} */
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch (e) {
    appendLog({
      kind: "error",
      time: receivedAt,
      cardsText: "(parse error)",
      raw: JSON.stringify({ error: "JSON parse failed", detail: String(e), payload: raw }, null, 2),
    });
    return;
  }

  const { value1, suit1, value2, suit2, url, ts } = extractHandFields(msg);
  const cardsText = formatTwoCards(value1, suit1, value2, suit2);
  const hasCards =
    value1 != null &&
    suit1 != null &&
    value2 != null &&
    suit2 != null &&
    String(value1).trim() !== "" &&
    String(suit1).trim() !== "" &&
    String(value2).trim() !== "" &&
    String(suit2).trim() !== "";

  // Only update the main UI when we have both cards, so other message types don't wipe the display.
  if (hasCards) {
    renderCards(value1, suit1, value2, suit2);
    setLastUpdate(ts != null ? ts : receivedAt);
    setTableUrl(url);
  }

  appendLog({
    kind: hasCards ? "message" : "error",
    time: ts != null ? Number(ts) : receivedAt,
    cardsText: hasCards ? cardsText : "(missing cards)",
    raw: prettyJson(msg),
  });
}

function appendLog(entry) {
  // entry: {kind, time, cardsText, raw}

  const row = document.createElement("div");
  row.className = `logRow${entry.kind === "error" ? " error" : ""}`;
  row.dataset.expanded = "false";

  const summary = document.createElement("div");
  summary.className = "logRowSummary";

  const left = document.createElement("div");

  const badge = document.createElement("div");
  badge.className = `badge ${/♥|♦/.test(entry.cardsText) ? "red" : "black"}`;

  const cardsSpan = document.createElement("span");
  cardsSpan.textContent = entry.cardsText;

  badge.appendChild(cardsSpan);
  left.appendChild(badge);

  const right = document.createElement("div");
  right.className = "rowMeta";
  right.textContent = new Date(entry.time || Date.now()).toLocaleTimeString();

  summary.appendChild(left);
  summary.appendChild(right);

  const details = document.createElement("div");
  details.className = "logRowDetails";

  const pre = document.createElement("pre");
  pre.textContent = entry.raw || "";
  details.appendChild(pre);

  row.appendChild(summary);
  row.appendChild(details);

  row.addEventListener("click", () => {
    row.dataset.expanded = row.dataset.expanded === "true" ? "false" : "true";
  });

  const nearBottom = els.log.scrollTop + els.log.clientHeight >= els.log.scrollHeight - 40;

  els.log.appendChild(row);

  // Trim to MAX_LOG
  while (els.log.childElementCount > MAX_LOG) {
    els.log.removeChild(els.log.firstElementChild);
  }

  // Keep scrolled to bottom when new entries arrive (but only if user is already near bottom)
  if (nearBottom) {
    els.log.scrollTop = els.log.scrollHeight;
  }
}

function clearLog() {
  els.log.innerHTML = "";
}

function scheduleConfigReconnect() {
  if (configDebounceTimer) clearTimeout(configDebounceTimer);
  configDebounceTimer = setTimeout(() => {
    configDebounceTimer = null;

    const key = currentConfigKey();
    updateQueryStringFromInputs();

    // If we're connected (or trying), and config changed, reconnect cleanly.
    const isActive = ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING);
    const isPendingReconnect = Boolean(reconnectTimer);

    if ((isActive || isPendingReconnect) && key !== lastConfigKey) {
      const hub = els.hubInput.value.trim();
      const gameId = extractGameId(els.gameIdInput.value);
      const token = els.tokenInput.value.trim();

      lastConfigKey = key;
      manualDisconnect = false;
      safeCleanupWs();
      // If config is currently incomplete (user is editing), just stop; they can connect once complete.
      if (hub && gameId && token) {
        connect({ isAuto: true });
      } else {
        setStatus("disconnected");
      }
    } else {
      lastConfigKey = key;
    }
  }, 250);
}

function prefillFromQueryParamsAndAutoconnect() {
  try {
    const u = new URL(window.location.href);
    const hub = u.searchParams.get("hub");
    const gameId = u.searchParams.get("gameId");
    const token = u.searchParams.get("token");

    if (hub) els.hubInput.value = hub;
    if (gameId) els.gameIdInput.value = gameId;
    if (token) els.tokenInput.value = token;

    lastConfigKey = currentConfigKey();

    if (hub && gameId && token) {
      connect({ isAuto: true });
    }
  } catch {
    // ignore
  }
}

// Wire UI
els.connectBtn.addEventListener("click", () => {
  lastWasAutoReconnect = false;
  connect({ isAuto: false });
});

els.disconnectBtn.addEventListener("click", () => {
  disconnect();
});

els.clearLogBtn.addEventListener("click", () => {
  clearLog();
});

// Auto-extract game ID from PokerNow URLs on paste/input
els.gameIdInput.addEventListener("input", () => {
  const extracted = extractGameId(els.gameIdInput.value);
  if (extracted !== els.gameIdInput.value) {
    els.gameIdInput.value = extracted;
  }
  scheduleConfigReconnect();
});

[els.hubInput, els.tokenInput].forEach((input) => {
  input.addEventListener("input", () => {
    scheduleConfigReconnect();
  });
});

// Initial state
setStatus("disconnected");
renderCards("—", "", "—", "");
els.lastUpdate.textContent = "—";
setTableUrl(null);

prefillFromQueryParamsAndAutoconnect();

