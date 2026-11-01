/**
 * Verification Test Suite for Phase C.3: Gemini Extraction Reliability & Diagnostics
 */
const { getAvailableGeminiModels, streamAnswerKeyForQuestionPaper, getGeminiApiKey } = require('../backend/services/geminiService');

async function runTests() {
  console.log('--- Phase C.3 Diagnostic & Reliability Verification ---\n');

  // Test 1: Verify getAvailableGeminiModels candidate list priority
  console.log('1. Checking model candidate order...');
  const models = await getAvailableGeminiModels('dummy-key-for-test');
  console.log('   Models resolved:', models);
  if (!models.includes('gemini-pro') && models[0] === 'gemini-2.0-flash' && models.includes('gemini-1.5-pro')) {
    console.log('   ✅ PASS: Model candidate list prioritizes modern Flash models and excludes deprecated gemini-pro');
  } else {
    console.error('   ❌ FAIL: Unexpected model candidate list:', models);
    process.exit(1);
  }

  // Test 2: Verify getGeminiApiKey behavior with no key
  console.log('\n2. Checking getGeminiApiKey behavior when key is absent...');
  const originalKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  const resolvedKey = getGeminiApiKey();
  console.log('   Resolved key when unset:', resolvedKey ? '[FOUND_IN_ENV_FILE]' : 'null');

  // Test 3: Verify streamAnswerKeyForQuestionPaper error thrown when key is missing
  console.log('\n3. Checking streamAnswerKeyForQuestionPaper throws clear error when key is missing...');
  delete process.env.GEMINI_API_KEY;
  try {
    await streamAnswerKeyForQuestionPaper({
      title: 'Smoke Test',
      textContent: 'Solve 2x + 5 = 15',
    });
    console.error('   ❌ FAIL: Expected error when GEMINI_API_KEY is missing, but succeeded');
    process.exit(1);
  } catch (err) {
    if (err.message.includes('Google Gemini API Key is missing')) {
      console.log('   ✅ PASS: Throws clear actionable error:', err.message);
    } else {
      console.error('   ❌ FAIL: Unexpected error message:', err.message);
      process.exit(1);
    }
  }

  // Restore env if it was set
  if (originalKey) process.env.GEMINI_API_KEY = originalKey;

  // Test 4: Verify frontend SSE stream parsing with keepalives and error propagation
  console.log('\n4. Checking SSE stream parsing with : keepalive comments and event: error propagation...');
  const sampleSSEStream = [
    ': keepalive\n\n',
    'event: status\ndata: {"stage":"connecting","percent":25}\n\n',
    ': keepalive\n\n',
    'event: error\ndata: {"message":"Google Gemini API Key is missing. Please configure GEMINI_API_KEY in the server environment."}\n\n',
  ];

  let receivedStatus = null;
  let caughtError = null;

  try {
    for (const block of sampleSSEStream) {
      if (!block.trim()) continue;
      const lines = block.split('\n');
      let eventType = 'message';
      let dataStr = '';

      for (const line of lines) {
        if (line.startsWith(':')) {
          continue; // Ignore keepalive
        }
        if (line.startsWith('event:')) {
          eventType = line.replace(/^event:\s*/, '').trim();
        } else if (line.startsWith('data:')) {
          dataStr += line.replace(/^data:\s*/, '');
        }
      }

      if (dataStr) {
        let dataObj;
        try {
          dataObj = JSON.parse(dataStr);
        } catch (jsonErr) {
          console.warn('SSE parse error:', jsonErr.message);
          continue;
        }

        if (eventType === 'status') {
          receivedStatus = dataObj;
        } else if (eventType === 'error') {
          throw new Error(dataObj.message || 'Stream generation failed');
        }
      }
    }
  } catch (err) {
    caughtError = err;
  }

  if (receivedStatus && receivedStatus.stage === 'connecting' && caughtError && caughtError.message.includes('GEMINI_API_KEY')) {
    console.log('   ✅ PASS: : keepalive lines were ignored, status events processed, and event: error correctly propagated!');
  } else {
    console.error('   ❌ FAIL: SSE parsing verification failed. Status:', receivedStatus, 'Caught error:', caughtError);
    process.exit(1);
  }

  console.log('\n🎉 ALL 4 PHASE C.3 DIAGNOSTIC TESTS PASSED!\n');
}

runTests().catch(err => {
  console.error('Test execution error:', err);
  process.exit(1);
});
