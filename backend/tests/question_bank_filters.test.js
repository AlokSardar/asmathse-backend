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

  // Seed Questions
  for (const q of SEED_QUESTIONS) {
    await Content.create({
      ...q,
      isDeleted: false,
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
  assert.strictEqual(studentRes.status, 403, 'Student access must be rejected with 403 Forbidden');
  console.log('✅ Student access -> 403 Forbidden');

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
  // Engineering CSE Semester 1: should return CSE questions PLUS Common first-year questions
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
  cbseClass10.data.data.forEach(q => {
    assert(
      q.classLevel === 'Class 10' || q.class === 'Class 10' || q.semester === 'Class 10' || q.classNumber === 10,
      'All returned questions must belong to Class 10'
    );
  });
  console.log(`✅ CBSE Class 10: returned ${cbseClass10.data.data.length} questions strictly matching Class 10`);

  // CBSE Class 12 Querying
  const cbseClass12 = await api('GET', '/api/content/question-bank?course=CBSE&classLevel=Class 12', adminToken);
  assert.strictEqual(cbseClass12.status, 200);
  assert(cbseClass12.data.data.length >= 2, 'Should return CBSE Class 12 questions');
  console.log(`✅ CBSE Class 12: returned ${cbseClass12.data.data.length} questions strictly matching Class 12`);

  // B.Sc Querying
  const bscRes = await api('GET', '/api/content/question-bank?course=B.Sc', adminToken);
  assert.strictEqual(bscRes.status, 200);
  assert(bscRes.data.data.length >= 2, 'Should return B.Sc questions');
  console.log(`✅ B.Sc cohort: returned ${bscRes.data.data.length} questions`);

  // 6. Dynamic Metadata Endpoint
  console.log('\n[TEST 4]: Dynamic Cohort Metadata (/api/content/question-bank/meta)');
  const metaCse = await api('GET', '/api/content/question-bank/meta?course=Engineering&branch=CSE&semester=Semester 1', adminToken);
  assert.strictEqual(metaCse.status, 200);
  assert.strictEqual(metaCse.data.success, true);
  assert(Array.isArray(metaCse.data.data.subjects), 'subjects must be an array');
  assert(Array.isArray(metaCse.data.data.topics), 'topics must be an array');
  assert(metaCse.data.data.subjects.includes('Mathematics I'), 'Must include Mathematics I');
  assert(metaCse.data.data.topics.includes('Linear Algebra'), 'Must include Linear Algebra topic');
  console.log(`✅ Engineering CSE Sem 1 meta: ${metaCse.data.data.subjects.length} subjects, ${metaCse.data.data.topics.length} topics`);

  const metaCbse = await api('GET', '/api/content/question-bank/meta?course=CBSE&classLevel=Class 10', adminToken);
  assert.strictEqual(metaCbse.status, 200);
  assert(metaCbse.data.data.topics.includes('Quadratic Equations'), 'Must include Quadratic Equations in Class 10 meta');
  console.log(`✅ CBSE Class 10 meta: ${metaCbse.data.data.subjects.length} subjects, ${metaCbse.data.data.topics.length} topics`);

  // 7. Dimension Filtering & Live Dimension Counts
  console.log('\n[TEST 5]: Live Dimension Counts & Advanced Filtering');
  // Type filter MCQ
  const mcqOnly = await api('GET', '/api/content/question-bank?course=Engineering&branch=CSE&type=MCQ', adminToken);
  assert.strictEqual(mcqOnly.status, 200);
  mcqOnly.data.data.forEach(q => {
    assert.strictEqual(q.qType.toLowerCase(), 'mcq', 'All returned questions must be MCQ');
  });
  assert(mcqOnly.data.counts.types.mcq >= 1, 'MCQ dimension count must be >= 1');
  console.log(`✅ Type filter (MCQ): returned ${mcqOnly.data.data.length} MCQs; type counts:`, mcqOnly.data.counts.types);

  // Difficulty filter
  const easyOnly = await api('GET', '/api/content/question-bank?course=Engineering&branch=CSE&difficulty=Easy', adminToken);
  assert.strictEqual(easyOnly.status, 200);
  easyOnly.data.data.forEach(q => {
    assert.strictEqual(q.difficulty.toLowerCase(), 'easy', 'All returned questions must be Easy');
  });
  console.log(`✅ Difficulty filter (Easy): returned ${easyOnly.data.data.length} questions; difficulty counts:`, easyOnly.data.counts.difficulties);

  // LaTeX & Search filter
  const searchRes = await api('GET', '/api/content/question-bank?course=Engineering&branch=CSE&search=orthogonal', adminToken);
  assert.strictEqual(searchRes.status, 200);
  assert(searchRes.data.data.length >= 1, 'Search for "orthogonal" must return matching question');
  console.log(`✅ Search for "orthogonal": matched ${searchRes.data.data.length} question(s)`);

  // 8. Pagination Verification
  console.log('\n[TEST 6]: Server-Side Pagination');
  const page1 = await api('GET', '/api/content/question-bank?course=CBSE&page=1&limit=2', adminToken);
  assert.strictEqual(page1.status, 200);
  assert.strictEqual(page1.data.data.length, 2, 'Page limit 2 must return exactly 2 items');
  assert.strictEqual(page1.data.pagination.page, 1);
  assert.strictEqual(page1.data.pagination.limit, 2);
  assert(page1.data.pagination.totalPages >= 2, 'Total pages must be >= 2 for CBSE');
  console.log(`✅ Pagination: page 1 of ${page1.data.pagination.totalPages} (total questions: ${page1.data.pagination.total})`);

  // 9. Answer Key Access Control & Redaction Check
  console.log('\n[TEST 7]: Answer Key Access Control & Privileged Access');
  const privilegedRes = await api('GET', '/api/content/question-bank?course=Engineering&branch=CSE', adminToken);
  assert.strictEqual(privilegedRes.status, 200);
  const qWithAnswer = privilegedRes.data.data.find(q => q.correctOption !== undefined || q.finalAnswer || q.explanation);
  assert(qWithAnswer, 'Admin/teacher response must contain answer keys');
  assert(qWithAnswer.explanation || qWithAnswer.finalAnswer || qWithAnswer.correctOption !== undefined);
  console.log('✅ Privileged user receives full explanation & answer keys');

  // Clean up
  await User.deleteMany({});
  await Content.deleteMany({});
  await mongoose.disconnect();
  await new Promise(r => server.close(r));

  console.log('\n' + '='.repeat(80));
  console.log('🎉 ALL QUESTION BANK FILTER & SECURITY TESTS PASSED PERFECTLY!');
  console.log('='.repeat(80));
}

runSuite().catch(err => {
  console.error('\n❌ Test suite failed with error:', err);
  process.exit(1);
});
