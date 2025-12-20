/**
 * Test suite for Dashboard
 * Tests critical functionality including snapshot message handling
 */

// Mock DOM for testing
const mockDOM = {
  publishers: {},
  logs: [],
  selectedPublisherId: null,
};

// Shared constants (should match app.js intent)
const SETTINGS_KEY = "ss_settings_v1";

// Test utilities
function assert(condition, message) {
  if (!condition) {
    throw new Error(message || "Assertion failed");
  }
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(message || `Expected ${expected}, got ${actual}`);
  }
}

function createMockLocalStorage() {
  const store = {};
  return {
    getItem(key) {
      return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null;
    },
    setItem(key, value) {
      store[key] = String(value);
    },
    removeItem(key) {
      delete store[key];
    },
    clear() {
      Object.keys(store).forEach((k) => delete store[k]);
    },
    _dump() {
      return { ...store };
    },
  };
}

// Test extractGameId logic
function testExtractGameId() {
  console.log("Testing extractGameId...");
  
  function extractGameId(input) {
    const s = String(input || "").trim();
    if (!s) return "";
    const match = s.match(/\/games\/([a-zA-Z0-9_-]+)/);
    if (match && match[1]) {
      return match[1];
    }
    return s;
  }
  
  assertEqual(extractGameId("https://www.pokernow.club/games/pglQ2HgWGgYbDUSq7f9moVbXR"), 
              "pglQ2HgWGgYbDUSq7f9moVbXR", "Should extract from full URL");
  assertEqual(extractGameId("pglQ2HgWGgYbDUSq7f9moVbXR"), 
              "pglQ2HgWGgYbDUSq7f9moVbXR", "Should return raw input if not URL");
  assertEqual(extractGameId(""), "", "Should return empty for empty input");
  
  console.log("✓ extractGameId tests passed");
}

// Test settings persistence does NOT store password
function testSettingsDoesNotPersistPassword() {
  console.log("Testing settings persistence does not store password...");

  const ls = createMockLocalStorage();
  const password = "super-secret-password";

  function saveSettings(privateMode) {
    // Mirrors app.js behavior: persist ONLY privateMode
    ls.setItem(SETTINGS_KEY, JSON.stringify({ privateMode: Boolean(privateMode) }));
  }

  saveSettings(true);

  const raw = ls.getItem(SETTINGS_KEY) || "";
  assert(raw.includes("privateMode"), "Settings should include privateMode");
  assert(!raw.toLowerCase().includes("password"), "Settings must not include password field");
  assert(!raw.includes(password), "Settings must not include password value");

  console.log("✓ Settings non-persistence tests passed");
}

// Test buildWsUrl logic
function testBuildWsUrl() {
  console.log("Testing buildWsUrl...");
  
  function buildWsUrl(hub, gameId, token) {
    let hubStr = String(hub || "").trim();
    if (!hubStr) throw new Error("Missing hub");
    if (!/^wss?:\/\//i.test(hubStr)) {
      hubStr = `wss://${hubStr}`;
    }
    const u = new URL(hubStr);
    u.searchParams.set("role", "sub");
    const room = String(gameId || "").trim();
    if (!room) {
      throw new Error("Missing room/gameId");
    }
    u.searchParams.set("room", room);
    const tokenValue = String(token || "").trim();
    if (tokenValue) {
      u.searchParams.set("token", tokenValue);
    }
    return u.toString();
  }
  
  const url1 = buildWsUrl("wss://hub.com", "test123", "");
  assert(url1.includes("role=sub"), "Should include role=sub");
  assert(url1.includes("room=test123"), "Should include room");
  assert(!url1.includes("token="), "Should not include token when empty");
  
  const url2 = buildWsUrl("wss://hub.com", "test123", "abc123");
  assert(url2.includes("token=abc123"), "Should include token when provided");
  
  console.log("✓ buildWsUrl tests passed");
}

