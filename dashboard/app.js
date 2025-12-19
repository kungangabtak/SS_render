/*
  Hole Cards Dashboard (vanilla static site)
  - Multi-publisher support: tracks messages from multiple extension instances
  - Builds wss URL: ?room=...&role=sub&token=...
  - Connect/disconnect with cleanup
  - Auto-reconnect w/ exponential backoff (cap 10s)
  - Renders latest 2 cards + metadata for selected publisher
  - Keeps expandable log (max 50)
*/

const MAX_LOG = 50;
const RECONNECT_CAP_MS = 10_000;
const RECONNECT_BASE_MS = 500;
const RENDER_DEBOUNCE_MS = 100;

/** @type {WebSocket | null} */
let ws = null;
let manualDisconnect = false;
let reconnectTimer = null;
let reconnectAttempt = 0;
let lastConfigKey = "";
let lastWasAutoReconnect = false;

let configDebounceTimer = null;
let renderDebounceTimer = null;

// ============================================================
// Multi-Publisher Store
// ============================================================
// publishers[publisherId] = { lastSeen: number, playerName: string|null, latestByType: { [type]: fullMessage } }
/** @type {Record<string, { lastSeen: number, playerName: string|null, latestByType: Record<string, any> }>} */
const publishers = {};

/** Currently selected publisher ID (null = auto-select most recent) */
let selectedPublisherId = null;

// ============================================================
// DOM Elements
// ============================================================
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

  // New multi-publisher elements
  publishersList: document.getElementById("publishersList"),
  publisherCount: document.getElementById("publisherCount"),
  selectedPublisherInfo: document.getElementById("selectedPublisherInfo"),
  selectedPublisherId: document.getElementById("selectedPublisherId"),
  selectedPublisherLastSeen: document.getElementById("selectedPublisherLastSeen"),
  jsonViewer: document.getElementById("jsonViewer"),
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

/** Shorten a publisherId for display (first 8 chars) */
function shortenId(id) {
  if (!id) return "unknown";
  return String(id).substring(0, 8);
}

/** Format seconds ago from timestamp */
function formatSecondsAgo(ts) {
  if (!ts) return "—";
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 0) return "just now";
  if (seconds === 0) return "just now";
  if (seconds === 1) return "1s ago";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes === 1) return "1m ago";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours === 1) return "1h ago";
  return `${hours}h ago`;
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

// ============================================================
// Card Rendering (for selected publisher)
// ============================================================

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

// ============================================================
// Multi-Publisher Message Handling
// ============================================================

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

  // Extract publisherId (required); fall back to "unknown" if missing
  const publisherId = msg.publisherId || "unknown";
  const playerName = msg.playerName || null;
  const msgType = msg.type || "unknown";

  // Update publishers store
  if (!publishers[publisherId]) {
    publishers[publisherId] = {
      lastSeen: receivedAt,
      playerName: playerName,
      latestByType: {},
    };
  }
  publishers[publisherId].lastSeen = receivedAt;
  // Update playerName if provided (may change during session)
  if (playerName) {
    publishers[publisherId].playerName = playerName;
  }
  publishers[publisherId].latestByType[msgType] = msg;

  // For log display
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

  // Append to log with publisher info
  appendLog({
    kind: hasCards ? "message" : "info",
    time: ts != null ? Number(ts) : receivedAt,
    cardsText: hasCards ? cardsText : `[${msgType}]`,
    raw: prettyJson(msg),
    publisherId: publisherId,
  });

  // Schedule a debounced re-render
  scheduleRender();
}

// ============================================================
// Debounced Render
// ============================================================

function scheduleRender() {
  if (renderDebounceTimer) return;
  renderDebounceTimer = setTimeout(() => {
    renderDebounceTimer = null;
    renderPublishersUI();
  }, RENDER_DEBOUNCE_MS);
}

/** Get the effective selected publisher (auto-select most recent if none selected) */
function getEffectivePublisherId() {
  // If we have a valid selection, use it
  if (selectedPublisherId && publishers[selectedPublisherId]) {
    return selectedPublisherId;
  }

  // Otherwise, auto-select most recently seen publisher
  let mostRecent = null;
  let mostRecentTime = 0;
  for (const [id, pub] of Object.entries(publishers)) {
    if (pub.lastSeen > mostRecentTime) {
      mostRecentTime = pub.lastSeen;
      mostRecent = id;
    }
  }
  return mostRecent;
}

