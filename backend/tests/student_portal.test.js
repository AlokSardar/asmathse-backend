/**
 * Automated Test Suite for Student Portal Pipeline & Security
 * Validates:
 * 1. Student sees only published content for their enrolled cohort
 * 2. Student cannot see draft materials or assignments
 * 3. Student cannot access admin/faculty endpoints (403 Forbidden)
 * 4. Student submits assignment -> stored correctly in Submission collection
 * 5. Student submits doubt -> visible in teacher's escalator queue
 * 6. Results visible only after teacher publishes evaluation
 */
const http = require('http');
const assert = require('assert');
const path = require('path');
const jwt = require('jsonwebtoken');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const mongoose = require('mongoose');

const Assignment = require('../models/Assignment');
const Submission = require('../models/Submission');
const Content = require('../models/Content');
const Doubt = require('../models/Doubt');
const Evaluation = require('../models/Evaluation');
const User = require('../models/User');
const { assertDevOrTestDatabase } = require('../utils/dbGuard');
const app = require('../server');

const TEST_PORT = 5092;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;
const JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_assignments_32ch';

// Mock tokens
const adminToken = jwt.sign(
  { id: 'master_admin_id', role: 'admin', tokenVersion: 0 },
  JWT_SECRET,
  { expiresIn: '1h' }
);

const teacherUser = {
  _id: new mongoose.Types.ObjectId(),
  name: 'Prof. S. Bose',
  email: `teacher_portal_test_${Date.now()}@test.com`,
  password: 'password123',
  role: 'teacher',
  targetCourse: 'Engineering',
  branch: 'CSE',
  semester: 'Semester 1',
  tokenVersion: 0,
};
const teacherToken = jwt.sign(
  { id: teacherUser._id.toString(), role: 'teacher', tokenVersion: 0 },
  JWT_SECRET,
  { expiresIn: '1h' }
);

const studentCSEUser = {
  _id: new mongoose.Types.ObjectId(),
  name: 'Aarav Sharma',
  email: `student_cse_portal_${Date.now()}@test.com`,
  password: 'password123',
  role: 'student',
  targetCourse: 'Engineering',
  course: 'Engineering',
  branch: 'CSE',
  semester: 'Semester 1',
  tokenVersion: 0,
};
const studentCSEToken = jwt.sign(
  { id: studentCSEUser._id.toString(), role: 'student', tokenVersion: 0 },
  JWT_SECRET,
  { expiresIn: '1h' }
);

const studentECEUser = {
  _id: new mongoose.Types.ObjectId(),
  name: 'Rohan Sen',
  email: `student_ece_portal_${Date.now()}@test.com`,
  password: 'password123',
  role: 'student',
  targetCourse: 'Engineering',
  course: 'Engineering',
  branch: 'ECE',
  semester: 'Semester 3',
  tokenVersion: 0,
};
const studentECEToken = jwt.sign(
  { id: studentECEUser._id.toString(), role: 'student', tokenVersion: 0 },
  JWT_SECRET,
  { expiresIn: '1h' }
);

