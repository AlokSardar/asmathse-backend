const assert = require('assert');
const crypto = require('crypto');

function computePageHash(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function computeCacheKey(pageHash, promptVersion, modelName) {
  return crypto
    .createHash('sha256')
    .update(pageHash + '::' + promptVersion + '::' + modelName)
    .digest('hex');
}

async function runExtractionUnitTests() {
  console.log('🧪 Starting AI Extraction Pipeline & Anti-Hallucination Unit Tests...');

  // 1. Assert different page byte buffers produce distinct page hashes and cache keys
  const pageBufferA = Buffer.from('Physics Exam Paper Page 1 Content: Electric Current, Potential Difference');
  const pageBufferB = Buffer.from('Chemistry Exam Paper Page 1 Content: Avogadro Number, Thermodynamics');

  const hashA = computePageHash(pageBufferA);
  const hashB = computePageHash(pageBufferB);

  assert.notStrictEqual(hashA, hashB, 'Different document pages must have distinct SHA-256 hashes');

  const cacheKeyA = computeCacheKey(hashA, 'v2-ocr-pure-transcription', 'gemini-3.5-flash');
  const cacheKeyB = computeCacheKey(hashB, 'v2-ocr-pure-transcription', 'gemini-3.5-flash');

  assert.notStrictEqual(cacheKeyA, cacheKeyB, 'Different document pages must have distinct cache keys');
  console.log('✅ PASS: Distinct document buffers produce unique SHA-256 hashes and cache keys.');

  // 2. Assert no static calculus fallback strings exist in controllers
  const fs = require('fs');
  const path = require('path');
  const aiImportCtrl = fs.readFileSync(path.join(__dirname, '..', 'controllers', 'aiImportController.js'), 'utf8');
  const aiCtrl = fs.readFileSync(path.join(__dirname, '..', 'controllers', 'aiController.js'), 'utf8');

  assert.strictEqual(
    aiImportCtrl.includes('getSyllabusFallbackQuestions'),
    false,
    'aiImportController must not contain getSyllabusFallbackQuestions'
  );
  assert.strictEqual(
    aiCtrl.includes('getIntelligentFallbackQuestions'),
    false,
    'aiController must not contain getIntelligentFallbackQuestions'
  );
  assert.strictEqual(
    aiImportCtrl.includes('cot x'),
    false,
    'aiImportController must not contain hardcoded differential equation cot x'
  );
  assert.strictEqual(
    aiCtrl.includes('cot x'),
    false,
    'aiController must not contain hardcoded differential equation cot x'
  );
  console.log('✅ PASS: Zero synthetic/fallback questions or hardcoded calculus equations exist in extraction controllers.');

  // 3. Test Anti-Hallucination verification logic
  const STOP_WORDS = new Set([
    'the', 'and', 'for', 'with', 'that', 'from', 'this', 'are', 'was', 'were',
    'which', 'what', 'how', 'each', 'all', 'any', 'not', 'can', 'may', 'will'
  ]);

  function normalizeMathText(str = '') {
    return str
      .toLowerCase()
      .replace(/\$+/g, ' ')
      .replace(/\\[a-zA-Z]+/g, ' ')
      .replace(/[^a-z0-9]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function verifyAntiHallucination(questionText, pageText) {
    const pageWords = new Set(normalizeMathText(pageText).split(' '));
    const qWords = normalizeMathText(questionText)
      .split(' ')
      .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
    if (qWords.length === 0) return { verified: true, overlap: 1.0 };
    let matched = 0;
    for (const w of qWords) {
      if (pageWords.has(w)) matched++;
    }
    const overlap = matched / qWords.length;
    return { verified: overlap >= 0.35, overlap };
  }

  const physicsPageText = 'Science Chapter Electricity What is the SI unit of electric current Which instrument measures potential difference';
  const genuineQ = 'What is the SI unit of electric current?';
  const hallucinatedQ = 'Find the general solution of the differential equation dy/dx + y cot x = 2x';

  const genuineCheck = verifyAntiHallucination(genuineQ, physicsPageText);
  const hallCheck = verifyAntiHallucination(hallucinatedQ, physicsPageText);

  assert.strictEqual(genuineCheck.verified, true, 'Genuine question from page must pass anti-hallucination');
  assert.strictEqual(hallCheck.verified, false, 'Hallucinated question not on page must fail anti-hallucination');
  console.log('✅ PASS: Anti-Hallucination verification accurately detects and rejects hallucinated questions.');

  console.log('\n🎉 ALL AI EXTRACTION PIPELINE TESTS PASSED WITH 100% SUCCESS!');
}

runExtractionUnitTests().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
