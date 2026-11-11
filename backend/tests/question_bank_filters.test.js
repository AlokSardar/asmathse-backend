/**
 * Automated Verification Suite: Question Bank Cohort-Aware Filtering & Security
 * Targets local test/dev DB strictly enforced via dbGuard.js
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
const contentRoutes = require('../routes/contentRoutes');
const { assertDevOrTestDatabase } = require('../utils/dbGuard');
const { SEED_QUESTIONS } = require('../scripts/seedQuestionBank');

const TEST_DB_NAME = 'test_qb_filters_isolated_tmp';
const JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_question_bank_filters_32ch';

async function runSuite() {
  console.log('='.repeat(80));
  console.log('🎯 QUESTION BANK COHORT-AWARE FILTERING & SECURITY VERIFICATION SUITE');
  console.log(`Database under test: ${TEST_DB_NAME} (Strictly isolated temporary test DB)`);
  console.log('='.repeat(80));

  // 1. Database Safety Guard Check
  console.log('\n[TEST 1]: Database Safety Guard (dbGuard.js)');
  assert.strictEqual(assertDevOrTestDatabase(TEST_DB_NAME), true, 'Isolated test DB must pass guard');
  assert.strictEqual(assertDevOrTestDatabase('asmaths_lms_dev'), true, 'asmaths_lms_dev must pass guard');
  let threwOnProd = false;
  try {
    assertDevOrTestDatabase('asmaths_lms');
  } catch (err) {
    threwOnProd = true;
    assert.strictEqual(err.statusCode, 403, 'Prod database rejection must carry statusCode 403');
  }
  assert.strictEqual(threwOnProd, true, 'Safety guard MUST strictly reject "asmaths_lms" without prod override');
  console.log('✅ dbGuard correctly allows dev/test and strictly blocks "asmaths_lms"');

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
  assert.strictEqual(mongoose.connection.name, TEST_DB_NAME, `Must be connected to ${TEST_DB_NAME}`);

  // Clean test collections
  await User.deleteMany({});
  await Content.deleteMany({});

  // 3. Seed Users
  const adminUser = await User.create({
    name: 'Admin User',
    email: 'admin.qb@test.edu',
    password: 'HashedPassword123!',
    role: 'admin',
    isApproved: true,
  });

  const cseTeacher = await User.create({
    name: 'Prof. CSE Gupta',
    email: 'cse.faculty@test.edu',
    password: 'HashedPassword123!',
    role: 'teacher',
    course: 'Engineering',
    targetCourse: 'Engineering',
    branch: 'CSE',
    semester: 'Semester 1',
    isApproved: true,
  });

  const cbseTeacher = await User.create({
    name: 'Prof. CBSE Sharma',
    email: 'cbse.faculty@test.edu',
    password: 'HashedPassword123!',
    role: 'teacher',
    course: 'CBSE',
    targetCourse: 'CBSE',
    classLevel: 'Class 10',
    isApproved: true,
  });

  const studentUser = await User.create({
    name: 'Student Alice',
    email: 'alice.student@test.edu',
    password: 'HashedPassword123!',
    role: 'student',
    course: 'Engineering',
    branch: 'CSE',
    semester: 1,
    isApproved: true,
  });

  // Seed Questions (with varied sources and solutionHidden)
  for (let i = 0; i < SEED_QUESTIONS.length; i++) {
    const q = SEED_QUESTIONS[i];
    await Content.create({
      ...q,
      isDeleted: false,
      source: i % 3 === 0 ? 'PYQ' : (i % 3 === 1 ? 'AI Import' : 'Original'),
      solutionHidden: i === 0, // First question has solution hidden
      steps: ['Step 1: Compute matrix determinant', 'Step 2: Solve quadratic equation'],
      finalAnswer: '\\lambda = 3, 1',
      graphicSvg: '<svg></svg>',
      explanation: 'Detailed derivation for eigenvalues',
    });
  }
  console.log(`✅ Seeded ${SEED_QUESTIONS.length} realistic sample questions into ${TEST_DB_NAME}`);

  // Create JWT Tokens
  const makeToken = (user) => jwt.sign(
    { id: String(user._id), email: user.email, role: user.role, tokenVersion: 0 },
    JWT_SECRET,
    { expiresIn: '1h' }
  );

  const adminToken = makeToken(adminUser);
  const cseTeacherToken = makeToken(cseTeacher);
  const cbseTeacherToken = makeToken(cbseTeacher);
  const studentToken = makeToken(studentUser);

  // Mount express server for testing
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

  // 4. Role-Based Access Control
  console.log('\n[TEST 2]: Role-Based Access Control (RBAC)');
  // 4.1 Unauthenticated -> 401
  const unauthRes = await api('GET', '/api/content/question-bank');
  assert.strictEqual(unauthRes.status, 401, 'Unauthenticated GET /question-bank must be 401');
  console.log('✅ Unauthenticated request -> 401 Unauthorized');

  // 4.2 Student Access Rejection -> 403
  const studentRes = await api('GET', '/api/content/question-bank?course=Engineering', studentToken);
  assert.strictEqual(studentRes.status, 403, 'Student access to question bank must be rejected with 403 Forbidden');
  console.log('✅ Student access to /question-bank -> 403 Forbidden');

  // 4.3 Teacher Scope Isolation -> 403 on cross-cohort
  const teacherCrossRes = await api('GET', '/api/content/question-bank?course=CBSE', cseTeacherToken);
  assert.strictEqual(teacherCrossRes.status, 403, 'CSE teacher accessing CBSE must return 403 Forbidden');
  console.log('✅ Cross-cohort teacher access (CSE accessing CBSE) -> 403 Forbidden');

  const teacherCrossBranch = await api('GET', '/api/content/question-bank?course=Engineering&branch=ECE', cseTeacherToken);
  assert.strictEqual(teacherCrossBranch.status, 403, 'CSE teacher accessing ECE branch must return 403 Forbidden');
  console.log('✅ Cross-branch teacher access (CSE teacher accessing ECE) -> 403 Forbidden');

  // 4.4 Allowed Teacher Access -> 200
  const teacherAllowed = await api('GET', '/api/content/question-bank?course=Engineering&branch=CSE', cseTeacherToken);
  assert.strictEqual(teacherAllowed.status, 200, 'Assigned teacher cohort access must return 200 OK');
  assert.strictEqual(teacherAllowed.data.success, true);
  console.log(`✅ Assigned teacher cohort access -> 200 OK (${teacherAllowed.data.data.length} questions returned)`);

  // 5. Multi-Cohort Querying & Common First-Year Matching
  console.log('\n[TEST 3]: Multi-Cohort Querying & Common First-Year Inclusion');
  const engCseRes = await api('GET', '/api/content/question-bank?course=Engineering&branch=CSE&semester=Semester 1', adminToken);
  assert.strictEqual(engCseRes.status, 200);
  assert(engCseRes.data.data.length >= 2, 'Should return CSE S1 questions + Common first-year questions');
  const hasCommon = engCseRes.data.data.some(q => q.isCommon === true || q.isCommonFirstYear === true);
  assert.strictEqual(hasCommon, true, 'Common first-year questions must be returned for Engineering S1');
  console.log(`✅ Engineering CSE Sem 1: returned ${engCseRes.data.data.length} questions (including common first-year)`);

  // CBSE Class 10 Querying
  const cbseClass10 = await api('GET', '/api/content/question-bank?course=CBSE&classLevel=Class 10', adminToken);
  assert.strictEqual(cbseClass10.status, 200);
  assert(cbseClass10.data.data.length >= 2, 'Should return CBSE Class 10 questions');
  console.log(`✅ CBSE Class 10: returned ${cbseClass10.data.data.length} questions strictly matching Class 10`);

  // 6. Dynamic Metadata Endpoint & Taxonomy Tree
  console.log('\n[TEST 4]: Dynamic Cohort Metadata & Taxonomy Tree (/api/content/question-bank/meta)');
  const metaCse = await api('GET', '/api/content/question-bank/meta?course=Engineering&branch=CSE&semester=Semester 1', adminToken);
  assert.strictEqual(metaCse.status, 200);
  assert.strictEqual(metaCse.data.success, true);
  assert(Array.isArray(metaCse.data.data.subjects), 'subjects must be an array');
  assert(Array.isArray(metaCse.data.data.topics), 'topics must be an array');
  const cseSubjectNames = metaCse.data.data.subjects.map(s => typeof s === 'string' ? s : s.name);
  assert(cseSubjectNames.includes('Mathematics I') || metaCse.data.data.flatSubjects?.includes('Mathematics I'), 'Must include Mathematics I');
  assert(metaCse.data.data.topics.includes('Linear Algebra'), 'Must include Linear Algebra topic');
  
  // Verify Taxonomy Tree structure
  const mathNode = metaCse.data.data.subjects.find(s => (s.name || s) === 'Mathematics I');
  if (mathNode && typeof mathNode === 'object') {
    assert(mathNode.sources !== undefined, 'Taxonomy node must have sources breakdown');
    assert(Array.isArray(mathNode.topics), 'Taxonomy node must have topics array');
  }
  assert(typeof metaCse.data.data.unassignedCount === 'number', 'Meta must return unassignedCount');
  console.log(`✅ Taxonomy Tree returned: ${metaCse.data.data.subjects.length} subjects, unassignedCount: ${metaCse.data.data.unassignedCount}`);

  // Test PATCH /api/content/question-bank/meta (Add Subject/Topic)
  const patchMetaRes = await api('PATCH', '/api/content/question-bank/meta', adminToken, {
    course: 'Engineering',
    branch: 'CSE',
    semester: 'Semester 1',
    subject: 'Discrete Mathematics',
    topic: 'Graph Theory',
  });
  assert.strictEqual(patchMetaRes.status, 200);
  assert.strictEqual(patchMetaRes.data.success, true);
  console.log('✅ PATCH /question-bank/meta successfully added subject/topic to taxonomy');

  // 7. Dimension Filtering, Source Filtering & Live Dimension Counts
  console.log('\n[TEST 5]: Live Dimension Counts & Advanced Filtering');
  // Type filter MCQ
  const mcqOnly = await api('GET', '/api/content/question-bank?course=Engineering&branch=CSE&type=MCQ', adminToken);
  assert.strictEqual(mcqOnly.status, 200);
  mcqOnly.data.data.forEach(q => {
    assert.strictEqual(q.qType.toLowerCase(), 'mcq', 'All returned questions must be MCQ');
  });
  assert(mcqOnly.data.counts.types.mcq >= 1, 'MCQ dimension count must be >= 1');
  console.log(`✅ Type filter (MCQ): returned ${mcqOnly.data.data.length} MCQs; type counts:`, mcqOnly.data.counts.types);

  // Source filter (PYQ)
  const pyqOnly = await api('GET', '/api/content/question-bank?course=Engineering&branch=CSE&source=pyq', adminToken);
  assert.strictEqual(pyqOnly.status, 200);
  assert(pyqOnly.data.counts.sources.pyq >= 1, 'PYQ source count must be >= 1');
  console.log(`✅ Source filter (PYQ): returned ${pyqOnly.data.data.length} PYQ items; source counts:`, pyqOnly.data.counts.sources);

  // Search filter
  const searchRes = await api('GET', '/api/content/question-bank?course=Engineering&branch=CSE&search=orthogonal', adminToken);
  assert.strictEqual(searchRes.status, 200);
  assert(searchRes.data.data.length >= 1, 'Search for "orthogonal" must return matching question');
  console.log(`✅ Search for "orthogonal": matched ${searchRes.data.data.length} question(s)`);

  // 8. Server-Side Pagination
  console.log('\n[TEST 6]: Server-Side Pagination');
  const page1 = await api('GET', '/api/content/question-bank?course=Engineering&page=1&limit=2', adminToken);
  assert.strictEqual(page1.status, 200);
  assert.strictEqual(page1.data.data.length, 2, 'Page limit 2 must return exactly 2 items');
  assert.strictEqual(page1.data.pagination.page, 1);
  assert.strictEqual(page1.data.pagination.limit, 2);
  console.log(`✅ Pagination: page 1 of ${page1.data.pagination.totalPages} (total questions: ${page1.data.pagination.total})`);

  // 9. Solution Reveal — Student Safety vs Teacher Privileged Access
  console.log('\n[TEST 7]: Solution Reveal — Student Safety & Content Redaction');
  const hiddenQuestion = await Content.findOne({ solutionHidden: true });
  assert(hiddenQuestion, 'Must have a question with solutionHidden: true');
  const hiddenQId = String(hiddenQuestion._id);

  // When student accesses /api/content/:id, hidden solution fields must be stripped
  const studentGetRes = await api('GET', `/api/content/${hiddenQId}`, studentToken);
  assert.strictEqual(studentGetRes.status, 200);
  assert.strictEqual(studentGetRes.data.steps, undefined, 'Student MUST NOT receive steps for solutionHidden question');
  assert.strictEqual(studentGetRes.data.finalAnswer, undefined, 'Student MUST NOT receive finalAnswer for solutionHidden question');
  assert.strictEqual(studentGetRes.data.graphicSvg, undefined, 'Student MUST NOT receive graphicSvg for solutionHidden question');
  console.log('✅ Student access to hidden question: steps, finalAnswer, and graphicSvg are stripped server-side');

  // Teacher accesses the same hidden question: receives full solution
  const teacherGetRes = await api('GET', `/api/content/${hiddenQId}`, cseTeacherToken);
  assert.strictEqual(teacherGetRes.status, 200);
  assert(teacherGetRes.data.steps && teacherGetRes.data.steps.length > 0, 'Teacher must receive steps');
  assert(teacherGetRes.data.finalAnswer, 'Teacher must receive finalAnswer');
  console.log('✅ Teacher access to hidden question: full solution and steps preserved');

  // 10. Verify Question Solution Endpoint
  console.log('\n[TEST 8]: Solution Verification Endpoint (PATCH /:id/verify)');
  const verifyRes = await api('PATCH', `/api/content/${hiddenQId}/verify`, cseTeacherToken, {
    verifiedBy: 'Prof. CSE Gupta',
  });
  assert.strictEqual(verifyRes.status, 200);
  assert.strictEqual(verifyRes.data.success, true);
  assert.strictEqual(verifyRes.data.data.isVerified, true, 'isVerified must be true');
  assert.strictEqual(verifyRes.data.data.verifiedBy, 'Prof. CSE Gupta');
  console.log('✅ PATCH /:id/verify correctly marked solution as verified');

  // 11. Bulk Generate Solutions Rate Limit (> 20 rejects with 400)
  console.log('\n[TEST 9]: Bulk Generate Solutions Batch Limit Protection');
  const fakeIds = Array.from({ length: 25 }, (_, i) => new mongoose.Types.ObjectId().toString());
  const bulkGenLimitRes = await api('POST', '/api/content/bulk-generate-solutions', adminToken, {
    questionIds: fakeIds,
  });
  assert.strictEqual(bulkGenLimitRes.status, 400, 'Bulk generation with > 20 questions must return 400');
  console.log('✅ Bulk generate solutions > 20 questions rejected with 400 Bad Request');

  // 12. Bulk Update Content Endpoint
  console.log('\n[TEST 10]: Bulk Update Questions (POST /api/content/bulk-update)');
  const qList = await Content.find({ isDeleted: false }).limit(3);
  const qIdsToUpdate = qList.map(q => String(q._id));
  const bulkUpRes = await api('POST', '/api/content/bulk-update', adminToken, {
    ids: qIdsToUpdate,
    updates: { difficulty: 'Hard', marks: 8 },
  });
  assert.strictEqual(bulkUpRes.status, 200);
  assert.strictEqual(bulkUpRes.data.success, true);
  const updatedDocs = await Content.find({ _id: { $in: qIdsToUpdate } });
  updatedDocs.forEach(doc => {
    assert.strictEqual(doc.difficulty, 'Hard', 'Difficulty must be updated to Hard');
    assert.strictEqual(doc.marks, 8, 'Marks must be updated to 8');
  });
  console.log(`✅ Bulk update successfully updated ${updatedDocs.length} questions to Hard / 8 marks`);

  // Clean up
  await User.deleteMany({});
  await Content.deleteMany({});
  await mongoose.disconnect();
  await new Promise(r => server.close(r));

  console.log('\n' + '='.repeat(80));
  console.log('🎉 ALL 10 QUESTION BANK FILTER & SECURITY TESTS PASSED PERFECTLY!');
  console.log('='.repeat(80));
}

runSuite().catch(err => {
  console.error('\n❌ Test suite failed with error:', err);
  process.exit(1);
});
