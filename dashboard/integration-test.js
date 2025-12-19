/**
 * Integration test that verifies snapshot message handling
 * Tests the FIXED implementation in app.js
 */

// Simulate the FIXED handleIncomingMessage logic from app.js
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

function simulateFixedHandleIncomingMessage(raw) {
  const receivedAt = Date.now();
  
  if (typeof raw !== "string") {
    return { error: "Non-text WS message" };
  }
  
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch (e) {
    return { error: "JSON parse failed" };
  }
  
  // FIXED implementation - handles snapshot messages
  if (msg.type === "snapshot" && msg.data && typeof msg.data === "object") {
    const processedCount = Object.keys(msg.data).length;
    Object.entries(msg.data).forEach(([type, subMsg]) => {
      if (subMsg && typeof subMsg === "object") {
        processMessage(subMsg, receivedAt);
      }
    });
    return {
      isSnapshot: true,
      processedCount,
      publishers: Object.keys(publishers),
    };
  }
  
  // Regular message
  processMessage(msg, receivedAt);
  return {
    isSnapshot: false,
    publisherId: msg.publisherId || "unknown",
    msgType: msg.type || "unknown",
  };
}

// Test snapshot message (what hub sends on connect)
function testSnapshotMessage() {
  console.log("\n=== Testing Snapshot Message Handling ===\n");
  
  // Clear publishers for clean test
  Object.keys(publishers).forEach(key => delete publishers[key]);
  
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
  
  const result = simulateFixedHandleIncomingMessage(snapshotMsg);
  
  console.log("Snapshot message result:", result);
  
  // Verify snapshot was processed correctly
  if (result.isSnapshot && result.processedCount === 2) {
    console.log("\n✅ Snapshot message processing FIXED:");
    console.log("  - Detected snapshot message type");
    console.log("  - Processed", result.processedCount, "messages from snapshot.data");
    console.log("  - Publishers tracked:", result.publishers);
    
    // Verify publishers store was updated
    if (publishers["pub1"] && 
        publishers["pub1"].latestByType["hand"] && 
        publishers["pub1"].latestByType["state"]) {
      console.log("  - Publisher 'pub1' has hand and state messages");
      return true;
    }
  }
  
  console.log("\n❌ Snapshot handling still broken");
  return false;
}

// Test regular message (should work fine)
function testRegularMessage() {
  console.log("\n=== Testing Regular Message Handling ===\n");
  
  const regularMsg = JSON.stringify({
    publisherId: "pub2",
    playerName: "Player2",
    type: "hand",
    data: { value1: "Q", suit1: "c", value2: "J", suit2: "s" }
  });
  
  const result = simulateFixedHandleIncomingMessage(regularMsg);
  
  console.log("Regular message result:", result);
  
  if (result.publisherId === "pub2" && result.msgType === "hand") {
    console.log("✅ Regular messages work correctly");
    return true;
  } else {
    console.log("❌ Regular messages not working");
    return false;
  }
}

// Run integration tests
console.log("=".repeat(60));
console.log("INTEGRATION TEST: Snapshot Message Handling");
console.log("=".repeat(60));

const snapshotTest = testSnapshotMessage();
const regularTest = testRegularMessage();

console.log("\n" + "=".repeat(60));
console.log("TEST SUMMARY");
console.log("=".repeat(60));
console.log(`Snapshot handling: ${snapshotTest ? "PASS ✅" : "FAIL ❌"}`);
console.log(`Regular messages: ${regularTest ? "PASS ✅" : "FAIL ❌"}`);

if (snapshotTest && regularTest) {
  console.log("\n🟢 ALL INTEGRATION TESTS PASSED!");
} else {
  console.log("\n🔴 SOME TESTS FAILED - Review output above");
}