async function runStudentPortalTests() {
  console.log('='.repeat(80));
  console.log('🎓 STUDENT PORTAL FULL PIPELINE & SECURITY VERIFICATION SUITE');
  console.log('='.repeat(80) + '\n');

  const TEST_DB_NAME = 'test_student_portal_isolated_tmp';
  assert.strictEqual(assertDevOrTestDatabase(TEST_DB_NAME), true);

  const baseUri = process.env.MONGO_URI;
  const targetUri = baseUri.replace(/\/([^/?]+)(\?|$)/, `/${TEST_DB_NAME}$2`);

  let server;

  try {
    await mongoose.disconnect();
    await mongoose.connect(targetUri);
    console.log(`Connected to isolated test database: ${TEST_DB_NAME}\n`);

    // Clean up collections
    await Assignment.deleteMany({});
    await Submission.deleteMany({});
    await Content.deleteMany({});
    await Doubt.deleteMany({});
    await Evaluation.deleteMany({});
    await User.deleteMany({
      email: {
        $in: [teacherUser.email, studentCSEUser.email, studentECEUser.email],
      },
    });

    await User.create(teacherUser);
    await User.create(studentCSEUser);
    await User.create(studentECEUser);

    server = http.createServer(app);
    await new Promise((resolve) => server.listen(TEST_PORT, resolve));

    // ──────────────────────────────────────────────────────────────────────────
    // [TEST 1]: Cohort & Visibility Scoping (Student sees only published cohort items)
    // ──────────────────────────────────────────────────────────────────────────
    console.log('[TEST 1]: Cohort & Visibility Scoping Verification');

    // Seed 1 active CSE assignment, 1 draft CSE assignment, 1 active ECE assignment
    const activeCSEAsn = await Assignment.create({
      title: 'Active Assignment: Linear Algebra Proofs',
      course: 'Engineering',
      branch: 'CSE',
      semester: 'Semester 1',
      totalMarks: 30,
      dueDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      status: 'active',
      isDeleted: false,
    });

    const draftCSEAsn = await Assignment.create({
      title: 'Draft Assignment: Secret Homework',
      course: 'Engineering',
      branch: 'CSE',
      semester: 'Semester 1',
      totalMarks: 30,
      dueDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      status: 'draft',
      isDeleted: false,
    });

    const activeECEAsn = await Assignment.create({
      title: 'ECE Active Assignment: Signals & Systems',
      course: 'Engineering',
      branch: 'ECE',
      semester: 'Semester 3',
      totalMarks: 25,
      dueDate: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
      status: 'active',
      isDeleted: false,
    });

    // Query assignments as CSE student
    const cseStudentRes = await fetch(
      `${BASE_URL}/api/assignments?course=Engineering&branch=CSE&semester=Semester%201`,
      {
        headers: {
          Authorization: `Bearer ${studentCSEToken}`,
        },
      }
    );
    assert.strictEqual(cseStudentRes.status, 200, 'Student should be allowed to query assignments');
    const cseData = await cseStudentRes.json();
    const cseAsnTitles = (cseData.data || []).map((a) => a.title);

    assert(
      cseAsnTitles.includes('Active Assignment: Linear Algebra Proofs'),
      'Student should see active assignment for their cohort'
    );
    assert(
      !cseAsnTitles.includes('Draft Assignment: Secret Homework'),
      'Student must NOT see draft assignments'
    );
    assert(
      !cseAsnTitles.includes('ECE Active Assignment: Signals & Systems'),
      'CSE student must NOT see ECE assignments'
    );
    console.log('✅ Student sees only active assignments for their enrolled cohort (drafts & cross-cohort strictly hidden)');

    // ──────────────────────────────────────────────────────────────────────────
    // [TEST 2]: Study Materials Visibility (Drafts and Archived Hidden)
    // ──────────────────────────────────────────────────────────────────────────
    console.log('\n[TEST 2]: Study Materials Visibility & Draft Protection');

    // Create 1 published material, 1 draft material
    await Content.create({
      title: 'Published Matrix Theory Lecture Notes',
      type: 'materials',
      course: 'Engineering',
      branch: 'CSE',
      semester: 'Semester 1',
      visibility: 'published',
      isDeleted: false,
    });
    await Content.create({
      title: 'Unpublished Draft Formula Sheet',
      type: 'materials',
      course: 'Engineering',
      branch: 'CSE',
      semester: 'Semester 1',
      visibility: 'draft',
      status: 'draft',
      isDeleted: false,
    });

    const matRes = await fetch(
      `${BASE_URL}/api/materials?course=Engineering&branch=CSE&semester=Semester%201`,
      {
        headers: {
          Authorization: `Bearer ${studentCSEToken}`,
        },
      }
    );
    assert.strictEqual(matRes.status, 200);
    const matData = await matRes.json();
    assert.strictEqual(matData.success, true);
    const matTitles = (matData.data || []).map((m) => m.title);

    assert(
      matTitles.includes('Published Matrix Theory Lecture Notes'),
      'Student should see published materials'
    );
    assert(
      !matTitles.includes('Unpublished Draft Formula Sheet'),
      'Student must NEVER see draft materials'
    );
    console.log('✅ Student sees published materials; draft materials are strictly excluded');

    // ──────────────────────────────────────────────────────────────────────────
    // [TEST 3]: Endpoint RBAC Protection (Student blocked from admin/faculty endpoints)
    // ──────────────────────────────────────────────────────────────────────────
    console.log('\n[TEST 3]: Student RBAC Boundary Enforcement');

    // 1. Question Bank: Student receives 403 Forbidden
    const qbRes = await fetch(`${BASE_URL}/api/content/question-bank`, {
      headers: {
        Authorization: `Bearer ${studentCSEToken}`,
      },
    });
    assert.strictEqual(qbRes.status, 403, 'Student access to /api/content/question-bank must be 403');
    console.log('✅ Question Bank access blocked for students with 403 Forbidden');

    // 2. Tests Schedule Overview: Student receives 403 Forbidden
    const schedRes = await fetch(`${BASE_URL}/api/tests-schedule/overview`, {
      headers: {
        Authorization: `Bearer ${studentCSEToken}`,
      },
    });
    assert.strictEqual(schedRes.status, 403, 'Student access to /api/tests-schedule must be 403');
    console.log('✅ Teacher tests schedule blocked for students with 403 Forbidden');

    // 3. Assignment Creation: Student receives 403 Forbidden
    const createAsnRes = await fetch(`${BASE_URL}/api/assignments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${studentCSEToken}`,
      },
      body: JSON.stringify({
        title: 'Unauthorized Student Created Assignment',
        dueDate: new Date(),
      }),
    });
    assert.strictEqual(createAsnRes.status, 403, 'Student cannot create assignments (403)');
    console.log('✅ Assignment creation blocked for students with 403 Forbidden');

    // ──────────────────────────────────────────────────────────────────────────
    // [TEST 4]: Student Assignment Submission Pipeline
    // ──────────────────────────────────────────────────────────────────────────
    console.log('\n[TEST 4]: Student Assignment Submission Pipeline');

    const submitRes = await fetch(`${BASE_URL}/api/assignments/${activeCSEAsn._id}/submit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${studentCSEToken}`,
      },
      body: JSON.stringify({
        studentId: studentCSEUser._id.toString(),
        studentName: studentCSEUser.name,
        studentEmail: studentCSEUser.email,
        studentRoll: 'CSE-2026-014',
        textAnswer: '$\\det(A - \\lambda I) = 0 \\implies \\lambda = 2, 5$. Proof verified by Gauss-Jordan.',
        fileName: 'Aarav_Linear_Algebra_HW.pdf',
        fileSize: '420 KB',
      }),
    });
    assert.strictEqual(submitRes.status, 200, 'Student assignment submission should return 200 OK');
    const submitData = await submitRes.json();
    assert.strictEqual(submitData.success, true);
    assert(submitData.submissionId, 'Response should contain submissionId');

    // Verify stored correctly in Submission collection
    const storedSub = await Submission.findOne({ assignment: activeCSEAsn._id.toString() });
    assert(storedSub, 'Submission must be persisted in Submission collection');
    assert.strictEqual(storedSub.studentName, 'Aarav Sharma');
    assert.strictEqual(storedSub.status, 'submitted');
    assert(storedSub.notes.includes('det(A - \\lambda I) = 0'), 'LaTeX text answer must be stored');
    console.log('✅ Student assignment submission persisted correctly in Submission collection');

    // Verify student query now flags the assignment as submitted
    const verifyAsnRes = await fetch(
      `${BASE_URL}/api/assignments?course=Engineering&branch=CSE&semester=Semester%201`,
      {
        headers: {
          Authorization: `Bearer ${studentCSEToken}`,
        },
      }
    );
    const verifyAsnData = await verifyAsnRes.json();
    const targetDoc = (verifyAsnData.data || []).find((a) => a.id === activeCSEAsn._id.toString());
    assert(targetDoc && targetDoc.isSubmitted === true, 'Assignment isSubmitted flag must be true');
    console.log('✅ Assignment queries dynamically reflect student submission status');

    // ──────────────────────────────────────────────────────────────────────────
    // [TEST 5]: Doubts Submission -> Teacher Escalator Queue Pipeline
    // ──────────────────────────────────────────────────────────────────────────
    console.log('\n[TEST 5]: Student Doubt Submission -> Teacher Escalator Queue');

    const doubtRes = await fetch(`${BASE_URL}/api/doubts/ask`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${studentCSEToken}`,
      },
      body: JSON.stringify({
        question: 'How to calculate eigenvalues when matrix characteristic polynomial has repeated roots? $\\lambda_1 = \\lambda_2 = 3$',
        course: 'Engineering',
        stream: 'CSE',
        branch: 'CSE',
        semester: 1,
        topic: 'Linear Algebra',
        subject: 'Mathematics I',
        language: 'en',
        sendDirectToTeacher: true,
      }),
    });
    assert([200, 202].includes(doubtRes.status), 'Doubt submission should return 200 OK or 202 Accepted');
    const doubtData = await doubtRes.json();
    const doubtId = doubtData.doubtId || (doubtData.doubt && (doubtData.doubt._id || doubtData.doubt.id));
    assert(doubtId, 'Doubt response should return ticket id');

    // Escalate doubt to faculty review queue
    const escRes = await fetch(`${BASE_URL}/api/doubts/${doubtId}/escalate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${studentCSEToken}`,
      },
      body: JSON.stringify({
        reason: 'Repeated eigenvalues pedagogical explanation needed from teacher',
      }),
    });
    assert.strictEqual(escRes.status, 200, 'Student doubt escalation should return 200 OK');

    // Teacher queries queue
    const queueRes = await fetch(`${BASE_URL}/api/doubts/teacher/queue`, {
      headers: {
        Authorization: `Bearer ${teacherToken}`,
      },
    });
    assert.strictEqual(queueRes.status, 200, 'Teacher queue query should return 200 OK');
    const queueData = await queueRes.json();
    const queueItems = Array.isArray(queueData.queue)
      ? queueData.queue
      : (Array.isArray(queueData.doubts) ? queueData.doubts : (Array.isArray(queueData.data) ? queueData.data : []));
    const foundDoubt = queueItems.find(
      (d) =>
        (d.title && d.title.includes('repeated roots')) ||
        (d.question && d.question.includes('repeated roots')) ||
        (d.aiTranscription?.problemText && d.aiTranscription.problemText.includes('repeated roots'))
    );
    assert(foundDoubt, 'Submitted doubt must be present in teacher escalator queue');
    console.log('✅ Student doubt submission & escalation instantaneously appears in teacher escalator queue');

    // ──────────────────────────────────────────────────────────────────────────
    // [TEST 6]: Result Visibility Guard (Redacted until published)
    // ──────────────────────────────────────────────────────────────────────────
    console.log('\n[TEST 6]: Result Visibility Guard Verification');

    // Seed 1 unpublished evaluation and 1 published evaluation for student
    const unpubEval = await Evaluation.create({
      id: `EVAL-UNPUB-${Date.now()}`,
      studentId: studentCSEUser._id.toString(),
      studentEmail: studentCSEUser.email,
      studentName: studentCSEUser.name,
      course: 'Engineering',
      branch: 'CSE',
      semester: 'Semester 1',
      examId: 'TEST-MATH-01',
      examTitle: 'Calculus Mid-Term (Unpublished)',
      marksObtained: 28,
      totalMarks: 30,
      percentage: 93,
      grade: 'A+',
      published: false,
      autoGraded: false,
    });

    const pubEval = await Evaluation.create({
      id: `EVAL-PUB-${Date.now()}`,
      studentId: studentCSEUser._id.toString(),
      studentEmail: studentCSEUser.email,
      studentName: studentCSEUser.name,
      course: 'Engineering',
      branch: 'CSE',
      semester: 'Semester 1',
      examId: 'TEST-MATH-02',
      examTitle: 'Vectors Class Test (Published)',
      marksObtained: 27,
      totalMarks: 30,
      percentage: 90,
      grade: 'A+',
      published: true,
      autoGraded: false,
    });

    const evalRes = await fetch(`${BASE_URL}/api/evaluations`, {
      headers: {
        Authorization: `Bearer ${studentCSEToken}`,
      },
    });
    assert.strictEqual(evalRes.status, 200);
    const evalData = await evalRes.json();
    const evalItems = Array.isArray(evalData.data) ? evalData.data : (Array.isArray(evalData) ? evalData : []);
    const evalTitles = evalItems.map((e) => e.examTitle);

    assert(
      evalTitles.includes('Vectors Class Test (Published)'),
      'Student should see published evaluation results'
    );
    assert(
      !evalTitles.includes('Calculus Mid-Term (Unpublished)'),
      'Student must NOT see unpublished evaluation results before teacher publishes'
    );
    console.log('✅ Results visible only after teacher publishes evaluation; drafts stay private');

    console.log('\n' + '='.repeat(80));
    console.log('🎉 ALL 6 STUDENT PORTAL VERIFICATION TESTS PASSED PERFECTLY!');
    console.log('='.repeat(80) + '\n');
  } finally {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    await mongoose.disconnect();
    process.exit(0);
  }
}

runStudentPortalTests().catch((err) => {
  console.error('❌ Test failed with error:', err);
  process.exit(1);
});
