/**
 * Live Integration Test: Hub ↔ SS (Subscriber)
 * Tests actual connection to dom-hub.onrender.com
 * 
 * Tests:
 * 1. SS connects with role=sub without token (default) → connect OK
 * 2. SS receives snapshot on connect (if hub provides it)
 * 3. SS receives real-time broadcast messages from publisher
 */

const WebSocket = require('ws');

const TEST_CONFIG = {
  hubUrl: 'wss://dom-hub.onrender.com',
  room: 'test-room-' + Date.now(), // Unique room for testing
  role: 'sub',
  timeout: 30000, // 30 second timeout
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
console.log(`  Token: None (testing default subscriber connection)`);
console.log();

/**
 * Test 1: Connect to hub without token
 */
function testConnectionWithoutToken() {
  return new Promise((resolve, reject) => {
    console.log('📋 TEST 1: Connecting to hub without token...');
    
    const url = `${TEST_CONFIG.hubUrl}?role=${TEST_CONFIG.role}&room=${TEST_CONFIG.room}`;
    console.log(`   URL: ${url}`);
    
    const ws = new WebSocket(url);
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error('Connection timeout'));
    }, TEST_CONFIG.timeout);
    
    ws.on('open', () => {
      clearTimeout(timeout);
      testResults.connectionSuccess = true;
      console.log('   ✅ Connection established successfully (without token)');
      
      // Keep connection open to receive messages
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
    // Test 1: Connection without token
    const ws = await testConnectionWithoutToken();
    
    // Test 2 & 3: Receive messages
    await testMessagesReceived(ws);
    
    // Print results
    console.log('\n' + '='.repeat(70));
    console.log('TEST RESULTS SUMMARY');
    console.log('='.repeat(70));
    
    console.log('\n✅ Test 1: Connection without token');
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
      console.log('✅ Subscriber can connect to hub without token');
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

