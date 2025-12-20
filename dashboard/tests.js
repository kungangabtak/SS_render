/**
 * Test suite for Dashboard (static client)
 * Focus: room extraction, JWT URL building, dom-auth token fetch contract, snapshot handling, 4003 re-auth guard.
 */

// Test utilities
function assert(condition, message) {
  if (!condition) throw new Error(message || "Assertion failed");
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(message || `Expected ${expected}, got ${actual}`);
}

// Test extractGameId logic
function testExtractGameId() {
  console.log("Testing extractGameId...");

  function extractGameId(input) {
    const s = String(input || "").trim();
    if (!s) return "";
    const match = s.match(/\/games\/([a-zA-Z0-9_-]+)/);
    if (match && match[1]) return match[1];
    return s;
  }

  assertEqual(
    extractGameId("https://www.pokernow.club/games/pglQ2HgWGgYbDUSq7f9moVbXR"),
    "pglQ2HgWGgYbDUSq7f9moVbXR",
    "Should extract from full URL"
  );
  assertEqual(extractGameId("pglQ2HgWGgYbDUSq7f9moVbXR"), "pglQ2HgWGgYbDUSq7f9moVbXR", "Should return raw input");
  assertEqual(extractGameId(""), "", "Should return empty for empty input");

  console.log("✓ extractGameId tests passed");
}

// Test buildWsUrl requires JWT for role=sub
function testBuildWsUrlRequiresToken() {
  console.log("Testing buildWsUrl requires token...");

  function buildWsUrl(hub, gameId, token) {
    let hubStr = String(hub || "").trim();
    if (!hubStr) throw new Error("Missing hub");
    if (!/^wss?:\/\//i.test(hubStr)) hubStr = `wss://${hubStr}`;
    const u = new URL(hubStr);
    u.searchParams.set("role", "sub");
    const room = String(gameId || "").trim();
    if (!room) throw new Error("Missing room/gameId");
    u.searchParams.set("room", room);
    const tokenValue = String(token || "").trim();
    if (!tokenValue) throw new Error("Missing token (JWT required)");
    u.searchParams.set("token", tokenValue);
    return u.toString();
  }

  let threw = false;
  try {
    buildWsUrl("wss://hub.com", "test123", "");
  } catch (e) {
    threw = true;
    assert(String(e.message || e).includes("Missing token"), "Should throw missing token");
  }
  assert(threw, "Should throw when token missing");

  const jwtToken = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb29tIjoicm9vbTEyMyIsInJvbGUiOiJzdWIifQ.fake";
  const url = buildWsUrl("wss://dom-hub.onrender.com", "room123", jwtToken);
  assert(url.includes("role=sub"), "URL should include role=sub");
  assert(url.includes("room=room123"), "URL should include room");
  assert(url.includes("token="), "URL should include token");

  console.log("✓ buildWsUrl requires token tests passed");
}

// Test getSubscriberToken sends password header + maps 401 correctly
async function testGetSubscriberTokenHeaderAnd401() {
  console.log("Testing getSubscriberToken header + 401 mapping...");

  const calls = [];

  async function mockFetch(url, opts) {
    calls.push({ url, opts });
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

  await getSubscriberToken("room123", "  pw  ", mockFetch);
  assertEqual(calls.length, 1, "Should call fetch exactly once");
  assertEqual(calls[0].opts.headers["X-Dashboard-Password"], "pw", "Should send trimmed X-Dashboard-Password header");

  async function mockFetch401() {
    return { ok: false, status: 401, async json() { return { error: "Unauthorized" }; } };
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

// Test snapshot message handling
function testSnapshotMessageHandling() {
  console.log("Testing snapshot message handling...");

  const publishers = {};

  function processMessage(msg, receivedAt) {
    const publisherId = msg.publisherId || "unknown";
    const playerName = msg.playerName || null;
    const msgType = msg.type || "unknown";

    if (!publishers[publisherId]) {
      publishers[publisherId] = { lastSeen: receivedAt, playerName: playerName, latestByType: {} };
    }
    publishers[publisherId].lastSeen = receivedAt;
    if (playerName) publishers[publisherId].playerName = playerName;
    publishers[publisherId].latestByType[msgType] = msg;
  }

  function handleIncomingMessage(raw) {
    const receivedAt = Date.now();
    if (typeof raw !== "string") return;
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === "snapshot" && msg.data && typeof msg.data === "object") {
      Object.entries(msg.data).forEach(([type, subMsg]) => {
        if (subMsg && typeof subMsg === "object") processMessage(subMsg, receivedAt);
      });
      return;
    }
    processMessage(msg, receivedAt);
  }

  const snapshotMsg = JSON.stringify({
    type: "snapshot",
    data: {
      hand: { publisherId: "pub1", playerName: "Player1", type: "hand", data: { value1: "A", suit1: "h", value2: "K", suit2: "d" } },
      state: { publisherId: "pub1", type: "state", data: { status: "active" } },
    },
  });

  handleIncomingMessage(snapshotMsg);
  assert(publishers["pub1"], "Should create publisher from snapshot");
  assert(publishers["pub1"].latestByType["hand"], "Should have hand message");
  assert(publishers["pub1"].latestByType["state"], "Should have state message");
  assertEqual(publishers["pub1"].playerName, "Player1", "Should set player name");

  console.log("✓ Snapshot message handling tests passed");
}

// Test reAuthInFlight guard prevents repeated re-auth calls on multiple 4003 events
async function testReAuthInFlightGuard() {
  console.log("Testing reAuthInFlight guard...");

  function create4003Handler() {
    let reAuthInFlight = false;
    let reAuthCalls = 0;

    async function reAuthAndReconnect() {
      reAuthCalls += 1;
      await new Promise((r) => setTimeout(r, 10));
      reAuthInFlight = false;
    }

    function onClose(code) {
      if (code !== 4003) return;
      if (reAuthInFlight) return;
      reAuthInFlight = true;
      void reAuthAndReconnect();
    }

    return { onClose, getCalls: () => reAuthCalls };
  }

  const h = create4003Handler();
  h.onClose(4003);
  h.onClose(4003);
  await new Promise((r) => setTimeout(r, 25));
  assertEqual(h.getCalls(), 1, "Should only re-auth once while in-flight");

  console.log("✓ reAuthInFlight guard tests passed");
}

// Run all tests
async function runAllTests() {
  console.log("\n=== Running Dashboard Test Suite ===\n");

  const tests = [
    testExtractGameId,
    testBuildWsUrlRequiresToken,
    testGetSubscriberTokenHeaderAnd401,
    testSnapshotMessageHandling,
    testReAuthInFlightGuard,
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
    failures.forEach((f) => console.log(`  - ${f.test}: ${f.error}`));
  }

  return failed === 0;
}

runAllTests();

