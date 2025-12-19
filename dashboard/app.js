/*
  Hole Cards Dashboard (vanilla static site)
  - Multi-publisher support: tracks messages from multiple extension instances
  - Builds wss URL: ?room=...&role=sub (token optional, only if REQUIRE_SUB_TOKEN=true on hub)
  - Connect/disconnect with cleanup
  - Auto-reconnect w/ exponential backoff (cap 10s)
  - Renders latest 2 cards + metadata for selected publisher
  - Keeps expandable log (max 50)
  - Handles hub error codes: 4001 (invalid role), 4002 (invalid token), 4003 (token expired), 4004 (claim mismatch)
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

/** Track if last connection attempt used a token (for token expiry handling) */
let lastConnectionUsedToken = false;

/** Auth service configuration */
const AUTH_SERVICE_URL = "https://dom-auth.onrender.com/token";
const DEFAULT_INVITE_CODE = "91175076b507402075f4b9395476a92d"; // Default invite code

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
  inviteCodeInput: document.getElementById("inviteCodeInput"),
  autoFetchCheckbox: document.getElementById("autoFetchCheckbox"),

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
  return `${els.hubInput.value.trim()}|${extractGameId(els.gameIdInput.value)}|${els.tokenInput.value.trim()}|${els.autoFetchCheckbox?.checked}`;
}

/**
 * Auto-fetch subscriber token from dom_auth service
 * @param {string} roomId - The room/game ID
 * @param {string} inviteCode - Invite code for authentication
 * @returns {Promise<string>} JWT token
 */
