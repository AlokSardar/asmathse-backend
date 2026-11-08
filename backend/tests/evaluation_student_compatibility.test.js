const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const assert = require('assert');
const path = require('path');
const http = require('http');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const User = require('../models/User');
const Evaluation = require('../models/Evaluation');
const Submission = require('../models/Submission');
const Content = require('../models/Content');
const evaluationRoutes = require('../routes/evaluationRoutes');

const TEMP_DB_NAME = 'test_eval_security_hotfix_tmp';
const JWT_SECRET = process.env.JWT_SECRET || require('crypto').randomBytes(32).toString('hex');

async function runCompatibilityTests() {
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

  console.log('='.repeat(80));
  console.log('🧪 EVALUATION HOTFIX: FRONTEND COMPATIBILITY & SECURITY TEST SUITE');
  console.log(`Target Database : ${TEMP_DB_NAME} (Strict temporary test database)`);
  console.log('='.repeat(80));

  await mongoose.connect(targetUri);
  assert.strictEqual(mongoose.connection.name, TEMP_DB_NAME, `Must be connected to ${TEMP_DB_NAME}`);

  await User.deleteMany({});
  await Evaluation.deleteMany({});
  await Submission.deleteMany({});
  await Content.deleteMany({});

  // Seed Users
  const student = await User.create({
    name: 'Aarav Sharma',
    email: 'aarav.student@test.edu',
    password: 'HashedPassword123!',
    role: 'student',
    course: 'Engineering',
    branch: 'CSE',
    semester: 1,
    rollNumber: 'CSE-2026-014',
    isApproved: true,
  });

  const otherStudent = await User.create({
    name: 'Neha Gupta',
    email: 'neha.student@test.edu',
    password: 'HashedPassword123!',
    role: 'student',
    course: 'Engineering',
    branch: 'CSE',
    semester: 1,
    rollNumber: 'CSE-2026-015',
    isApproved: true,
  });

  const engTeacher = await User.create({
    name: 'Prof. Alok Mukherjee',
    email: 'prof.mukherjee@test.edu',
    password: 'HashedPassword123!',
    role: 'teacher',
    course: 'Engineering',
    branch: 'CSE',
    isApproved: true,
  });

  const bscTeacher = await User.create({
    name: 'Prof. Ananya Banerjee',
    email: 'prof.banerjee@test.edu',
    password: 'HashedPassword123!',
    role: 'teacher',
    course: 'B.Sc',
    branch: 'Maths Honours',
    isApproved: true,
  });

  const admin = await User.create({
    name: 'Super Admin',
    email: 'admin.lms@test.edu',
    password: 'HashedPassword123!',
    role: 'admin',
    isApproved: true,
  });

  const studentToken = jwt.sign({ id: String(student._id), role: 'student', email: student.email, name: student.name, course: 'Engineering', branch: 'CSE' }, JWT_SECRET, { expiresIn: '1h' });
  const otherStudentToken = jwt.sign({ id: String(otherStudent._id), role: 'student', email: otherStudent.email, name: otherStudent.name, course: 'Engineering', branch: 'CSE' }, JWT_SECRET, { expiresIn: '1h' });
  const engTeacherToken = jwt.sign({ id: String(engTeacher._id), role: 'teacher', email: engTeacher.email, name: engTeacher.name, course: 'Engineering', branch: 'CSE' }, JWT_SECRET, { expiresIn: '1h' });
  const bscTeacherToken = jwt.sign({ id: String(bscTeacher._id), role: 'teacher', email: bscTeacher.email, name: bscTeacher.name, course: 'B.Sc', branch: 'Maths Honours' }, JWT_SECRET, { expiresIn: '1h' });
  const adminToken = jwt.sign({ id: String(admin._id), role: 'admin', email: admin.email, name: admin.name }, JWT_SECRET, { expiresIn: '1h' });

  // Spin up test Express app
  const app = express();
  app.use(express.json());
  app.use('/api/evaluations', evaluationRoutes);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://localhost:${port}/api/evaluations`;

  const makeReq = (pathStr, method = 'GET', token = null, body = null) => {
    return new Promise((resolve, reject) => {
      const url = new URL(baseUrl + pathStr);
      const headers = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const payload = body ? JSON.stringify(body) : null;
      if (payload) headers['Content-Length'] = Buffer.byteLength(payload);

      const req = http.request(url, { method, headers }, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(data); } catch (_) { json = data; }
          resolve({ status: res.statusCode, headers: res.headers, body: json });
        });
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  };

  try {
    // -------------------------------------------------------------------------
    // TEST 1: Student takes Online MCQ Exam and submits (Frontend Compatibility)
    // -------------------------------------------------------------------------
    console.log('\n▶ TEST 1: Student online MCQ exam submission via POST /api/evaluations');
    const mcqPayload = {
      id: 'SUB-MCQ-TEST-001',
      examId: 'EXAM-MCQ-100',
      examTitle: 'Unit Test 1: Differential Calculus',
      examType: 'Automated MCQ',
      marksObtained: 18,
      totalMarks: 20,
      breakdown: [
        { questionNumber: 1, marksAwarded: 4, maxMarks: 4, isCorrect: true },
        { questionNumber: 2, marksAwarded: 4, maxMarks: 4, isCorrect: true },
      ],
      submissionReason: 'Manual Submit',
    };
    const resMcq = await makeReq('/', 'POST', studentToken, mcqPayload);
    assert.strictEqual(resMcq.status, 201, `Expected 201, got ${resMcq.status}`);
    assert.strictEqual(resMcq.body.studentEmail, student.email);
    assert.strictEqual(resMcq.body.marksObtained, 18);
    assert.strictEqual(resMcq.body.published, true, 'Online MCQ exam must auto-publish');
    assert.strictEqual(resMcq.body.status, 'Evaluated');
    console.log('  ✔ POST /api/evaluations succeeds with HTTP 201');
    console.log('  ✔ Saved Evaluation is auto-published (published: true) and evaluated (status: "Evaluated")');

    // -------------------------------------------------------------------------
    // TEST 2: Duplicate Submission Guard (Single-Attempt Test Locking)
    // -------------------------------------------------------------------------
    console.log('\n▶ TEST 2: Duplicate submission guard (single-attempt exam lock)');
    // Student tries to submit the same exam a second time with 20/20 marks!
    const duplicateMcqPayload = {
      id: 'SUB-MCQ-TEST-DUPLICATE',
      examId: 'EXAM-MCQ-100',
      examTitle: 'Unit Test 1: Differential Calculus',
      examType: 'Automated MCQ',
      marksObtained: 20,
      totalMarks: 20,
      submissionReason: 'Duplicate Retake Attempt',
    };
    const resDuplicate = await makeReq('/', 'POST', studentToken, duplicateMcqPayload);
    // Backward-compatible: returns 200 OK with the existing evaluation record
    assert.strictEqual(resDuplicate.status, 200, 'Duplicate submission returns 200 with existing record');
    assert.strictEqual(resDuplicate.body.id, 'SUB-MCQ-TEST-001', 'Must return original evaluation ID');
    assert.strictEqual(resDuplicate.body.marksObtained, 18, 'Marks must remain 18, not overwritten to 20');

    // Verify database record in MongoDB remains 18
    const dbEval = await Evaluation.findOne({ id: 'SUB-MCQ-TEST-001' });
    assert.strictEqual(dbEval.marksObtained, 18, 'MongoDB record must not be modified by duplicate submission');
    console.log('  ✔ Second submission on single-attempt exam rejected/neutralized (HTTP 200, original marks 18 preserved)');

    // -------------------------------------------------------------------------
    // TEST 3: Anti-Cheat Strike Enforcement & Disqualification Lock
    // -------------------------------------------------------------------------
    console.log('\n▶ TEST 3: Anti-cheat strikes recording and disqualification lock');
    const antiCheatPayload = {
      id: 'SUB-MCQ-CHEATED-002',
      examId: 'EXAM-MCQ-200',
      examTitle: 'Unit Test 2: Linear Algebra',
      examType: 'Automated MCQ',
      marksObtained: 0,
      totalMarks: 20,
      strikesRecorded: 3,
      submissionReason: 'Auto-Submitted on 3 Proctoring Strikes',
    };
    const resCheated = await makeReq('/', 'POST', studentToken, antiCheatPayload);
    assert.strictEqual(resCheated.status, 201);
    assert.strictEqual(resCheated.body.cheated, true, 'Cheated flag must be set when strikes >= 3');
    assert.strictEqual(resCheated.body.strikesRecorded, 3);
    console.log('  ✔ Proctoring strikes recorded: cheated=true, strikesRecorded=3');

    // Student tries to submit again on the disqualified exam to wipe out the 0!
    const cheatWipePayload = {
      id: 'SUB-MCQ-OVERWRITE-CHEATED',
      examId: 'EXAM-MCQ-200',
      examType: 'Automated MCQ',
      marksObtained: 20,
      strikesRecorded: 0,
      submissionReason: 'Attempt to overwrite cheating penalty',
    };
    const resCheatWipe = await makeReq('/', 'POST', studentToken, cheatWipePayload);
    assert.strictEqual(resCheatWipe.status, 200);
    assert.strictEqual(resCheatWipe.body.cheated, true, 'Cheated flag cannot be overwritten');
    assert.strictEqual(resCheatWipe.body.marksObtained, 0, 'Score 0 cannot be overwritten');
    console.log('  ✔ Disqualified attempt cannot be overwritten by subsequent submissions');

    // -------------------------------------------------------------------------
    // TEST 4: Strict Student Visibility Rule ({ published: true } OR { autoGraded: true })
    // -------------------------------------------------------------------------
    console.log('\n▶ TEST 4: Strict student visibility rule verification');
    // Seed an auto-graded MCQ exam (autoGraded: true)
    const autoGradedEval = await Evaluation.create({
      id: 'eval_autograde_001',
      studentId: String(student._id),
      studentEmail: student.email,
      testId: 'up_auto_101',
      testTitle: 'Linear Algebra Quiz',
      examType: 'Automated MCQ',
      score: 16,
      marksObtained: 16,
      totalMarks: 20,
      status: 'Evaluated',
      autoGraded: true,
      published: true,
    });

    // Seed a teacher-published written evaluation (published: true, autoGraded: false)
    const publishedWrittenEval = await Evaluation.create({
      id: 'eval_wrt_pub_002',
      studentId: String(student._id),
      studentEmail: student.email,
      testId: 'up_wrt_102',
      testTitle: 'Calculus Midterm Written',
      examType: 'Written / Upload',
      score: 45,
      marksObtained: 45,
      totalMarks: 50,
      status: 'Evaluated',
      autoGraded: false,
      published: true,
    });

    // Seed an unpublished written answer script (published: false, autoGraded: false)
    const unpublishedScript = await Evaluation.create({
      id: 'eval_wrt_unpub_003',
      studentId: String(student._id),
      studentEmail: student.email,
      testId: 'up_wrt_103',
      testTitle: 'Draft Unreviewed Script',
      examType: 'Written / Upload',
      status: 'Pending Evaluation',
      autoGraded: false,
      published: false,
      marksObtained: null,
      answerPages: [{ id: 'p1', name: 'Script.pdf', pageNumber: 1 }],
    });

    // Student GET /api/evaluations
    const resStudentAll = await makeReq('/', 'GET', studentToken);
    assert.strictEqual(resStudentAll.status, 200);

    const idsInStudentView = resStudentAll.body.map((e) => e.id);
    assert(idsInStudentView.includes('eval_autograde_001'), 'Auto-graded MCQ attempt must be visible');
    assert(idsInStudentView.includes('eval_wrt_pub_002'), 'Teacher-published written evaluation must be visible');
    assert(!idsInStudentView.includes('eval_wrt_unpub_003'), 'Unpublished written script MUST remain strictly hidden');
    console.log('  ✔ Auto-graded MCQ attempt (autoGraded: true) is visible to student');
    console.log('  ✔ Teacher-published written evaluation (published: true) is visible to student');
    console.log('  ✔ Unpublished written script (published: false, autoGraded: false) is strictly hidden from student');

    // -------------------------------------------------------------------------
    // TEST 5: Student Written Script Submission & Self-Award Neutralization
    // -------------------------------------------------------------------------
    console.log('\n▶ TEST 5: Student written answer script submission (strict safeguard)');
    const maliciousScriptPayload = {
      id: 'SUB-WRT-MALICIOUS-003',
      examId: 'EXAM-WRT-099',
      examTitle: 'Written Class Test: Matrices',
      examType: 'Written / Upload',
      marksObtained: 50,
      percentage: 100,
      grade: 'A+',
      published: true,
      status: 'Evaluated',
      answerPages: [{ name: 'page1.pdf', pageNumber: 1 }],
    };
    const resScript = await makeReq('/', 'POST', studentToken, maliciousScriptPayload);
    assert.strictEqual(resScript.status, 201);
    assert.strictEqual(resScript.body.marksObtained, null, 'Student cannot set arbitrary marks on written exam');
    assert.strictEqual(resScript.body.published, false, 'Student cannot mark written script published');
    assert.strictEqual(resScript.body.status, 'Pending Evaluation');
    console.log('  ✔ Server rejected self-awarded marks: marksObtained=null, published=false, status="Pending Evaluation"');

    // Student GET /api/evaluations/:id on unpublished script returns 403
    const resGetWrt = await makeReq('/SUB-WRT-MALICIOUS-003', 'GET', studentToken);
    assert.strictEqual(resGetWrt.status, 403);
    console.log('  ✔ GET /api/evaluations/:id on unpublished written script correctly returns 403');

    // -------------------------------------------------------------------------
    // TEST 6: Teacher Grading & Publishing Workflow
    // -------------------------------------------------------------------------
    console.log('\n▶ TEST 6: Teacher grading & publishing workflow');
    const teacherGradePayload = {
      id: 'SUB-WRT-MALICIOUS-003',
      examId: 'EXAM-WRT-099',
      studentEmail: student.email,
      course: 'Engineering',
      branch: 'CSE',
      marksObtained: 42,
      totalMarks: 50,
      percentage: 84,
      grade: 'A',
      status: 'Evaluated',
      feedback: 'Great step-by-step matrix row reduction!',
    };
    const resTeacherGrade = await makeReq('/', 'POST', engTeacherToken, teacherGradePayload);
    assert.strictEqual(resTeacherGrade.status, 201);
    console.log('  ✔ Teacher graded written script with marks=42');

    // Teacher publishes results
    const resPublish = await makeReq('/publish-results', 'POST', engTeacherToken, {
      testId: 'SUB-WRT-MALICIOUS-003',
      testTitle: 'Written Class Test: Matrices',
      marksObtained: 42,
      totalMarks: 50,
      percentage: 84,
      grade: 'A',
      feedback: 'Great step-by-step matrix row reduction!',
    });
    assert.strictEqual(resPublish.status, 200);
    console.log('  ✔ POST /api/evaluations/publish-results returned 200');

    // Now student CAN see the published written script!
    const resStudentPublished = await makeReq('/SUB-WRT-MALICIOUS-003', 'GET', studentToken);
    assert.strictEqual(resStudentPublished.status, 200);
    assert.strictEqual(resStudentPublished.body.marksObtained, 42);
    assert.strictEqual(resStudentPublished.body.published, true);
    console.log('  ✔ Student can now see published evaluation and score 42/50');

    // -------------------------------------------------------------------------
    // TEST 7: Strict Role Restrictions (403 Negative Invariant Verification)
    // -------------------------------------------------------------------------
    console.log('\n▶ TEST 7: Strict role restrictions (negative invariants)');
    const resStdPub = await makeReq('/publish-results', 'POST', studentToken, { testId: 'SUB-MCQ-TEST-001' });
    assert.strictEqual(resStdPub.status, 403);
    console.log('  ✔ Student POST /api/evaluations/publish-results -> 403 Forbidden');

    const resStdBatch = await makeReq('/batch', 'POST', studentToken, { evaluations: [] });
    assert.strictEqual(resStdBatch.status, 403);
    console.log('  ✔ Student POST /api/evaluations/batch -> 403 Forbidden');

    const resStdDel = await makeReq('/SUB-MCQ-TEST-001', 'DELETE', studentToken);
    assert.strictEqual(resStdDel.status, 403);
    console.log('  ✔ Student DELETE /api/evaluations/:id -> 403 Forbidden');

    const resStdBatchDel = await makeReq('/batch-delete', 'POST', studentToken, { ids: ['SUB-MCQ-TEST-001'] });
    assert.strictEqual(resStdBatchDel.status, 403);
    console.log('  ✔ Student POST /api/evaluations/batch-delete -> 403 Forbidden');

    const resStdAiEval = await makeReq('/evaluate-handwritten', 'POST', studentToken, {});
    assert.strictEqual(resStdAiEval.status, 403);
    console.log('  ✔ Student POST /api/evaluations/evaluate-handwritten -> 403 Forbidden');

    const resBscCrossCourse = await makeReq('/', 'POST', bscTeacherToken, {
      id: 'SUB-CROSS-001',
      course: 'Engineering',
      branch: 'CSE',
      marksObtained: 30,
    });
    assert.strictEqual(resBscCrossCourse.status, 403);
    console.log('  ✔ B.Sc Teacher attempting to grade Engineering submission -> 403 Forbidden');

    const resAdminBatchDel = await makeReq('/batch-delete', 'POST', adminToken, { ids: ['SUB-MCQ-TEST-001'] });
    assert.strictEqual(resAdminBatchDel.status, 200);
    console.log('  ✔ Admin POST /api/evaluations/batch-delete -> 200 OK');

    console.log('\n' + '='.repeat(80));
    console.log('🎉 ALL COMPATIBILITY, DUPLICATE GUARD & SECURITY TESTS PASSED WITH 100% SUCCESS');
    console.log('='.repeat(80));
  } finally {
    server.close();
    await mongoose.disconnect();
  }
}

runCompatibilityTests().catch((err) => {
  console.error('\n❌ TEST RUN FAILED:', err);
  process.exit(1);
});
