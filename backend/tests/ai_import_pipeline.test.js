/**
 * Automated Verification Suite: AI Import Pipeline Backend Endpoints
 * Tests:
 * 1. dbGuard validation & security
 * 2. RBAC (Unauthenticated 401, Student 403, Teacher Cross-Cohort 403)
 * 3. POST /api/content/bulk-import:
 *    - Canonical cohort normalizations (semester: '1' -> 'Semester 1', marks: '5' -> 5, qType: 'mcq' -> 'MCQ')
 *    - isCommon auto-computation for Engineering Sem 1 Math
 *    - Duplicate conflict handling ('skip' vs 'import_anyway' with duplicate_of tag)
 * 4. POST /api/content/check-duplicates (no regex injection, content hash + Jaccard >= 0.85)
 * 5. GET /api/content/import-history (sessions pagination + stats aggregation)
 */

const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const assert = require('assert');
const path = require('path');
const http = require('http');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const User = require('../models/User');
const Content = require('../models/Content');
const ImportSession = require('../models/ImportSession');
const contentRoutes = require('../routes/contentRoutes');
const { assertDevOrTestDatabase } = require('../utils/dbGuard');

const TEST_DB_NAME = 'test_ai_import_pipeline_tmp';
const JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_ai_import_pipeline_32ch';