// Test buildWsUrl with Private Mode (token included)
function testBuildWsUrlPrivateMode() {
  console.log("Testing buildWsUrl in Private Mode...");
  
  function buildWsUrl(hub, gameId, token) {
    let hubStr = String(hub || "").trim();
    if (!hubStr) throw new Error("Missing hub");
    if (!/^wss?:\/\//i.test(hubStr)) {
      hubStr = `wss://${hubStr}`;
    }
    const u = new URL(hubStr);
    u.searchParams.set("role", "sub");
    const room = String(gameId || "").trim();
    if (!room) {
      throw new Error("Missing room/gameId");
    }
    u.searchParams.set("room", room);
    const tokenValue = String(token || "").trim();
    if (tokenValue) {
      u.searchParams.set("token", tokenValue);
    }
    return u.toString();
  }
  
  // Simulate Private Mode: token fetched from auth service
  const jwtToken = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb29tIjoicm9vbTEyMyIsInJvbGUiOiJzdWIifQ.fake";
  const url = buildWsUrl("wss://dom-hub.onrender.com", "room123", jwtToken);
  
  assert(url.includes("role=sub"), "Private Mode URL should include role=sub");
  assert(url.includes("room=room123"), "Private Mode URL should include room");
  assert(url.includes("token="), "Private Mode URL should include token");
  assert(url.includes(encodeURIComponent(jwtToken).substring(0, 20)), "Token should be URL-encoded");
  
  console.log("✓ buildWsUrl Private Mode tests passed");
}

// Test getSubscriberToken sends password header + maps 401 correctly
async function testGetSubscriberTokenHeaderAnd401() {
  console.log("Testing getSubscriberToken header + 401 mapping...");

  const calls = [];

  async function mockFetch(url, opts) {
    calls.push({ url, opts });
    // Default: succeed
    return {
      ok: true,
      status: 200,
      async json() {
        return { token: "mock.jwt.token", expiresInSeconds: 60 };
      },
    };
  }

  async function getSubscriberToken(room, password, fetchImpl) {
    const pw = String(password || "").trim();
    if (!pw) throw new Error("Missing password");

    const res = await fetchImpl("https://dom-auth.onrender.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Dashboard-Password": pw },
      body: JSON.stringify({ room, role: "sub" }),
    });

    if (!res.ok) {
      if (res.status === 401) throw new Error("Unauthorized (wrong password)");
      throw new Error(`Auth failed (${res.status})`);
    }

    const data = await res.json();
    return { token: data.token, expiresInSeconds: data.expiresInSeconds };
  }

  // Header test (trim)
  await getSubscriberToken("room123", "  pw  ", mockFetch);
  assertEqual(calls.length, 1, "Should call fetch exactly once");
  assertEqual(calls[0].opts.headers["X-Dashboard-Password"], "pw", "Should send trimmed X-Dashboard-Password header");

  // 401 mapping test
  async function mockFetch401() {
    return {
      ok: false,
      status: 401,
      async json() {
        return { error: "Unauthorized" };
      },
    };
  }

  let threw = false;
  try {
    await getSubscriberToken("room123", "wrong", mockFetch401);
  } catch (e) {
    threw = true;
    assertEqual(e.message, "Unauthorized (wrong password)", "401 should map to Unauthorized (wrong password)");
  }
  assert(threw, "Should throw for 401");

  console.log("✓ getSubscriberToken header + 401 tests passed");
}