async function getSubscriberToken(roomId, inviteCode) {
  appendLog({
    kind: "info",
    time: Date.now(),
    cardsText: "[auth]",
    raw: JSON.stringify({ event: "Fetching token from auth service...", roomId }, null, 2),
  });

  try {
    const response = await fetch(AUTH_SERVICE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        room: roomId,
        role: 'sub',  // Subscriber role
        inviteCode: inviteCode || DEFAULT_INVITE_CODE
      })
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Token request failed: ${response.status} - ${errorText}`);
    }
    
    const data = await response.json();
    
    if (!data.token) {
      throw new Error('No token in response');
    }

    appendLog({
      kind: "info",
      time: Date.now(),
      cardsText: "[auth]",
      raw: JSON.stringify({ 
        event: "Token fetched successfully",
        expiresIn: data.expiresIn || "unknown"
      }, null, 2),
    });

    return data.token;
  } catch (error) {
    appendLog({
      kind: "error",
      time: Date.now(),
      cardsText: "[auth error]",
      raw: JSON.stringify({ 
        event: "Failed to fetch token",
        error: error.message,
        hint: "Check invite code and auth service availability"
      }, null, 2),
    });
    throw error;
  }
}

/**
 * buildWsUrl(hub, gameId, token) -> full WS URL with role=sub
 * Hub can be base like wss://x.onrender.com or wss://x.onrender.com/
 * 
 * Produces URL format: wss://dom-hub.onrender.com/?role=sub&room=...
 * Token is optional - only added if provided (required if hub has REQUIRE_SUB_TOKEN=true)
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
  
  // Add token only if provided (optional for subscribers by default)
  const tokenValue = String(token || "").trim();
  if (tokenValue) {
    u.searchParams.set("token", tokenValue);
  }
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

async function connect(opts = {}) {
  const hub = els.hubInput.value.trim();
  const gameId = extractGameId(els.gameIdInput.value);
  let token = els.tokenInput.value.trim();
  const autoFetch = els.autoFetchCheckbox?.checked ?? false;
  const inviteCode = els.inviteCodeInput?.value?.trim() || DEFAULT_INVITE_CODE;

  // Validate required fields (hub and gameId are required; token is optional)
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

  // Auto-fetch token if enabled and no manual token provided
  if (autoFetch && !token) {
    try {
      setStatus("reconnecting"); // Show connecting status during fetch
      token = await getSubscriberToken(gameId, inviteCode);
      // Update the token input with fetched token (masked)
      els.tokenInput.value = token;
    } catch (error) {
      appendLog({
        kind: "error",
        time: Date.now(),
        cardsText: "—",
        raw: JSON.stringify({ 
          error: "Failed to auto-fetch token", 
          detail: error.message,
          hint: "Uncheck 'Auto-fetch token' to connect without token, or verify invite code"
        }, null, 2),
      });
      setStatus("disconnected");
      return;
    }
  }

  // Token is optional - subscribers don't need it by default
  // Only required if hub has REQUIRE_SUB_TOKEN=true
  
  // Track if this connection uses a token (for expiry handling)
  lastConnectionUsedToken = !!token;

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
    const urlForLog = token ? url.replace(/token=([^&]+)/, 'token=***') : url;
    appendLog({
      kind: "message",
      time: Date.now(),
      cardsText: "Connecting...",
      raw: JSON.stringify({ action: "connect", url: urlForLog, room: gameId, hasToken: !!token }, null, 2),
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
    const code = evt.code;
    const reason = evt.reason || "";

    // Handle specific hub error codes
    switch (code) {
      case 4001:
        appendLog({
          kind: "error",
          time: Date.now(),
          cardsText: "(close 4001)",
          raw: JSON.stringify({ event: "close", code, reason: "Invalid role parameter", detail: reason }, null, 2),
        });
        break;
      case 4002:
        appendLog({
          kind: "error",
          time: Date.now(),
          cardsText: "(close 4002)",
          raw: JSON.stringify({ 
            event: "close", 
            code, 
            reason: "Invalid or missing token", 
            detail: reason,
            hint: "Hub may require REQUIRE_SUB_TOKEN=true. Add a valid JWT token and retry."
          }, null, 2),
        });
        break;
      case 4003:
        // Token expired - handle based on whether we used a token and auto-fetch setting
        if (lastConnectionUsedToken) {
          const autoFetch = els.autoFetchCheckbox?.checked ?? false;
          
          if (autoFetch) {
            // Auto-fetch enabled - will fetch new token and reconnect
            appendLog({
              kind: "info",
              time: Date.now(),
              cardsText: "(close 4003)",
              raw: JSON.stringify({ 
                event: "close", 
                code, 
                reason: "Token expired", 
                detail: reason,
                action: "Auto-fetching new token and reconnecting..."
              }, null, 2),
            });
            // Clear expired token
            els.tokenInput.value = "";
            // Don't set expired state - we'll auto-reconnect with new token
          } else {
            // Manual token mode - user needs to provide new token
            appendLog({
              kind: "error",
              time: Date.now(),
              cardsText: "(close 4003)",
              raw: JSON.stringify({ 
                event: "close", 
                code, 
                reason: "Token expired", 
                detail: reason,
                action: "Please enter a new JWT token and click Connect.",
                hint: "Your token has expired. Get a new token or enable 'Auto-fetch token'."
              }, null, 2),
            });
            // Clear the expired token and highlight the field
            els.tokenInput.value = "";
            els.tokenInput.classList.add("token-expired");
            els.tokenInput.placeholder = "Token expired — enter new JWT";
            // Focus the token input to draw attention
            els.tokenInput.focus();
          }
        } else {
          appendLog({
            kind: "error",
            time: Date.now(),
            cardsText: "(close 4003)",
            raw: JSON.stringify({ 
              event: "close", 
              code, 
              reason: "Token expired (unexpected - no token was sent)", 
              detail: reason,
              hint: "Hub reported token expiry but no token was used. Will retry without token."
            }, null, 2),
          });
        }
        break;
      case 4004:
        appendLog({
          kind: "error",
          time: Date.now(),
          cardsText: "(close 4004)",
          raw: JSON.stringify({ 
            event: "close", 
            code, 
            reason: "Token claim mismatch (room/role)", 
            detail: reason,
            hint: "JWT claims don't match the requested room or role."
          }, null, 2),
        });
        break;
      default:
        if (code !== 1000) {
          appendLog({
            kind: "info",
            time: Date.now(),
            cardsText: `(close ${code})`,
            raw: JSON.stringify({ event: "close", code, reason: reason || "Connection closed" }, null, 2),
          });
        }
    }

    if (manualDisconnect) {
      setStatus("disconnected");
      return;
    }

    // Don't auto-reconnect for certain error codes
    if (code === 4001 || code === 4004) {
      // Invalid role or claim mismatch - user needs to fix config
      setStatus("disconnected");
      return;
    }

    if (code === 4002) {
      // Token required but not provided or invalid - user may need to add token
      setStatus("disconnected");
      return;
    }

    if (code === 4003) {
      // Token expired
      const autoFetch = els.autoFetchCheckbox?.checked ?? false;
      
      if (lastConnectionUsedToken) {
        if (autoFetch) {
          // Auto-fetch enabled - reconnect (will fetch new token automatically)
          setStatus("reconnecting");
          scheduleReconnect();
          return;
        } else {
          // Manual token mode - user must provide new token
          // Don't auto-reconnect as it would fail with the same expired token
          setStatus("disconnected");
          return;
        }
      } else {
        // No token was used, this is unexpected - try reconnecting without token
        setStatus("reconnecting");
        scheduleReconnect();
        return;
      }
    }

    // For other unexpected close codes, attempt reconnect
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

/**
 * Process a single message and update publishers store
 * @param {any} msg - Parsed message object
 * @param {number} receivedAt - Timestamp when message was received
 */
function processMessage(msg, receivedAt) {
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

  // Handle snapshot messages (sent by hub on initial connect)
  // Snapshot contains multiple messages keyed by type in the data object
  if (msg.type === "snapshot" && msg.data && typeof msg.data === "object") {
    appendLog({
      kind: "info",
      time: receivedAt,
      cardsText: "[snapshot]",
      raw: JSON.stringify({ 
        event: "snapshot", 
        messageCount: Object.keys(msg.data).length,
        types: Object.keys(msg.data)
      }, null, 2),
    });

    // Process each message in the snapshot
    Object.entries(msg.data).forEach(([type, subMsg]) => {
      if (subMsg && typeof subMsg === "object") {
        processMessage(subMsg, receivedAt);
      }
    });

    // Schedule a debounced re-render
    scheduleRender();
    return;
  }

  // Handle regular messages
  processMessage(msg, receivedAt);

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
            // Use textContent to prevent XSS - create span element safely
            const cardsSpan = document.createElement("span");
            cardsSpan.className = "cards";
            cardsSpan.textContent = formatTwoCards(value1, suit1, value2, suit2);
            handPreview.appendChild(cardsSpan);
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
      // Token is optional now

      lastConfigKey = key;
      manualDisconnect = false;
      safeCleanupWs();
      // If config is currently incomplete (user is editing), just stop; they can connect once complete.
      // Only hub and gameId are required; token is optional
      if (hub && gameId) {
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

    // Auto-connect if hub and gameId are provided (token is optional)
    if (hub && gameId) {
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
  // Clear token-expired state on manual connect attempt
  if (els.tokenInput.classList.contains("token-expired")) {
    els.tokenInput.classList.remove("token-expired");
    els.tokenInput.placeholder = "JWT token (if required by hub)";
  }
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

els.hubInput.addEventListener("input", () => {
  scheduleConfigReconnect();
});

els.tokenInput.addEventListener("input", () => {
  // Clear token-expired state when user starts typing a new token
  if (els.tokenInput.classList.contains("token-expired")) {
    els.tokenInput.classList.remove("token-expired");
    els.tokenInput.placeholder = "JWT token (if required by hub)";
  }
  scheduleConfigReconnect();
});

// Toggle invite code field visibility based on auto-fetch checkbox
if (els.autoFetchCheckbox) {
  els.autoFetchCheckbox.addEventListener("change", () => {
    const inviteCodeField = document.getElementById("inviteCodeField");
    if (inviteCodeField) {
      if (els.autoFetchCheckbox.checked) {
        inviteCodeField.classList.add("visible");
      } else {
        inviteCodeField.classList.remove("visible");
      }
    }
  });
}

// ============================================================
// Initial state
// ============================================================
setStatus("disconnected");
renderCards("—", "", "—", "");
els.lastUpdate.textContent = "—";
setTableUrl(null);
renderPublishersUI();

prefillFromQueryParamsAndAutoconnect();
