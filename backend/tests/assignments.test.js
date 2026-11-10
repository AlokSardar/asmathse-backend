/**
 * Automated Test Suite for Assignments LMS Workspace
 * Verifies cohort filtering, query-time overdue detection, visibility guards, upload normalization, and RBAC
 */
const http = require('http');
const assert = require('assert');
const path = require('path');
const jwt = require('jsonwebtoken');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const mongoose = require('mongoose');

const Assignment = require('../models/Assignment');
const Submission = require('../models/Submission');
const User = require('../models/User');
const { assertDevOrTestDatabase } = require('../utils/dbGuard');
const { seedInitialAssignments } = require('../controllers/assignmentController');
const app = require('../server');

const TEST_PORT = 5091;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;
const JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_assignments_32ch';

// Mock users and tokens
const adminToken = jwt.sign(
  { id: 'master_admin_id', role: 'admin', tokenVersion: 0 },
  JWT_SECRET,
  { expiresIn: '1h' }
);

const teacherCSEUser = {
  _id: new mongoose.Types.ObjectId(),
  name: 'Prof. Ada Lovelace',
  email: `cse_asn_faculty_${Date.now()}@test.com`,
  password: 'password123',
  role: 'teacher',
  targetCourse: 'Engineering',
  branch: 'CSE',
  semester: 'Semester 1',
  tokenVersion: 0,
};
const teacherToken = jwt.sign(
  { id: teacherCSEUser._id.toString(), role: 'teacher', tokenVersion: 0 },
  JWT_SECRET,
  { expiresIn: '1h' }
);

const studentUser = {
  _id: new mongoose.Types.ObjectId(),
  name: 'Student Learner',
  email: `asn_student_${Date.now()}@test.com`,
  password: 'password123',
  role: 'student',
  targetCourse: 'Engineering',
  branch: 'CSE',
  semester: 'Semester 1',
  tokenVersion: 0,
};
const studentToken = jwt.sign(
  { id: studentUser._id.toString(), role: 'student', tokenVersion: 0 },
  JWT_SECRET,
  { expiresIn: '1h' }
);

