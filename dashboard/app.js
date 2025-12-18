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
  roomInput: document.getElementById("roomInput"),
  tokenInput: document.getElementById("tokenInput"),

  connectBtn: document.getElementById("connectBtn"),
  disconnectBtn: document.getElementById("disconnectBtn"),
  clearLogBtn: document.getElementById("clearLogBtn"),

  statusDot: document.getElementById("statusDot"),
  statusText: document.getElementById("statusText"),

  card1: document.getElementById("card1"),
  card1Value: document.getElementById("card1Value"),
  card1Suit: document.getElementById("card1Suit"),
  card2: document.getElementById("card2"),
  card2Value: document.getElementById("card2Value"),
  card2Suit: document.getElementById("card2Suit"),

  lastUpdate: document.getElementById("lastUpdate"),
  tableUrlLink: document.getElementById("tableUrlLink"),

  wsUrlPreview: document.getElementById("wsUrlPreview"),

  log: document.getElementById("log"),
};

function nowIsoish() {
  return new Date().toLocaleString();
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
  if (els.statusDot) els.statusDot.dataset.status = status;
  els.statusText.textContent = status;

  const isConnected = status === "connected";
  const isConnecting = status === "reconnecting";

  els.connectBtn.disabled = isConnected || isConnecting;
  els.disconnectBtn.disabled = !(isConnected || isConnecting);
}

function updateWsUrlPreview() {
  if (!els.wsUrlPreview) return;
  const hub = els.hubInput.value.trim();
  const room = els.roomInput.value.trim();
  const token = els.tokenInput.value.trim();

  if (!hub || !room || !token) {
    els.wsUrlPreview.textContent = "—";
    return;
  }

  try {
    els.wsUrlPreview.textContent = buildWsUrl(hub, room, token);
  } catch {
    els.wsUrlPreview.textContent = "—";
  }
}

function updateQueryStringFromInputs() {
  try {
    const url = new URL(window.location.href);
    const hub = els.hubInput.value.trim();
    const room = els.roomInput.value.trim();
    const token = els.tokenInput.value.trim();

    if (hub) url.searchParams.set("hub", hub);
    else url.searchParams.delete("hub");

    if (room) url.searchParams.set("room", room);
    else url.searchParams.delete("room");

    if (token) url.searchParams.set("token", token);
    else url.searchParams.delete("token");

    window.history.replaceState({}, "", url.toString());
  } catch {
    // ignore
  }
}

function currentConfigKey() {
  return `${els.hubInput.value.trim()}|${els.roomInput.value.trim()}|${els.tokenInput.value.trim()}`;
}

/**
 * buildWsUrl(hub, room, token) -> full WS URL with role=sub
 * Hub can be base like wss://x.onrender.com or wss://x.onrender.com/
 */
function buildWsUrl(hub, room, token) {
  let hubStr = String(hub || "").trim();
  if (!hubStr) throw new Error("Missing hub");

  // If user pasted host without scheme, default to wss://
  if (!/^wss?:\/\//i.test(hubStr)) {
    hubStr = `wss://${hubStr}`;
  }

  const u = new URL(hubStr);
  u.searchParams.set("room", String(room || "").trim());
  u.searchParams.set("role", "sub");
  u.searchParams.set("token", String(token || "").trim());
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
  const { isAuto = false } = opts;

  const hub = els.hubInput.value.trim();
  const room = els.roomInput.value.trim();
  const token = els.tokenInput.value.trim();

  if (!hub || !room || !token) {
    appendLog({
      kind: "error",
      time: Date.now(),
      cardsText: "—",
      raw: JSON.stringify({ error: "Missing hub/room/token" }, null, 2),
    });
    setStatus("disconnected");
    return;
  }

  // If a reconnect was scheduled under a previous config, cancel it; this connect() call supersedes it.
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  const configKey = currentConfigKey();
  lastConfigKey = configKey;
  updateQueryStringFromInputs();
  updateWsUrlPreview();

  manualDisconnect = false;

  // ensure any existing socket is gone
  safeCleanupWs();

  let url;
  try {
    url = buildWsUrl(hub, room, token);
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

    appendLog({
      kind: "info",
      time: Date.now(),
      cardsText: "(connected)",
      raw: JSON.stringify({ event: "open", url }, null, 2),
    });
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
      appendLog({
        kind: "info",
        time: Date.now(),
        cardsText: "(disconnected)",
        raw: JSON.stringify(
          { event: "close", code: evt && evt.code, reason: evt && evt.reason, wasClean: evt && evt.wasClean },
          null,
          2
        ),
      });
      return;
    }

    setStatus("reconnecting");
    appendLog({
      kind: "info",
      time: Date.now(),
      cardsText: "(reconnecting)",
      raw: JSON.stringify(
        { event: "close", code: evt && evt.code, reason: evt && evt.reason, wasClean: evt && evt.wasClean },
        null,
        2
      ),
    });

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
  els.card1.classList.remove("cardTile--placeholder", "cardTile--red", "cardTile--black");
  els.card1.classList.add(suitColor(suit1) === "red" ? "cardTile--red" : "cardTile--black");

  els.card2Value.textContent = v2;
  els.card2Suit.textContent = s2;
  els.card2.classList.remove("cardTile--placeholder", "cardTile--red", "cardTile--black");
  els.card2.classList.add(suitColor(suit2) === "red" ? "cardTile--red" : "cardTile--black");
}