/** Render the full publishers UI and update card display */
function renderPublishersUI() {
  const pubIds = Object.keys(publishers);
  const count = pubIds.length;

  // Update count
  if (els.publisherCount) {
    els.publisherCount.textContent = count > 0 ? `(${count})` : "";
  }

  // Render publishers list
  if (els.publishersList) {
    els.publishersList.innerHTML = "";

    if (count === 0) {
      const empty = document.createElement("div");
      empty.className = "pubEmpty";
      empty.textContent = "No publishers yet. Waiting for messages...";
      els.publishersList.appendChild(empty);
    } else {
      // Sort by lastSeen descending (most recent first)
      const sorted = pubIds.sort((a, b) => publishers[b].lastSeen - publishers[a].lastSeen);

      for (const id of sorted) {
        const pub = publishers[id];
        const isSelected = getEffectivePublisherId() === id;

        const card = document.createElement("div");
        card.className = `pubCard${isSelected ? " selected" : ""}`;
        card.dataset.pubId = id;

        // Player name (if available) or Publisher ID (shortened)
        const nameSpan = document.createElement("div");
        nameSpan.className = "pubName";
        nameSpan.textContent = pub.playerName || shortenId(id);

        // Publisher ID (shortened) - shown below name if name exists
        const idSpan = document.createElement("div");
        idSpan.className = "pubId";
        idSpan.textContent = pub.playerName ? `ID: ${shortenId(id)}` : "";

        // Last seen
        const seenSpan = document.createElement("div");
        seenSpan.className = "pubLastSeen";
        seenSpan.textContent = formatSecondsAgo(pub.lastSeen);

        // Hand preview if available
        const handMsg = pub.latestByType["hand"];
        const handPreview = document.createElement("div");
        handPreview.className = "pubHandPreview";
        if (handMsg) {
          const { value1, suit1, value2, suit2, ts } = extractHandFields(handMsg);
          const hasCards = value1 && suit1 && value2 && suit2;
          if (hasCards) {
            handPreview.innerHTML = `<span class="cards">${formatTwoCards(value1, suit1, value2, suit2)}</span>`;
          } else {
            handPreview.textContent = "No cards";
          }
        } else {
          handPreview.textContent = "No hand data";
        }

        card.appendChild(nameSpan);
        if (pub.playerName) {
          card.appendChild(idSpan);
        }
        card.appendChild(seenSpan);
        card.appendChild(handPreview);

        // Click to select
        card.addEventListener("click", () => {
          selectedPublisherId = id;
          renderPublishersUI();
        });

        els.publishersList.appendChild(card);
      }
    }
  }

  // Update selected publisher info and card display
  const effectiveId = getEffectivePublisherId();

  if (effectiveId && publishers[effectiveId]) {
    const pub = publishers[effectiveId];

    // Update selected publisher info
    if (els.selectedPublisherId) {
      // Show player name with ID, or just ID if no name
      const displayText = pub.playerName 
        ? `${pub.playerName} (${shortenId(effectiveId)})`
        : shortenId(effectiveId);
      els.selectedPublisherId.textContent = displayText;
    }
    if (els.selectedPublisherLastSeen) {
      els.selectedPublisherLastSeen.textContent = formatSecondsAgo(pub.lastSeen);
    }
    if (els.selectedPublisherInfo) {
      els.selectedPublisherInfo.hidden = false;
    }

    // Render cards from hand message if available
    const handMsg = pub.latestByType["hand"];
    if (handMsg) {
      const { value1, suit1, value2, suit2, url, ts } = extractHandFields(handMsg);
      const hasCards = value1 && suit1 && value2 && suit2;
      if (hasCards) {
        renderCards(value1, suit1, value2, suit2);
        setLastUpdate(ts || pub.lastSeen);
        setTableUrl(url);
      }
    }

    // Render JSON viewer with all latestByType entries
    if (els.jsonViewer) {
      els.jsonViewer.innerHTML = "";

      const types = Object.keys(pub.latestByType).sort();
      if (types.length === 0) {
        els.jsonViewer.textContent = "No messages yet.";
      } else {
        for (const type of types) {
          const msg = pub.latestByType[type];

          const typeEntry = document.createElement("div");
          typeEntry.className = "jsonEntry";
          typeEntry.dataset.expanded = "false";

          const header = document.createElement("div");
          header.className = "jsonEntryHeader";

          const typeLabel = document.createElement("span");
          typeLabel.className = "jsonType";
          typeLabel.textContent = type;

          const tsLabel = document.createElement("span");
          tsLabel.className = "jsonTs";
          tsLabel.textContent = msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString() : "—";

          header.appendChild(typeLabel);
          header.appendChild(tsLabel);

          const content = document.createElement("pre");
          content.className = "jsonContent";
          content.textContent = prettyJson(msg);

          typeEntry.appendChild(header);
          typeEntry.appendChild(content);

          header.addEventListener("click", () => {
            typeEntry.dataset.expanded = typeEntry.dataset.expanded === "true" ? "false" : "true";
          });

          els.jsonViewer.appendChild(typeEntry);
        }
      }
    }
  } else {
    // No publisher selected
    if (els.selectedPublisherInfo) {
      els.selectedPublisherInfo.hidden = true;
    }
    renderCards("—", "", "—", "");
    setLastUpdate(null);
    setTableUrl(null);
    if (els.jsonViewer) {
      els.jsonViewer.textContent = "Select a publisher to view details.";
    }
  }
}

// ============================================================
// Log
// ============================================================

function appendLog(entry) {
  // entry: {kind, time, cardsText, raw, publisherId?}

  const row = document.createElement("div");
  row.className = `logRow${entry.kind === "error" ? " error" : ""}`;
  row.dataset.expanded = "false";

  const summary = document.createElement("div");
  summary.className = "logRowSummary";

  const left = document.createElement("div");
  left.className = "logRowLeft";

  // Publisher badge (if available)
  if (entry.publisherId) {
    const pubBadge = document.createElement("span");
    pubBadge.className = "pubBadge";
    pubBadge.textContent = shortenId(entry.publisherId);
    left.appendChild(pubBadge);
  }

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

// ============================================================
// Update "seconds ago" displays periodically
// ============================================================
setInterval(() => {
  // Only update if we have publishers and are connected
  if (Object.keys(publishers).length > 0) {
    scheduleRender();
  }
}, 5000);

// ============================================================
// Wire UI
// ============================================================
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

// ============================================================
// Initial state
// ============================================================
setStatus("disconnected");
renderCards("—", "", "—", "");
els.lastUpdate.textContent = "—";
setTableUrl(null);
renderPublishersUI();

prefillFromQueryParamsAndAutoconnect();