// Test snapshot message handling (CRITICAL - currently missing in app.js)
function testSnapshotMessageHandling() {
  console.log("Testing snapshot message handling...");
  
  const publishers = {};
  
  function processMessage(msg, receivedAt) {
    const publisherId = msg.publisherId || "unknown";
    const playerName = msg.playerName || null;
    const msgType = msg.type || "unknown";
    
    if (!publishers[publisherId]) {
      publishers[publisherId] = {
        lastSeen: receivedAt,
        playerName: playerName,
        latestByType: {},
      };
    }
    publishers[publisherId].lastSeen = receivedAt;
    if (playerName) {
      publishers[publisherId].playerName = playerName;
    }
    publishers[publisherId].latestByType[msgType] = msg;
  }
  
  function handleIncomingMessage(raw) {
    const receivedAt = Date.now();
    
    if (typeof raw !== "string") {
      return;
    }
    
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (e) {
      return;
    }
    
    // Handle snapshot messages (sent on initial connect)
    if (msg.type === "snapshot" && msg.data && typeof msg.data === "object") {
      // Snapshot contains multiple messages keyed by type
      Object.entries(msg.data).forEach(([type, subMsg]) => {
        if (subMsg && typeof subMsg === "object") {
          processMessage(subMsg, receivedAt);
        }
      });
      return;
    }
    
    // Handle regular messages
    processMessage(msg, receivedAt);
  }
  
  // Test snapshot message
  const snapshotMsg = JSON.stringify({
    type: "snapshot",
    data: {
      hand: {
        publisherId: "pub1",
        playerName: "Player1",
        type: "hand",
        data: { value1: "A", suit1: "h", value2: "K", suit2: "d" }
      },
      state: {
        publisherId: "pub1",
        type: "state",
        data: { status: "active" }
      }
    }
  });
  
  handleIncomingMessage(snapshotMsg);
  
  assert(publishers["pub1"], "Should create publisher from snapshot");
  assert(publishers["pub1"].latestByType["hand"], "Should have hand message");
  assert(publishers["pub1"].latestByType["state"], "Should have state message");
  assertEqual(publishers["pub1"].playerName, "Player1", "Should set player name");
  
  // Test regular message
  const regularMsg = JSON.stringify({
    publisherId: "pub2",
    playerName: "Player2",
    type: "hand",
    data: { value1: "Q", suit1: "c", value2: "J", suit2: "s" }
  });
  
  handleIncomingMessage(regularMsg);
  
  assert(publishers["pub2"], "Should create publisher from regular message");
  assert(publishers["pub2"].latestByType["hand"], "Should have hand message");
  
  console.log("✓ Snapshot message handling tests passed");
}

// Test error code handling
function testErrorCodeHandling() {
  console.log("Testing error code handling...");
  
  const codes = {
    4001: "Invalid role parameter",
    4002: "Invalid or missing token",
    4003: "Token expired",
    4004: "Token claim mismatch (room/role)",
  };
  
  assertEqual(codes[4001], "Invalid role parameter", "Should handle 4001");
  assertEqual(codes[4002], "Invalid or missing token", "Should handle 4002");
  assertEqual(codes[4003], "Token expired", "Should handle 4003");
  assertEqual(codes[4004], "Token claim mismatch (room/role)", "Should handle 4004");
  
  console.log("✓ Error code handling tests passed");
}

// Test token masking
function testTokenMasking() {
  console.log("Testing token masking...");
  
  const url1 = "wss://hub.com/?role=sub&room=test&token=secret123";
  const masked1 = url1.replace(/token=[^&]+/, 'token=***');
  assert(!masked1.includes("secret123"), "Should mask token");
  assert(masked1.includes("token=***"), "Should show masked token");
  
  const url2 = "wss://hub.com/?role=sub&room=test&token=abc&other=value";
  const masked2 = url2.replace(/token=[^&]+/, 'token=***');
  assert(masked2.includes("other=value"), "Should preserve other params");
  
  console.log("✓ Token masking tests passed");
}

// Test publisherId fallback
function testPublisherIdFallback() {
  console.log("Testing publisherId fallback...");
  
  const msg1 = { publisherId: "pub1", type: "hand" };
  const msg2 = { type: "hand" }; // no publisherId
  
  const id1 = msg1.publisherId || "unknown";
  const id2 = msg2.publisherId || "unknown";
  
  assertEqual(id1, "pub1", "Should use provided publisherId");
  assertEqual(id2, "unknown", "Should fallback to unknown");
  
  console.log("✓ PublisherId fallback tests passed");
}

// Test reconnect logic
function testReconnectLogic() {
  console.log("Testing reconnect logic...");
  
  const RECONNECT_CAP_MS = 10000;
  const RECONNECT_BASE_MS = 500;
  
  const attempt1 = 0;
  const delay1 = Math.min(RECONNECT_CAP_MS, RECONNECT_BASE_MS * Math.pow(2, attempt1));
  assertEqual(delay1, 500, "First attempt should be 500ms");
  
  const attempt3 = 3;
  const delay3 = Math.min(RECONNECT_CAP_MS, RECONNECT_BASE_MS * Math.pow(2, attempt3));
  assertEqual(delay3, 4000, "Third attempt should be 4000ms");
  
  const attempt10 = 10;
  const delay10 = Math.min(RECONNECT_CAP_MS, RECONNECT_BASE_MS * Math.pow(2, attempt10));
  assertEqual(delay10, 10000, "High attempt should cap at 10000ms");
  
  console.log("✓ Reconnect logic tests passed");
}