function setLastUpdate(ts) {
  if (!ts || Number.isNaN(Number(ts))) {
    els.lastUpdate.textContent = "—";
    return;
  }
  els.lastUpdate.textContent = new Date(Number(ts)).toLocaleString();
}

function setTableUrl(url) {
  if (!els.tableUrlLink) return;
  if (!url) {
    els.tableUrlLink.textContent = "—";
    els.tableUrlLink.href = "#";
    els.tableUrlLink.removeAttribute("target");
    els.tableUrlLink.removeAttribute("rel");
    return;
  }

  els.tableUrlLink.textContent = url;
  els.tableUrlLink.href = url;
  els.tableUrlLink.setAttribute("target", "_blank");
  els.tableUrlLink.setAttribute("rel", "noreferrer");
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

  // Update main UI even if message isn't type=hand, as long as it has the fields.
  renderCards(value1, suit1, value2, suit2);
  setLastUpdate(ts != null ? ts : receivedAt);
  setTableUrl(url);

  appendLog({
    kind: "message",
    time: ts != null ? Number(ts) : receivedAt,
    cardsText,
    raw: prettyJson(msg),
  });
}

function appendLog(entry) {
  // entry: {kind, time, cardsText, raw}

  const row = document.createElement("div");
  row.className = `logRow${entry.kind === "error" ? " logRow--error" : ""}`;

  const summary = document.createElement("div");
  summary.className = "logRow__summary";

  const timeEl = document.createElement("div");
  timeEl.className = "logRow__time mono";
  timeEl.textContent = new Date(entry.time || Date.now()).toLocaleTimeString();

  const cardsEl = document.createElement("div");
  cardsEl.className = "logRow__cards";

  // Expect "V♠ V♥" style; fall back to full text.
  const parts = String(entry.cardsText || "").split(" ").filter(Boolean);
  const pill1 = document.createElement("span");
  pill1.className = `pill ${/♥|♦/.test(parts[0] || entry.cardsText) ? "pill--red" : "pill--black"}`;
  pill1.textContent = parts[0] || String(entry.cardsText || "—");
  cardsEl.appendChild(pill1);

  if (parts.length >= 2) {
    const pill2 = document.createElement("span");
    pill2.className = `pill ${/♥|♦/.test(parts[1]) ? "pill--red" : "pill--black"}`;
    pill2.textContent = parts[1];
    cardsEl.appendChild(pill2);
  }

  const typeEl = document.createElement("div");
  typeEl.className = "logRow__type mono";
  typeEl.textContent = entry.kind === "message" ? "msg" : entry.kind;

  summary.appendChild(timeEl);
  summary.appendChild(cardsEl);
  summary.appendChild(typeEl);

  const details = document.createElement("div");
  details.className = "logRow__details";

  const pre = document.createElement("pre");
  pre.className = "logRow__pre mono";
  pre.textContent = entry.raw || "";

  details.appendChild(pre);

  row.appendChild(summary);
  row.appendChild(details);

  summary.addEventListener("click", () => {
    row.classList.toggle("logRow--open");
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
    updateWsUrlPreview();

    // If we're connected (or trying), and config changed, reconnect cleanly.
    const isActive = ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING);
    const isPendingReconnect = Boolean(reconnectTimer);

    if ((isActive || isPendingReconnect) && key !== lastConfigKey) {
      lastConfigKey = key;
      manualDisconnect = false;
      safeCleanupWs();
      connect({ isAuto: true });
    } else {
      lastConfigKey = key;
    }
  }, 250);
}

function prefillFromQueryParamsAndAutoconnect() {
  try {
    const u = new URL(window.location.href);
    const hub = u.searchParams.get("hub");
    const room = u.searchParams.get("room");
    const token = u.searchParams.get("token");

    if (hub) els.hubInput.value = hub;
    if (room) els.roomInput.value = room;
    if (token) els.tokenInput.value = token;

    lastConfigKey = currentConfigKey();
    updateWsUrlPreview();

    if (hub && room && token) {
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

[els.hubInput, els.roomInput, els.tokenInput].forEach((input) => {
  input.addEventListener("input", () => {
    scheduleConfigReconnect();
  });
});

// Initial state
setStatus("disconnected");
renderCards("—", "", "—", "");
els.lastUpdate.textContent = "—";
setTableUrl(null);
updateWsUrlPreview();

appendLog({
  kind: "info",
  time: Date.now(),
  cardsText: "(ready)",
  raw: JSON.stringify({ event: "ready", time: nowIsoish() }, null, 2),
});

prefillFromQueryParamsAndAutoconnect();
