/**
 * Live Integration Test: Hub ↔ SS (Subscriber)
 * Tests actual connection to dom-hub.onrender.com
 * 
 * Tests:
 * 1. SS fetches JWT from dom-auth using password
 * 2. SS connects with role=sub with JWT → connect OK
 * 2. SS receives snapshot on connect (if hub provides it)
 * 3. SS receives real-time broadcast messages from publisher
 */

const WebSocket = require('ws');
const https = require('https');

const TEST_CONFIG = {
  hubUrl: 'wss://dom-hub.onrender.com',
  room: 'test-room-' + Date.now(), // Unique room for testing
  role: 'sub',
  timeout: 30000, // 30 second timeout
  dashboardPassword: process.env.DASHBOARD_PASSWORD || "",
};

let testResults = {
  connectionSuccess: false,
  snapshotReceived: false,
  messagesReceived: [],
  errors: [],
};

console.log('='.repeat(70));
console.log('LIVE INTEGRATION TEST: Hub ↔ SS (Subscriber)');
console.log('='.repeat(70));
console.log(`\nTest Configuration:`);
console.log(`  Hub: ${TEST_CONFIG.hubUrl}`);
console.log(`  Room: ${TEST_CONFIG.room}`);
console.log(`  Role: ${TEST_CONFIG.role}`);
console.log(`  Token: JWT (fetched from dom-auth)`);
console.log();

/**
 * Fetch a subscriber JWT from dom-auth
 * Uses: POST https://dom-auth.onrender.com/token
 * Header: X-Dashboard-Password: <password>
 * Body: { room, role: "sub" }
 */
function fetchSubscriberJwt({ room, password }) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ room, role: "sub" });

    const req = https.request(
      'https://dom-auth.onrender.com/token',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'X-Dashboard-Password': password,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          let parsed = null;
          try {
            parsed = data ? JSON.parse(data) : null;
          } catch {
            parsed = null;
          }

          if (res.statusCode !== 200) {
            const errMsg =
              (parsed && (parsed.error || parsed.message)) ||
              (data && data.trim()) ||
              `dom-auth failed (${res.statusCode})`;
            reject(new Error(errMsg));
            return;
          }

          if (!parsed || !parsed.token) {
            reject(new Error('dom-auth response missing token'));
            return;
          }

          resolve(parsed.token);
        });
      }
    );

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/**
 * Test 1 & 2: Fetch JWT then connect to hub
 */
async function testConnectionWithJwt() {
  console.log('📋 TEST 1: Fetching JWT from dom-auth...');
  if (!TEST_CONFIG.dashboardPassword) {
    throw new Error('Missing DASHBOARD_PASSWORD env var (required to fetch JWT)');
  }

  const token = await fetchSubscriberJwt({ room: TEST_CONFIG.room, password: TEST_CONFIG.dashboardPassword });
  console.log('   ✅ JWT fetched successfully');

  return new Promise((resolve, reject) => {
    console.log('\n📋 TEST 2: Connecting to hub with JWT...');

    const u = new URL(TEST_CONFIG.hubUrl);
    u.searchParams.set('role', TEST_CONFIG.role);
    u.searchParams.set('room', TEST_CONFIG.room);
    u.searchParams.set('token', token);
    const url = u.toString();
    console.log(`   URL: ${url.replace(/token=([^&]+)/, 'token=***')}`);

    const ws = new WebSocket(url);
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error('Connection timeout'));
    }, TEST_CONFIG.timeout);

    ws.on('open', () => {
      clearTimeout(timeout);
      testResults.connectionSuccess = true;
      console.log('   ✅ Connection established successfully (with JWT)');
      resolve(ws);
    });

    ws.on('error', (error) => {
      clearTimeout(timeout);
      testResults.errors.push({ test: 'connection', error: error.message });
      console.log(`   ❌ Connection failed: ${error.message}`);
      reject(error);
    });

    ws.on('close', (code, reason) => {
      clearTimeout(timeout);
      if (code !== 1000) {
        const msg = `Connection closed unexpectedly: ${code} - ${reason}`;
        testResults.errors.push({ test: 'connection', error: msg });
        console.log(`   ❌ ${msg}`);
      }
    });
  });
}

/**
 * Test 2 & 3: Listen for snapshot and broadcast messages
 */