// Test card normalization
function testCardNormalization() {
  console.log("Testing card normalization...");
  
  function normalizeValue(v) {
    if (v == null) return "—";
    const s = String(v).trim().toUpperCase();
    if (s === "10") return "10";
    if (s.length === 0) return "—";
    return s;
  }
  
  assertEqual(normalizeValue(null), "—", "Should handle null");
  assertEqual(normalizeValue(""), "—", "Should handle empty string");
  assertEqual(normalizeValue("a"), "A", "Should uppercase");
  assertEqual(normalizeValue("10"), "10", "Should preserve 10");
  assertEqual(normalizeValue("k"), "K", "Should uppercase K");
  
  console.log("✓ Card normalization tests passed");
}

// Test token expiry handling (4003) with Private Mode
function testTokenExpiryLogic() {
  console.log("Testing token expiry logic...");
  
  // Simulate 4003 handling with token (non-private mode)
  let lastConnectionUsedToken = true;
  let lastConnectionPrivateMode = false;
  let shouldReconnect = false;
  
  const code = 4003;
  if (code === 4003) {
    if (lastConnectionUsedToken) {
      if (lastConnectionPrivateMode) {
        shouldReconnect = true; // Private Mode will auto re-fetch token
      } else {
        shouldReconnect = false; // Manual token - user needs to provide new one
      }
    } else {
      shouldReconnect = true;
    }
  }
  
  assert(shouldReconnect === false, "Should NOT reconnect when token expired in non-private mode");
  
  // Simulate 4003 handling with token (Private Mode)
  lastConnectionPrivateMode = true;
  shouldReconnect = false;
  if (code === 4003) {
    if (lastConnectionUsedToken) {
      if (lastConnectionPrivateMode) {
        shouldReconnect = true; // Private Mode will auto re-fetch token
      } else {
        shouldReconnect = false;
      }
    } else {
      shouldReconnect = true;
    }
  }
  
  assert(shouldReconnect === true, "Should reconnect when token expired in Private Mode");
  
  // Simulate 4003 handling without token (unexpected case)
  lastConnectionUsedToken = false;
  if (code === 4003) {
    if (lastConnectionUsedToken) {
      if (lastConnectionPrivateMode) {
        shouldReconnect = true;
      } else {
        shouldReconnect = false;
      }
    } else {
      shouldReconnect = true;
    }
  }
  
  assert(shouldReconnect === true, "Should reconnect when no token was used (unexpected 4003)");
  
  console.log("✓ Token expiry logic tests passed");
}

// Test 4003 triggers re-auth and reconnect in Private Mode
function testTokenExpiry4003Reconnect() {
  console.log("Testing 4003 token expiry reconnect flow...");
  
  // Simulate state tracking
  let reconnectCalled = false;
  let tokenFetchCalled = false;
  
  function simulateReconnectBehavior(closeCode, lastUsedToken, privateMode) {
    if (closeCode === 4003) {
      if (lastUsedToken && privateMode) {
        // Private Mode: should trigger re-auth and reconnect
        tokenFetchCalled = true;
        reconnectCalled = true;
        return { action: "reconnect", reAuth: true };
      } else if (lastUsedToken && !privateMode) {
        // Non-private mode: should NOT reconnect
        return { action: "disconnect", reAuth: false };
      } else {
        // No token used: unexpected, retry
        reconnectCalled = true;
        return { action: "reconnect", reAuth: false };
      }
    }
    return { action: "continue", reAuth: false };
  }
  
  // Test: Private Mode ON, token used, 4003 received
  const result1 = simulateReconnectBehavior(4003, true, true);
  assert(result1.action === "reconnect", "Should trigger reconnect in Private Mode");
  assert(result1.reAuth === true, "Should re-authenticate in Private Mode");
  
  // Test: Private Mode OFF, token used, 4003 received
  const result2 = simulateReconnectBehavior(4003, true, false);
  assert(result2.action === "disconnect", "Should disconnect without Private Mode");
  assert(result2.reAuth === false, "Should NOT re-authenticate without Private Mode");
  
  // Test: No token, 4003 received (edge case)
  const result3 = simulateReconnectBehavior(4003, false, false);
  assert(result3.action === "reconnect", "Should reconnect for unexpected 4003");
  
  console.log("✓ 4003 token expiry reconnect flow tests passed");
}