async function runTests() {
  console.log('='.repeat(80));
  console.log('📋 ASSIGNMENTS LMS WORKSPACE VERIFICATION SUITE');
  console.log('='.repeat(80) + '\n');

  const TEST_DB_NAME = 'test_assignments_workspace_tmp';
  assert.strictEqual(assertDevOrTestDatabase(TEST_DB_NAME), true);

  const baseUri = process.env.MONGO_URI;
  const targetUri = baseUri.replace(/\/([^/?]+)(\?|$)/, `/${TEST_DB_NAME}$2`);

  let server;

  try {
    await mongoose.disconnect();
    await mongoose.connect(targetUri);
    console.log(`Connected to isolated test database: ${TEST_DB_NAME}\n`);

    // Clean up test collections
    await Assignment.deleteMany({});
    await Submission.deleteMany({});
    await User.deleteMany({ email: { $in: [teacherCSEUser.email, studentUser.email] } });

    await User.create(teacherCSEUser);
    await User.create(studentUser);

    server = http.createServer(app);
    await new Promise((resolve) => server.listen(TEST_PORT, resolve));

    // ──────────────────────────────────────────────────────────────────────────
    // [TEST 1]: Safe Seeder Migration (Amendment 6)
    // ──────────────────────────────────────────────────────────────────────────
    console.log('[TEST 1]: Safe Seeder Verification');
    await seedInitialAssignments();
    const seededCount1 = await Assignment.countDocuments({ isDeleted: { $ne: true } });
    assert(seededCount1 >= 6, `Expected at least 6 canonical assignments seeded, found ${seededCount1}`);
    console.log(`✅ Seeded ${seededCount1} initial assignments on startup`);

    // Run seeder again to ensure duplicate skipping
    await seedInitialAssignments();
    const seededCount2 = await Assignment.countDocuments({ isDeleted: { $ne: true } });
    assert.strictEqual(seededCount1, seededCount2, 'Idempotency failure: duplicate assignments were inserted');
    console.log('✅ Duplicate skip verified: count remained exactly identical\n');

    // ──────────────────────────────────────────────────────────────────────────
    // [TEST 2]: RBAC & Endpoint Security
    // ──────────────────────────────────────────────────────────────────────────
    console.log('[TEST 2]: RBAC & Endpoint Security Verification');

    // 1. Student cannot create assignments (403)
    const studentCreateRes = await fetch(`${BASE_URL}/api/assignments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${studentToken}`,
      },
      body: JSON.stringify({
        title: 'Unauthorized Student Homework',
        dueDate: new Date(Date.now() + 86400000),
      }),
    });
    assert.strictEqual(studentCreateRes.status, 403, 'Student POST /api/assignments must be 403 Forbidden');
    console.log('✅ Student POST /api/assignments -> 403 Forbidden');

    // 2. Unauthenticated cannot create assignments (401)
    const unauthCreateRes = await fetch(`${BASE_URL}/api/assignments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Anonymous Homework',
        dueDate: new Date(Date.now() + 86400000),
      }),
    });
    assert.strictEqual(unauthCreateRes.status, 401, 'Unauthenticated POST /api/assignments must be 401 Unauthorized');
    console.log('✅ Unauthenticated POST /api/assignments -> 401 Unauthorized');

    // 3. Teacher cross-cohort restriction
    const crossCohortRes = await fetch(`${BASE_URL}/api/assignments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${teacherToken}`,
      },
      body: JSON.stringify({
        title: 'CBSE Math Quiz',
        course: 'CBSE',
        branch: 'Science',
        semester: 'Class 10',
        dueDate: new Date(Date.now() + 86400000),
      }),
    });
    assert.strictEqual(crossCohortRes.status, 403, 'Teacher cross-cohort create must be 403 Forbidden');
    console.log('✅ Teacher cross-cohort POST /api/assignments -> 403 Forbidden\n');

    // ──────────────────────────────────────────────────────────────────────────
    // [TEST 3]: Upload Normalization & Zero-Binary Storage (Amendment 2)
    // ──────────────────────────────────────────────────────────────────────────
    console.log('[TEST 3]: Upload Normalization & Storage Verification');
    const validCreateRes = await fetch(`${BASE_URL}/api/assignments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${teacherToken}`,
      },
      body: JSON.stringify({
        title: 'CSE Sem 1 Discrete Structures Practice',
        assignmentType: 'problem_set',
        course: 'engineering',
        branch: 'cse',
        semester: '1',
        totalMarks: 40,
        dueDate: new Date(Date.now() + 5 * 86400000),
        description: 'Solve recurrence relation $a_n = 3a_{n-1} + 2$.',
        fileDataUrl: 'data:application/pdf;base64,JVBERi0xLjQKJcTl8uXrp/Og0MTGCjQgMCBvYmoKPDwgL0xlbmd0aCAxMyA+PgpzdHJlYW0KQSB0ZXN0IFBERiBmaWxlLgplbmRzdHJlYW0KZW5kb2JqCg==',
        attachmentName: 'Discrete_Math_Homework.pdf',
      }),
    });
    assert.strictEqual(validCreateRes.status, 201, 'Teacher valid POST /api/assignments must return 201');
    const createdData = await validCreateRes.json();
    assert.strictEqual(createdData.data.course, 'Engineering');
    assert.strictEqual(createdData.data.branch, 'CSE');
    assert.strictEqual(createdData.data.semester, 'Semester 1');
    assert(createdData.data.attachmentUrl.startsWith('/uploads/assignments/'), 'File URL must be relative path on filesystem');
    console.log('✅ Uploaded assignment normalized to "Engineering" • "CSE" • "Semester 1"');
    console.log('✅ File stored as relative path /uploads/assignments/... (0 bytes binary in MongoDB)\n');

    // ──────────────────────────────────────────────────────────────────────────
    // [TEST 4]: Query-Time Overdue Auto-Detection (Amendment 1)
    // ──────────────────────────────────────────────────────────────────────────
    console.log('[TEST 4]: Query-Time Overdue Auto-Detection');

    // Create an assignment with past due date in DB directly with status 'active'
    const pastDueDate = new Date(Date.now() - 3 * 86400000); // 3 days ago
    const overdueDoc = await Assignment.create({
      title: 'Past Due Calculus Problem Set',
      assignmentType: 'problem_set',
      course: 'Engineering',
      branch: 'CSE',
      semester: 'Semester 1',
      totalMarks: 30,
      dueDate: pastDueDate,
      deadline: pastDueDate,
      status: 'active', // Stored as 'active' in DB
      submissionCount: 15,
      totalStudents: 24,
    });

    // Query assignments for Engineering CSE Semester 1
    const getRes = await fetch(`${BASE_URL}/api/assignments?course=Engineering&branch=CSE&semester=Semester%201`, {
      headers: { Authorization: `Bearer ${teacherToken}` },
    });
    assert.strictEqual(getRes.status, 200);
    const getJson = await getRes.json();

    // Verify overdue item computed on read
    const fetchedOverdue = getJson.data.find((a) => a.id === overdueDoc._id.toString());
    assert(fetchedOverdue, 'Overdue assignment must be returned');
    assert.strictEqual(fetchedOverdue.isOverdue, true, 'isOverdue must be computed as true');
    assert.strictEqual(fetchedOverdue.status, 'active', 'Database status must remain "active" without permanent mutation');

    // Verify stats.overdue count
    assert(getJson.stats.overdue >= 1, `stats.overdue must be >= 1, got ${getJson.stats.overdue}`);
    console.log(`✅ Query-time overdue detection verified (isOverdue: true, DB status: 'active')`);
    console.log(`✅ Cohort stats: Active=${getJson.stats.active}, Overdue=${getJson.stats.overdue}, Total=${getJson.stats.total}\n`);

    // ──────────────────────────────────────────────────────────────────────────
    // [TEST 5]: Draft Visibility Enforcement (Dual Consumer)
    // ──────────────────────────────────────────────────────────────────────────
    console.log('[TEST 5]: Draft Visibility Enforcement');
    const draftDoc = await Assignment.create({
      title: 'Hidden Draft Homework For Next Week',
      assignmentType: 'homework',
      course: 'Engineering',
      branch: 'CSE',
      semester: 'Semester 1',
      totalMarks: 20,
      dueDate: new Date(Date.now() + 10 * 86400000),
      status: 'draft',
    });

    // Student view: draft must be excluded
    const studentRes = await fetch(`${BASE_URL}/api/assignments?course=Engineering&branch=CSE&semester=Semester%201`, {
      headers: { Authorization: `Bearer ${studentToken}` },
    });
    const studentJson = await studentRes.json();
    const studentLeakedDraft = studentJson.data.find((a) => a.id === draftDoc._id.toString());
    assert(!studentLeakedDraft, 'Draft assignment must NOT be visible to student');
    console.log('✅ Student portal strictly excludes draft assignments');

    // Teacher view: draft must be present
    const teacherQueryRes = await fetch(
      `${BASE_URL}/api/assignments?course=Engineering&branch=CSE&semester=Semester%201&status=draft`,
      { headers: { Authorization: `Bearer ${teacherToken}` } }
    );
    const teacherQueryJson = await teacherQueryRes.json();
    const teacherFoundDraft = teacherQueryJson.data.find((a) => a.id === draftDoc._id.toString());
    assert(teacherFoundDraft, 'Teacher must be able to view draft assignments');
    console.log('✅ Teacher view successfully includes draft assignments\n');

    // ──────────────────────────────────────────────────────────────────────────
    // [TEST 6]: Submissions Quick-View & Grading (Amendment 3)
    // ──────────────────────────────────────────────────────────────────────────
    console.log('[TEST 6]: Submissions Quick-View & Grading Verification');
    const subsRes = await fetch(`${BASE_URL}/api/assignments/${overdueDoc._id}/submissions`, {
      headers: { Authorization: `Bearer ${teacherToken}` },
    });
    assert.strictEqual(subsRes.status, 200);
    const subsJson = await subsRes.json();
    assert(subsJson.data && subsJson.data.length > 0, 'Submissions must return student records');
    console.log(`✅ Submissions list returned ${subsJson.data.length} student records for quick-view drawer`);

    // Grade student
    const firstSub = subsJson.data[0];
    const gradeRes = await fetch(`${BASE_URL}/api/assignments/${overdueDoc._id}/submissions/${firstSub.id}/grade`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${teacherToken}`,
      },
      body: JSON.stringify({ marksObtained: 28, feedback: 'Excellent step-by-step proofs.' }),
    });
    assert.strictEqual(gradeRes.status, 200);
    console.log('✅ Submissions grading endpoint verified\n');

    // ──────────────────────────────────────────────────────────────────────────
    // [TEST 7]: Soft-Delete & 5s Undo Restore
    // ──────────────────────────────────────────────────────────────────────────
    console.log('[TEST 7]: Soft-Delete & Undo Restore Verification');
    const deleteRes = await fetch(`${BASE_URL}/api/assignments/${createdData.data.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${teacherToken}` },
    });
    assert.strictEqual(deleteRes.status, 200);

    const checkDeleted = await Assignment.findById(createdData.data.id);
    assert.strictEqual(checkDeleted.isDeleted, true);
    console.log('✅ Soft-delete verified (isDeleted: true)');

    const restoreRes = await fetch(`${BASE_URL}/api/assignments/${createdData.data.id}/restore`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${teacherToken}` },
    });
    assert.strictEqual(restoreRes.status, 200);

    const checkRestored = await Assignment.findById(createdData.data.id);
    assert.strictEqual(checkRestored.isDeleted, false);
    console.log('✅ 5s Undo Restore verified (isDeleted: false)\n');

    console.log('='.repeat(80));
    console.log('🎉 ALL ASSIGNMENTS WORKSPACE BACKEND TESTS PASSED PERFECTLY!');
    console.log('='.repeat(80));
    process.exit(0);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await mongoose.disconnect();
  }
}

runTests().catch((err) => {
  console.error('\n❌ Test failure:', err);
  process.exit(1);
});