async function runSuite() {
  console.log('='.repeat(80));
  console.log('✨ AI IMPORT PIPELINE & NORMALIZATION VERIFICATION SUITE');
  console.log(`Database under test: ${TEST_DB_NAME} (Strictly isolated temporary test DB)`);
  console.log('='.repeat(80));

  // 1. dbGuard Safety Check
  console.log('\n[TEST 1]: Database Safety Guard (dbGuard.js)');
  assert.strictEqual(assertDevOrTestDatabase(TEST_DB_NAME), true);
  assert.strictEqual(assertDevOrTestDatabase('asmaths_lms_dev'), true);
  let threwOnProd = false;
  try {
    assertDevOrTestDatabase('asmaths_lms');
  } catch (err) {
    threwOnProd = true;
    assert.strictEqual(err.statusCode, 403);
  }
  assert.strictEqual(threwOnProd, true, 'Safety guard must strictly block asmaths_lms');
  console.log('✅ dbGuard correctly allows dev/test and strictly blocks production');

  // 2. Connect to Test DB
  const baseUri = process.env.MONGO_URI;
  assert(baseUri, 'MONGO_URI must be set in .env');
  let targetUri = baseUri;
  const parsed = new URL(baseUri.startsWith('mongodb+srv://') ? baseUri.replace('mongodb+srv://', 'http://') : baseUri);
  const host = parsed.host;
  const auth = parsed.username ? `${parsed.username}:${parsed.password}@` : '';
  const search = parsed.search || '';
  if (baseUri.startsWith('mongodb+srv://')) {
    targetUri = `mongodb+srv://${auth}${host}/${TEST_DB_NAME}${search}`;
  } else {
    targetUri = `mongodb://${auth}${host}/${TEST_DB_NAME}${search}`;
  }

  await mongoose.connect(targetUri);
  assert.strictEqual(mongoose.connection.name, TEST_DB_NAME);

  // Clean test collections
  await User.deleteMany({});
  await Content.deleteMany({});
  await ImportSession.deleteMany({});

  // 3. Seed Users
  const adminUser = await User.create({
    name: 'Admin Supervisor',
    email: 'admin.import@test.edu',
    password: 'HashedPassword123!',
    role: 'admin',
    isApproved: true,
  });

  const cseTeacher = await User.create({
    name: 'Prof. CSE Faculty',
    email: 'cse.import@test.edu',
    password: 'HashedPassword123!',
    role: 'teacher',
    course: 'Engineering',
    targetCourse: 'Engineering',
    branch: 'CSE',
    isApproved: true,
  });

  const studentUser = await User.create({
    name: 'Student Bob',
    email: 'bob.import@test.edu',
    password: 'HashedPassword123!',
    role: 'student',
    course: 'Engineering',
    isApproved: true,
  });

  // Tokens
  const makeToken = (user) => jwt.sign(
    { id: String(user._id), email: user.email, role: user.role, tokenVersion: 0 },
    JWT_SECRET,
    { expiresIn: '1h' }
  );

  const adminToken = makeToken(adminUser);
  const teacherToken = makeToken(cseTeacher);
  const studentToken = makeToken(studentUser);

  // Setup express test server
  const app = express();
  app.use(express.json());
  app.use('/api/content', contentRoutes);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  async function api(method, urlPath, token, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const res = await fetch(`${baseUrl}${urlPath}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    let data;
    try {
      data = await res.json();
    } catch {
      data = await res.text();
    }
    return { status: res.status, data };
  }

  // 4. RBAC & Access Control
  console.log('\n[TEST 2]: RBAC & Endpoint Protection');
  // Unauth -> 401
  const unauthRes = await api('POST', '/api/content/bulk-import', null, { questions: [] });
  assert.strictEqual(unauthRes.status, 401);
  console.log('✅ POST /api/content/bulk-import -> 401 without token');

  // Student -> 403
  const studentRes = await api('POST', '/api/content/bulk-import', studentToken, { questions: [{ text: 'Q1' }] });
  assert.strictEqual(studentRes.status, 403);
  console.log('✅ Student POST /api/content/bulk-import -> 403 Forbidden');

  // Teacher Cross-Course -> 403
  const teacherCross = await api('POST', '/api/content/bulk-import', teacherToken, {
    course: 'CBSE',
    questions: [{ questionText: 'Prove Pythagoras theorem' }],
  });
  assert.strictEqual(teacherCross.status, 403);
  console.log('✅ Teacher cross-cohort import (CSE faculty importing CBSE) -> 403 Forbidden');

  // 5. POST /api/content/bulk-import (Normalization & Storage)
  console.log('\n[TEST 3]: Bulk Import Normalization & Storage');
  // Seed an existing question in the bank for duplicate testing
  const existingQ = await Content.create({
    id: 'QB-EXISTING-01',
    customId: 'QB-EXISTING-01',
    title: 'Cayley-Hamilton Theorem Statement',
    type: 'question',
    qType: 'Subjective',
    course: 'Engineering',
    branch: 'CSE',
    semester: 'Semester 1',
    subject: 'Mathematics I',
    marks: 4,
    questionText: 'State and prove the Cayley-Hamilton theorem for any square matrix $A$.',
  });

  const importPayload = {
    sessionId: 'TEST-SESSION-001',
    fileName: 'MAKAUT_Maths_2024.pdf',
    course: 'Engineering',
    branch: 'CSE',
    semester: 1, // Notice bare number 1 -> must normalize to 'Semester 1'
    subject: 'Mathematics I',
    questions: [
      {
        questionText: 'Evaluate the surface integral $\\iint_S \\vec{F} \\cdot \\hat{n} \\, dS$ using Gauss divergence theorem.',
        marks: '8', // String -> must normalize to Number 8
        qType: 'subjective', // Lowercase -> must normalize to 'Subjective'
        difficulty: 'Hard',
        topic: 'Vector Calculus',
        isCommon: undefined, // Must auto-compute true for Engineering Sem 1 Math
      },
      {
        questionText: 'Which of the following matrices is orthogonal?',
        options: ['$\\begin{pmatrix} 1 & 0 \\\\ 0 & 1 \\end{pmatrix}$', '$\\begin{pmatrix} 1 & 1 \\\\ 0 & 1 \\end{pmatrix}$'],
        correctOption: 0,
        marks: 2,
        qType: 'mcq', // Must normalize to 'MCQ'
        difficulty: 'Easy',
        topic: 'Linear Algebra',
      },
      {
        // Near-identical text to existing question -> Duplicate test with 'import_anyway'
        questionText: 'State and prove the Cayley Hamilton theorem for any square matrix $A$.',
        marks: 4,
        qType: 'Subjective',
        difficulty: 'Medium',
        topic: 'Linear Algebra',
        isDuplicate: true,
        duplicateAction: 'import_anyway',
        duplicateMatchId: existingQ.id,
      },
      {
        // Duplicate with 'skip' -> Must NOT be saved
        questionText: 'State and prove the Cayley Hamilton theorem for any square matrix $A$.',
        marks: 4,
        duplicateAction: 'skip',
        duplicateMatchId: existingQ.id,
      },
    ],
  };

  const importRes = await api('POST', '/api/content/bulk-import', adminToken, importPayload);
  assert.strictEqual(importRes.status, 200);
  assert.strictEqual(importRes.data.success, true);
  assert.strictEqual(importRes.data.imported, 3, '3 items must be imported (1 skipped)');
  assert.strictEqual(importRes.data.skipped, 1, '1 duplicate item must be skipped');
  console.log(`✅ Bulk Import completed: ${importRes.data.imported} imported, ${importRes.data.skipped} skipped`);

  // Verify in MongoDB
  const savedItems = await Content.find({ importSessionId: 'TEST-SESSION-001' });
  assert.strictEqual(savedItems.length, 3);

  // Check Gauss theorem normalization
  const gaussQ = savedItems.find((q) => q.topic === 'Vector Calculus');
  assert(gaussQ, 'Gauss question must exist');
  assert.strictEqual(gaussQ.semester, 'Semester 1', 'Semester must be normalized string "Semester 1"');
  assert.strictEqual(gaussQ.marks, 8, 'Marks must be normalized Number 8');
  assert.strictEqual(gaussQ.qType, 'Subjective', 'qType must be canonical "Subjective"');
  assert.strictEqual(gaussQ.isCommon, true, 'isCommon must auto-compute true for Eng Sem 1 Math');
  assert.strictEqual(gaussQ.importSource, 'AI Import', 'importSource must be "AI Import"');
  console.log('✅ Normalized semester, marks, qType, and isCommon verified in MongoDB');

  // Check duplicate tagged question (Amendment 5)
  const dupTaggedQ = savedItems.find((q) => q.duplicate_of === existingQ.id);
  assert(dupTaggedQ, 'Imported duplicate question must carry duplicate_of tag pointing to existing question');
  assert.strictEqual(dupTaggedQ.duplicate_of, existingQ.id);
  console.log('✅ Duplicate imported with duplicate_of tag pointing to existing record');

  // 6. POST /api/content/check-duplicates
  console.log('\n[TEST 4]: Duplicate Checking Strategy');
  const dupCheckRes = await api('POST', '/api/content/check-duplicates', adminToken, {
    course: 'Engineering',
    questions: [
      {
        id: 'CANDIDATE-01',
        questionText: 'State and prove the Cayley-Hamilton theorem for any square matrix $A$.',
      },
      {
        id: 'CANDIDATE-02',
        questionText: 'Completely unique and brand new question regarding Riemann zeta function hypothesis.',
      },
    ],
  });

  assert.strictEqual(dupCheckRes.status, 200);
  assert.strictEqual(dupCheckRes.data.success, true);
  assert.strictEqual(dupCheckRes.data.duplicateCount, 1, 'Must detect 1 duplicate');
  assert(
    dupCheckRes.data.duplicates[0].matchId === existingQ.id ||
      dupCheckRes.data.duplicates[0].matchId.startsWith('QB-AI-'),
    'Must match Cayley-Hamilton question in database'
  );
  assert(dupCheckRes.data.duplicates[0].similarity >= 85, 'Similarity must be >= 85%');
  console.log(`✅ Duplicate check detected match with ${dupCheckRes.data.duplicates[0].similarity}% similarity`);

  // 7. GET /api/content/import-history
  console.log('\n[TEST 5]: Import History & Statistics');
  const historyRes = await api('GET', '/api/content/import-history?course=Engineering', adminToken);
  assert.strictEqual(historyRes.status, 200);
  assert.strictEqual(historyRes.data.success, true);
  assert(Array.isArray(historyRes.data.history), 'history must be array');
  assert(historyRes.data.history.length >= 1, 'Must have at least 1 history record');
  assert.strictEqual(historyRes.data.history[0].sessionId, 'TEST-SESSION-001');
  assert.strictEqual(historyRes.data.history[0].fileName, 'MAKAUT_Maths_2024.pdf');
  assert(historyRes.data.stats.totalAllTime >= 3, 'Stats totalAllTime must be >= 3');
  assert(historyRes.data.stats.byQType.Subjective >= 2, 'Subjective count must be >= 2');
  console.log('✅ Import history & aggregate stats successfully retrieved');

  // Clean up
  await User.deleteMany({});
  await Content.deleteMany({});
  await ImportSession.deleteMany({});
  await mongoose.disconnect();
  await new Promise((r) => server.close(r));

  console.log('\n' + '='.repeat(80));
  console.log('🎉 ALL AI IMPORT PIPELINE TESTS PASSED PERFECTLY!');
  console.log('='.repeat(80));
}

runSuite().catch((err) => {
  console.error('\n❌ Test suite failed with error:', err);
  process.exit(1);
});