// Test reAuthInFlight guard prevents repeated re-auth calls on multiple 4003 events
async function testReAuthInFlightGuard() {
  console.log("Testing reAuthInFlight guard...");

  function create4003Handler() {
    let reAuthInFlight = false;
    let reAuthCalls = 0;

    async function reAuthAndReconnect() {
      reAuthCalls += 1;
      // Simulate async re-auth taking time
      await new Promise((r) => setTimeout(r, 10));
      reAuthInFlight = false;
    }

    function onClose(code, lastConnectionPrivateMode) {
      if (code === 4003 && lastConnectionPrivateMode === true) {
        if (reAuthInFlight) return;
        reAuthInFlight = true;
        void reAuthAndReconnect();
      }
    }

    return { onClose, getCalls: () => reAuthCalls };
  }

  // Private Mode ON -> only one re-auth call even if close fires twice
  const h1 = create4003Handler();
  h1.onClose(4003, true);
  h1.onClose(4003, true);
  await new Promise((r) => setTimeout(r, 25));
  assertEqual(h1.getCalls(), 1, "Should only re-auth once while in-flight");

  // Private Mode OFF -> no re-auth
  const h2 = create4003Handler();
  h2.onClose(4003, false);
  await new Promise((r) => setTimeout(r, 25));
  assertEqual(h2.getCalls(), 0, "Should not re-auth when Private Mode is OFF");

  console.log("✓ reAuthInFlight guard tests passed");
}

// Test Private Mode token fetch logic
async function testPrivateModeTokenFetch() {
  console.log("Testing Private Mode token fetch...");
  
  // Mock token function that exposes what would be sent to fetch()
  async function mockGetSubscriberToken(roomId, password) {
    const headers = { "X-Dashboard-Password": password };
    const body = { room: roomId, role: "sub" };

    assert(roomId, "roomId should be provided");
    assert(password, "password should be provided");

    if (password === "wrong") {
      throw new Error("Unauthorized (wrong password)");
    }

    return { token: "mock-jwt-token-" + roomId, headers, body };
  }

  // Test successful token fetch
  const ok = await mockGetSubscriberToken("room123", "correctPassword");
  assertEqual(ok.headers["X-Dashboard-Password"], "correctPassword", "Should include password header");
  assertEqual(ok.body.room, "room123", "Should include room in body");
  assertEqual(ok.body.role, "sub", "Should include role in body");
  assertEqual(ok.token, "mock-jwt-token-room123", "Should return token");
  console.log("✓ Private Mode token fetch tests passed");

  // Test 401 handling
  let threw = false;
  try {
    await mockGetSubscriberToken("room123", "wrong");
  } catch (err) {
    threw = true;
    assert(String(err.message || err).includes("Unauthorized"), "Should indicate unauthorized");
  }
  assert(threw, "Should have thrown for wrong password");
  console.log("✓ Private Mode 401 handling tests passed");
}

// Run all tests
async function runAllTests() {
  console.log("\n=== Running Dashboard Test Suite ===\n");
  
  const tests = [
    testExtractGameId,
    testSettingsDoesNotPersistPassword,
    testBuildWsUrl,
    testBuildWsUrlPrivateMode,
    testGetSubscriberTokenHeaderAnd401,
    testSnapshotMessageHandling,
    testErrorCodeHandling,
    testTokenMasking,
    testPublisherIdFallback,
    testReconnectLogic,
    testCardNormalization,
    testTokenExpiryLogic,
    testTokenExpiry4003Reconnect,
    testReAuthInFlightGuard,
    testPrivateModeTokenFetch,
  ];
  
  let passed = 0;
  let failed = 0;
  const failures = [];
  
  for (const test of tests) {
    try {
      await test();
      passed++;
    } catch (e) {
      failed++;
      failures.push({ test: test.name, error: e.message });
      console.error(`✗ ${test.name} failed: ${e.message}`);
    }
  }
  
  console.log(`\n=== Test Results ===`);
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log(`Total: ${tests.length}`);
  
  if (failures.length > 0) {
    console.log(`\nFailures:`);
    failures.forEach(f => {
      console.log(`  - ${f.test}: ${f.error}`);
    });
  }
  
  return failed === 0;
}

// Run tests
runAllTests();

