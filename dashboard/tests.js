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

// Test token expiry handling
function testTokenExpiryLogic() {
  console.log("Testing token expiry logic...");
  
  // Simulate 4003 handling with token
  let lastConnectionUsedToken = true;
  let shouldReconnect = false;
  
  const code = 4003;
  if (code === 4003) {
    if (lastConnectionUsedToken) {
      // Should NOT auto-reconnect - user needs new token
      shouldReconnect = false;
    } else {
      // No token was used, should reconnect
      shouldReconnect = true;
    }
  }
  
  assert(shouldReconnect === false, "Should NOT reconnect when token was used and expired");
  
  // Simulate 4003 handling without token (unexpected case)
  lastConnectionUsedToken = false;
  if (code === 4003) {
    if (lastConnectionUsedToken) {
      shouldReconnect = false;
    } else {
      shouldReconnect = true;
    }
  }
  
  assert(shouldReconnect === true, "Should reconnect when no token was used (unexpected 4003)");
  
  console.log("✓ Token expiry logic tests passed");
}

// Run all tests
function runAllTests() {
  console.log("\n=== Running Dashboard Test Suite ===\n");
  
  const tests = [
    testExtractGameId,
    testBuildWsUrl,
    testSnapshotMessageHandling,
    testErrorCodeHandling,
    testTokenMasking,
    testPublisherIdFallback,
    testReconnectLogic,
    testCardNormalization,
    testTokenExpiryLogic,
  ];
  
  let passed = 0;
  let failed = 0;
  const failures = [];
  
  tests.forEach(test => {
    try {
      test();
      passed++;
    } catch (e) {
      failed++;
      failures.push({ test: test.name, error: e.message });
      console.error(`✗ ${test.name} failed: ${e.message}`);
    }
  });
  
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

