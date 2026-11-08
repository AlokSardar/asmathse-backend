const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const assert = require('assert');
const path = require('path');
const http = require('http');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const User = require('../models/User');
const Evaluation = require('../models/Evaluation');
const evaluationRoutes = require('../routes/evaluationRoutes');

const TEMP_DB_NAME = 'test_eval_security_hotfix_tmp';
const JWT_SECRET = process.env.JWT_SECRET || 'asmaths_secret_jwt_key_2026_cluster0';

async function runTest() {
  const baseUri = process.env.MONGO_URI;
  assert(baseUri, 'MONGO_URI must be set in .env');

  // Hard safety assertion: strictly require a temporary test database, NEVER asmaths_lms
  let targetUri = baseUri;
  const parsed = new URL(baseUri.startsWith('mongodb+srv://') ? baseUri.replace('mongodb+srv://', 'http://') : baseUri);
  const host = parsed.host;
  const auth = parsed.username ? `${parsed.username}:${parsed.password}@` : '';
  const search = parsed.search || '';
  if (baseUri.startsWith('mongodb+srv://')) {
    targetUri = `mongodb+srv://${auth}${host}/${TEMP_DB_NAME}${search}`;
  } else {
    targetUri = `mongodb://${auth}${host}/${TEMP_DB_NAME}${search}`;
  }

  console.log('='.repeat(75));
  console.log('🔒 EVALUATION SECURITY HOTFIX VERIFICATION SUITE');
  console.log(`Database under test : ${TEMP_DB_NAME} (Strictly isolated temporary DB)`);
  console.log('='.repeat(75));

  await mongoose.connect(targetUri);
  assert.strictEqual(mongoose.connection.name, TEMP_DB_NAME, `Must be connected to ${TEMP_DB_NAME}`);

  // Reset collections in temporary DB
  await User.deleteMany({});
  await Evaluation.deleteMany({});

  // 1. Seed accounts
  const engStudent = await User.create({
    name: 'Alice Eng',
    email: 'alice.eng@test.edu',
    password: 'HashedPassword123!',
    role: 'student',
    course: 'Engineering',
    branch: 'CSE',
    semester: 1,
    isApproved: true,
  });

  const bscStudent = await User.create({
    name: 'Bob BSc',
    email: 'bob.bsc@test.edu',
    password: 'HashedPassword123!',
    role: 'student',
    course: 'B.Sc',
    branch: 'Maths Honours',
    semester: 1,
    isApproved: true,
  });

  const engTeacher = await User.create({
    name: 'Prof. Mukherjee',
    email: 'prof.mukherjee@test.edu',
    password: 'HashedPassword123!',
    role: 'teacher',
    course: 'Engineering',
    branch: 'CSE',
    isApproved: true,
  });

  const bscTeacher = await User.create({
    name: 'Prof. Banerjee',
    email: 'prof.banerjee@test.edu',
    password: 'HashedPassword123!',
    role: 'teacher',
    course: 'B.Sc',
    branch: 'Maths Honours',
    isApproved: true,
  });

  const adminUser = await User.create({
    name: 'Admin User',
    email: 'admin.sec@test.edu',
    password: 'HashedPassword123!',
    role: 'admin',
    isApproved: true,
  });

  // 2. Seed evaluations
  // Alice's published evaluation
  const alicePublishedEval = await Evaluation.create({
    id: 'eval_alice_pub',
    studentId: String(engStudent._id),
    studentName: engStudent.name,
    studentEmail: engStudent.email,
    testId: 'test_eng_101',
    testTitle: 'Engineering Calculus',
    course: 'Engineering',
    branch: 'CSE',
    sem: 1,
    totalMarks: 48,
    maxMarks: 50,
    marks: 48,
    published: true, // PUBLISHED
    publishedAt: new Date(),
    answerKeySnapshot: { secretSolution: 'CLASSIFIED_FORMULA' },
    questionBlocks: [
      { q_no: 'Q1', maxMarks: 10, marksAwarded: 10, standardAnswer: 'SECRET_ANSWER_KEY', rubric: 'SECRET_RUBRIC' }
    ]
  });

  // Alice's draft/unpublished evaluation
  const aliceUnpublishedEval = await Evaluation.create({
    id: 'eval_alice_unpub',
    studentId: String(engStudent._id),
    studentName: engStudent.name,
    studentEmail: engStudent.email,
    testId: 'test_eng_102',
    testTitle: 'Engineering Linear Algebra (Draft)',
    course: 'Engineering',
    branch: 'CSE',
    sem: 1,
    totalMarks: 30,
    maxMarks: 50,
    marks: 30,
    examType: 'Written / Upload',
    status: 'Pending Evaluation',
    published: false, // DRAFT / UNPUBLISHED
  });

  // Bob's published evaluation
  const bobPublishedEval = await Evaluation.create({
    id: 'eval_bob_pub',
    studentId: String(bscStudent._id),
    studentName: bscStudent.name,
    studentEmail: bscStudent.email,
    testId: 'test_bsc_201',
    testTitle: 'Real Analysis',
    course: 'B.Sc',
    branch: 'Maths Honours',
    sem: 1,
    totalMarks: 42,
    maxMarks: 50,
    marks: 42,
    published: true,
  });

  // Tokens
  const makeToken = (user) => jwt.sign(
    { id: String(user._id), email: user.email, role: user.role },
    JWT_SECRET,
    { expiresIn: '1h' }
  );

  const aliceToken = makeToken(engStudent);
  const engTeacherToken = makeToken(engTeacher);
  const bscTeacherToken = makeToken(bscTeacher);
  const adminToken = makeToken(adminUser);

  // App setup
  const app = express();
  app.use(express.json());
  app.use('/api/evaluations', evaluationRoutes);

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

  console.log('\n[TEST GROUP 1]: Unauthenticated Access Rejection (No Token)');
  const unauthGet = await api('GET', '/api/evaluations');
  assert.strictEqual(unauthGet.status, 401, 'GET / must be 401 without token');
  console.log('✅ GET /api/evaluations -> 401 Unauthorized');

  const unauthPost = await api('POST', '/api/evaluations', null, { testId: 't1' });
  assert.strictEqual(unauthPost.status, 401, 'POST / must be 401 without token');
  console.log('✅ POST /api/evaluations -> 401 Unauthorized');

  const unauthPublish = await api('POST', '/api/evaluations/publish-results', null, { testId: 't1' });
  assert.strictEqual(unauthPublish.status, 401, 'POST /publish-results must be 401 without token');
  console.log('✅ POST /api/evaluations/publish-results -> 401 Unauthorized');

  const unauthDelete = await api('POST', '/api/evaluations/batch-delete', null, { ids: ['eval_alice_pub'] });
  assert.strictEqual(unauthDelete.status, 401, 'POST /batch-delete must be 401 without token');
  console.log('✅ POST /api/evaluations/batch-delete -> 401 Unauthorized');

  console.log('\n[TEST GROUP 2]: Student Role Isolation & Mutation Rejections');
  const stuPost = await api('POST', '/api/evaluations', aliceToken, { id: 'exploit_eval', marks: 100, published: true });
  assert.strictEqual(stuPost.status, 201, 'Student exam submission returns 201');
  assert.strictEqual(stuPost.data.marksObtained, null, 'Student cannot self-award marks');
  assert.strictEqual(stuPost.data.published, false, 'Student cannot self-publish written script');
  console.log('✅ Student POST /api/evaluations -> 201 (Self-awarded marks & publish flag neutralized to null/false)');

  const stuPublish = await api('POST', '/api/evaluations/publish-results', aliceToken, { testId: 'test_eng_101' });
  assert.strictEqual(stuPublish.status, 403, 'Student cannot publish results');
  console.log('✅ Student POST /api/evaluations/publish-results -> 403 Forbidden');

  const stuDel = await api('POST', '/api/evaluations/batch-delete', aliceToken, { ids: ['eval_alice_pub'] });
  assert.strictEqual(stuDel.status, 403, 'Student cannot delete evaluations');
  console.log('✅ Student POST /api/evaluations/batch-delete -> 403 Forbidden');

  console.log('\n[TEST GROUP 3]: Student Read Scope & Sensitive Field Trimming');
  const stuGetAll = await api('GET', '/api/evaluations', aliceToken);
  assert.strictEqual(stuGetAll.status, 200);
  assert.strictEqual(stuGetAll.data.length, 1, 'Alice must only see her 1 published evaluation');
  assert.strictEqual(stuGetAll.data[0].id, 'eval_alice_pub');
  assert.strictEqual(stuGetAll.data[0].answerKeySnapshot, undefined, 'answerKeySnapshot must be trimmed');
  assert.strictEqual(stuGetAll.data[0].questionBlocks[0].standardAnswer, undefined, 'standardAnswer must be trimmed');
  assert.strictEqual(stuGetAll.data[0].questionBlocks[0].rubric, undefined, 'rubric must be trimmed');
  console.log('✅ Student GET /api/evaluations returns ONLY own published evaluations with sensitive fields stripped');

  // Alice attempts to get unpublished evaluation by ID
  const stuGetUnpub = await api('GET', `/api/evaluations/${aliceUnpublishedEval.id}`, aliceToken);
  assert.strictEqual(stuGetUnpub.status, 403, 'Student must receive 403 on unpublished evaluation');
  console.log('✅ Student GET /api/evaluations/:id on UNPUBLISHED record -> 403 Forbidden');

  // Alice attempts to get Bob's evaluation by ID
  const stuGetBob = await api('GET', `/api/evaluations/${bobPublishedEval.id}`, aliceToken);
  assert.strictEqual(stuGetBob.status, 403, 'Student must receive 403 on another student evaluation');
  console.log('✅ Student GET /api/evaluations/:id on ANOTHER student record -> 403 Forbidden');

  console.log('\n[TEST GROUP 4]: Teacher Course/Branch Scoping & Deletion Guards');
  // Engineering teacher queries evaluations -> must see Engineering only, not B.Sc
  const engTeacherGet = await api('GET', '/api/evaluations', engTeacherToken);
  assert.strictEqual(engTeacherGet.status, 200);
  const hasBscInEng = engTeacherGet.data.some(e => e.course === 'B.Sc');
  assert.strictEqual(hasBscInEng, false, 'Engineering teacher cannot see B.Sc evaluations');
  console.log('✅ Teacher GET /api/evaluations strictly isolated to assigned course & branch');

  // B.Sc teacher attempts to view Engineering evaluation by ID
  const bscTeacherAccessEng = await api('GET', `/api/evaluations/${alicePublishedEval.id}`, bscTeacherToken);
  assert.strictEqual(bscTeacherAccessEng.status, 403, 'B.Sc teacher cannot access Engineering evaluation');
  console.log('✅ Teacher of another course GET /api/evaluations/:id -> 403 Forbidden');

  // B.Sc teacher attempts to mutate an Engineering evaluation
  const bscTeacherMutateEng = await api('POST', '/api/evaluations', bscTeacherToken, {
    id: alicePublishedEval.id,
    course: 'Engineering',
    branch: 'CSE',
    marks: 10,
  });
  assert.strictEqual(bscTeacherMutateEng.status, 403, 'Teacher cannot evaluate another course');
  console.log('✅ Teacher POST /api/evaluations on another course -> 403 Forbidden');

  // Teacher attempts destructive deletion -> Admin only!
  const teacherDel = await api('POST', '/api/evaluations/batch-delete', engTeacherToken, { ids: [alicePublishedEval.id] });
  assert.strictEqual(teacherDel.status, 403, 'Teachers cannot perform deletions');
  console.log('✅ Teacher POST /api/evaluations/batch-delete -> 403 Forbidden (Admin Only)');

  const teacherDelOne = await api('DELETE', `/api/evaluations/${alicePublishedEval.id}`, engTeacherToken);
  assert.strictEqual(teacherDelOne.status, 403, 'Teachers cannot perform DELETE');
  console.log('✅ Teacher DELETE /api/evaluations/:id -> 403 Forbidden (Admin Only)');

  console.log('\n[TEST GROUP 5]: Administrator Oversight & Deletion Capability');
  const adminGet = await api('GET', '/api/evaluations', adminToken);
  assert.strictEqual(adminGet.status, 200);
  assert.strictEqual(adminGet.data.length, 4, 'Admin must see all evaluations across courses');
  console.log('✅ Administrator sees all 4 evaluations across all courses');

  const adminDel = await api('POST', '/api/evaluations/batch-delete', adminToken, { ids: [aliceUnpublishedEval.id] });
  assert.strictEqual(adminDel.status, 200);
  assert.strictEqual(adminDel.data.deletedCount, 1);
  console.log('✅ Administrator can perform batch deletion -> 200 OK');

  // Cleanup
  await User.deleteMany({});
  await Evaluation.deleteMany({});
  await new Promise((resolve) => server.close(resolve));
  await mongoose.disconnect();

  console.log('='.repeat(75));
  console.log('🎉 ALL NEGATIVE AND ACCESS CONTROL SECURITY TESTS PASSED!');
  console.log('='.repeat(75));
}

runTest().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