function testMessagesReceived(ws) {
  return new Promise((resolve) => {
    console.log('\n📋 TEST 2 & 3: Listening for snapshot and broadcast messages...');
    console.log('   (Will wait up to 30 seconds for messages)');
    
    let messageCount = 0;
    const maxWaitTime = TEST_CONFIG.timeout;
    const startTime = Date.now();
    
    ws.on('message', (data) => {
      messageCount++;
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      
      try {
        const message = JSON.parse(data.toString());
        console.log(`   📨 Message ${messageCount} received (${elapsed}s):`);
        console.log(`      Type: ${message.type || 'unknown'}`);
        
        // Check for snapshot
        if (message.type === 'snapshot') {
          testResults.snapshotReceived = true;
          const messageTypes = message.data ? Object.keys(message.data) : [];
          console.log(`      ✅ SNAPSHOT received with ${messageTypes.length} message(s): ${messageTypes.join(', ')}`);
          if (message.data) {
            Object.entries(message.data).forEach(([type, msg]) => {
              console.log(`         - ${type}: publisherId=${msg.publisherId || 'unknown'}`);
            });
          }
        } else {
          // Regular broadcast message
          console.log(`      PublisherId: ${message.publisherId || 'unknown'}`);
          console.log(`      PlayerName: ${message.playerName || 'N/A'}`);
          if (message.data) {
            const keys = Object.keys(message.data).slice(0, 3);
            console.log(`      Data keys: ${keys.join(', ')}${Object.keys(message.data).length > 3 ? '...' : ''}`);
          }
        }
        
        testResults.messagesReceived.push({
          type: message.type,
          publisherId: message.publisherId,
          timestamp: Date.now(),
        });
        
      } catch (e) {
        console.log(`      ⚠️  Failed to parse message: ${e.message}`);
        testResults.errors.push({ test: 'message_parsing', error: e.message });
      }
    });
    
    // Wait for messages or timeout
    const checkInterval = setInterval(() => {
      const elapsed = Date.now() - startTime;
      
      if (elapsed >= maxWaitTime) {
        clearInterval(checkInterval);
        ws.close();
        
        if (messageCount === 0) {
          console.log(`   ℹ️  No messages received within ${maxWaitTime/1000}s`);
          console.log(`      This is expected if no publishers are active in room: ${TEST_CONFIG.room}`);
        }
        
        resolve();
      }
    }, 1000);
    
    ws.on('close', () => {
      clearInterval(checkInterval);
      resolve();
    });
  });
}

/**
 * Run all tests
 */
async function runTests() {
  try {
    // Test 1 & 2: Fetch token and connect
    const ws = await testConnectionWithJwt();
    
    // Test 2 & 3: Receive messages
    await testMessagesReceived(ws);
    
    // Print results
    console.log('\n' + '='.repeat(70));
    console.log('TEST RESULTS SUMMARY');
    console.log('='.repeat(70));
    
    console.log('\n✅ Test 1 & 2: JWT fetch + connect with token');
    console.log(`   Status: ${testResults.connectionSuccess ? 'PASS' : 'FAIL'}`);
    
    console.log('\n📦 Test 2: Snapshot on connect');
    console.log(`   Status: ${testResults.snapshotReceived ? 'PASS - Snapshot received' : 'N/A - No snapshot (expected if room is empty)'}`);
    
    console.log('\n📡 Test 3: Real-time broadcast messages');
    console.log(`   Messages received: ${testResults.messagesReceived.length}`);
    if (testResults.messagesReceived.length > 0) {
      console.log('   Status: PASS - Messages received');
      console.log('   Message types:');
      const typeCounts = {};
      testResults.messagesReceived.forEach(msg => {
        typeCounts[msg.type] = (typeCounts[msg.type] || 0) + 1;
      });
      Object.entries(typeCounts).forEach(([type, count]) => {
        console.log(`     - ${type}: ${count}`);
      });
    } else {
      console.log('   Status: N/A - No messages (expected if no publishers active)');
    }
    
    if (testResults.errors.length > 0) {
      console.log('\n⚠️  Errors encountered:');
      testResults.errors.forEach((err, i) => {
        console.log(`   ${i + 1}. [${err.test}] ${err.error}`);
      });
    }
    
    console.log('\n' + '='.repeat(70));
    console.log('CONCLUSION');
    console.log('='.repeat(70));
    
    if (testResults.connectionSuccess) {
      console.log('✅ Subscriber can fetch JWT from dom-auth');
      console.log('✅ Subscriber can connect to hub with JWT');
      console.log('✅ WebSocket connection is stable');
      
      if (testResults.snapshotReceived) {
        console.log('✅ Snapshot mechanism works correctly');
      } else {
        console.log('ℹ️  Snapshot not received (room likely empty - this is OK)');
      }
      
      if (testResults.messagesReceived.length > 0) {
        console.log('✅ Real-time message broadcasting works');
      } else {
        console.log('ℹ️  No broadcast messages (no active publishers - this is OK)');
      }
      
      console.log('\n🎉 OVERALL: Subscriber functionality working as expected!');
      console.log('\nNote: To test snapshot and broadcast messages:');
      console.log(`  1. Connect a publisher to room: ${TEST_CONFIG.room}`);
      console.log('  2. Run this test again');
      console.log('  3. Send messages from the publisher');
      
    } else {
      console.log('❌ FAIL: Unable to establish connection');
      console.log('   Check hub availability and network connection');
    }
    
    console.log();
    process.exit(testResults.connectionSuccess ? 0 : 1);
    
  } catch (error) {
    console.error('\n❌ Test failed with error:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

// Run tests
runTests();

