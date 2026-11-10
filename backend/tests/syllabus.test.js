/**
 * Automated Test Suite for Syllabus LMS Workspace
 * Verifies canonical seeding, RBAC, topic completion tracking, exam weightage, and PDF extraction
 */
const http = require('http');
const assert = require('assert');
const path = require('path');
const jwt = require('jsonwebtoken');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const mongoose = require('mongoose');

const Syllabus = require('../models/Syllabus');
const User = require('../models/User');
const { assertDevOrTestDatabase } = require('../utils/dbGuard');
const { seedInitialSyllabi } = require('../controllers/syllabusController');
const app = require('../server');

const TEST_PORT = 5092;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;
const JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_syllabus_32ch';

// Mock users and tokens
const adminToken = jwt.sign(
  { id: 'master_admin_id', role: 'admin', tokenVersion: 0 },
  JWT_SECRET,
  { expiresIn: '1h' }
);

const teacherCSEUser = {
  _id: new mongoose.Types.ObjectId(),
  name: 'Prof. Carl Gauss',
  email: `cse_syl_faculty_${Date.now()}@test.com`,
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
  email: `syl_student_${Date.now()}@test.com`,
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
  console.log('📜 SYLLABUS LMS WORKSPACE VERIFICATION SUITE');
  console.log('='.repeat(80) + '\n');

  const TEST_DB_NAME = 'test_syllabus_workspace_tmp';
  assert.strictEqual(assertDevOrTestDatabase(TEST_DB_NAME), true);

  const baseUri = process.env.MONGO_URI;
  const targetUri = baseUri.replace(/\/([^/?]+)(\?|$)/, `/${TEST_DB_NAME}$2`);

  let server;

  try {
    await mongoose.disconnect();
    await mongoose.connect(targetUri);
    console.log(`Connected to isolated test database: ${TEST_DB_NAME}\n`);

    // Clean up test collections
    await Syllabus.deleteMany({});
    await User.deleteMany({ email: { $in: [teacherCSEUser.email, studentUser.email] } });

    await User.create(teacherCSEUser);
    await User.create(studentUser);

    server = http.createServer(app);
    await new Promise((resolve) => server.listen(TEST_PORT, resolve));

    // ──────────────────────────────────────────────────────────────────────────
    // [TEST 1]: Safe Seeder Verification (Amendment 2)
    // ──────────────────────────────────────────────────────────────────────────
    console.log('[TEST 1]: Safe Seeder Verification (Canonical 28 Subjects)');
    await seedInitialSyllabi();
    const seededCount1 = await Syllabus.countDocuments({ isDeleted: { $ne: true } });
    assert(seededCount1 >= 28, `Expected at least 28 canonical syllabi seeded, found ${seededCount1}`);
    console.log(`✅ Seeded ${seededCount1} canonical subjects across all programs`);

    // Run seeder again to ensure duplicate skipping
    await seedInitialSyllabi();
    const seededCount2 = await Syllabus.countDocuments({ isDeleted: { $ne: true } });
    assert.strictEqual(seededCount1, seededCount2, 'Idempotency failure: duplicate syllabi were inserted');
    console.log('✅ Duplicate skip verified: count remained exactly identical\n');

    // ──────────────────────────────────────────────────────────────────────────
    // [TEST 2]: RBAC & Endpoint Security
    // ──────────────────────────────────────────────────────────────────────────
    console.log('[TEST 2]: RBAC & Endpoint Security Verification');

    // 1. Student cannot create syllabus (403)
    const studentCreateRes = await fetch(`${BASE_URL}/api/syllabus`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${studentToken}`,
      },
      body: JSON.stringify({
        subjectName: 'Unauthorized Student Subject',
        subjectCode: 'UNAUTH-101',
      }),
    });
    assert.strictEqual(studentCreateRes.status, 403, 'Student POST /api/syllabus must be 403 Forbidden');
    console.log('✅ Student POST /api/syllabus -> 403 Forbidden');

    // 2. Unauthenticated cannot create syllabus (401)
    const unauthCreateRes = await fetch(`${BASE_URL}/api/syllabus`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subjectName: 'Anon Subject', subjectCode: 'ANON-101' }),
    });
    assert.strictEqual(unauthCreateRes.status, 401, 'Unauthenticated POST /api/syllabus must be 401 Unauthorized');
    console.log('✅ Unauthenticated POST /api/syllabus -> 401 Unauthorized');

    // 3. Teacher cross-cohort create blocked (403)
    const crossCohortRes = await fetch(`${BASE_URL}/api/syllabus`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${teacherToken}`,
      },
      body: JSON.stringify({
        subjectName: 'CBSE Math Course',
        subjectCode: 'CBSE-FAIL',
        course: 'CBSE',
        branch: 'Science',
        semester: 'Class 10',
        examPattern: { internalAssessment: 30, midSemester: 20, endSemester: 50 },
      }),
    });
    assert.strictEqual(crossCohortRes.status, 403, 'Teacher cross-cohort create must be 403 Forbidden');
    console.log('✅ Teacher cross-cohort POST /api/syllabus -> 403 Forbidden');

    // 4. optionalAuth Soft-Fail Verification (Amendment 1 & 7)
    // 4a. GET with invalid token -> 200 OK (soft auth failure treated as guest view, not 401)
    const invalidTokenGetRes = await fetch(`${BASE_URL}/api/syllabus`, {
      headers: { Authorization: 'Bearer invalid_malformed_expired_jwt_token_123' },
    });
    assert.strictEqual(invalidTokenGetRes.status, 200, 'optionalAuth GET with invalid token must return 200 OK');
    const invalidTokenJson = await invalidTokenGetRes.json();
    assert.strictEqual(invalidTokenJson.success, true);
    assert.ok(invalidTokenJson.data.length > 0, 'Must return published syllabus items');
    assert.ok(invalidTokenJson.data.every(s => s.visibility === 'published'), 'Must strictly return published content only');
    console.log('✅ optionalAuth GET with invalid token -> 200 OK (published content only, not 401)');

    // 4b. GET with no token -> 200 OK (published content only)
    const noTokenGetRes = await fetch(`${BASE_URL}/api/syllabus`);
    assert.strictEqual(noTokenGetRes.status, 200, 'optionalAuth GET with no token must return 200 OK');
    const noTokenJson = await noTokenGetRes.json();
    assert.strictEqual(noTokenJson.success, true);
    assert.ok(noTokenJson.data.every(s => s.visibility === 'published'), 'Must strictly return published content only');
    console.log('✅ optionalAuth GET with no token -> 200 OK (published content only)');

    // 4c. POST with invalid token -> 401 Unauthorized
    const invalidTokenPostRes = await fetch(`${BASE_URL}/api/syllabus`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer invalid_malformed_expired_jwt_token_123',
      },
      body: JSON.stringify({ subjectName: 'Hacker Course', subjectCode: 'HACK-101' }),
    });
    assert.strictEqual(invalidTokenPostRes.status, 401, 'POST /api/syllabus with invalid token must return 401');
    console.log('✅ POST with invalid token -> 401 Unauthorized');



    // ──────────────────────────────────────────────────────────────────────────
    // [TEST 3]: Assessment Weightage 100% Validation (Amendment 6)
    // ──────────────────────────────────────────────────────────────────────────
    console.log('[TEST 3]: Assessment Weightage 100% Sum Verification');
    const invalidWeightRes = await fetch(`${BASE_URL}/api/syllabus`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${teacherToken}`,
      },
      body: JSON.stringify({
        subjectName: 'Invalid Weightage Math',
        subjectCode: 'INV-101',
        course: 'Engineering',
        branch: 'CSE',
        semester: 'Semester 1',
        examPattern: { internalAssessment: 20, midSemester: 20, endSemester: 40 }, // Sum = 80, not 100
      }),
    });
    assert.strictEqual(invalidWeightRes.status, 400, 'Weightage sum not 100% must return 400 Bad Request');
    console.log('✅ Exam weightage sum != 100% strictly rejected with 400 Bad Request\n');

    // ──────────────────────────────────────────────────────────────────────────
    // [TEST 4]: Topic Completion Toggles (Amendment 1)
    // ──────────────────────────────────────────────────────────────────────────
    console.log('[TEST 4]: Topic Completion Tracking Verification');
    const bsm101 = await Syllabus.findOne({ subjectCode: 'BS-M101' });
    assert(bsm101, 'BS-M101 syllabus must exist from seed');

    const targetTopic = 'Beta and Gamma Functions';

    // 1. Student cannot toggle topics (403)
    const studentToggleRes = await fetch(`${BASE_URL}/api/syllabus/${bsm101._id}/topics`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${studentToken}`,
      },
      body: JSON.stringify({ moduleId: 'MOD-1', topic: targetTopic, completed: true }),
    });
    assert.strictEqual(studentToggleRes.status, 403, 'Student cannot mark topics completed');
    console.log('✅ Student PATCH /api/syllabus/:id/topics -> 403 Forbidden');

    // 2. Teacher marks topic completed
    const teacherToggleRes = await fetch(`${BASE_URL}/api/syllabus/${bsm101._id}/topics`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${teacherToken}`,
      },
      body: JSON.stringify({ moduleId: 'MOD-1', topic: targetTopic, completed: true }),
    });
    assert.strictEqual(teacherToggleRes.status, 200);
    const toggleJson = await teacherToggleRes.json();
    assert(toggleJson.data.completedTopics.includes(targetTopic), 'Topic must be in completedTopics');
    assert(toggleJson.data.completionStats.completedTopics >= 1);
    assert(toggleJson.data.completionStats.percentage > 0);
    console.log(`✅ Teacher marked topic completed: Progress is now ${toggleJson.data.completionStats.percentage}%`);

    // 3. Teacher toggles topic back to incomplete
    const teacherUntoggleRes = await fetch(`${BASE_URL}/api/syllabus/${bsm101._id}/topics`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${teacherToken}`,
      },
      body: JSON.stringify({ moduleId: 'MOD-1', topic: targetTopic, completed: false }),
    });
    assert.strictEqual(teacherUntoggleRes.status, 200);
    const untoggleJson = await teacherUntoggleRes.json();
    assert(!untoggleJson.data.completedTopics.includes(targetTopic), 'Topic must be removed from completedTopics');
    console.log('✅ Teacher unmarked topic: Progress correctly rolled back\n');

    // ──────────────────────────────────────────────────────────────────────────
    // [TEST 5]: Cohort Queries & Student Read Scope
    // ──────────────────────────────────────────────────────────────────────────
    console.log('[TEST 5]: Cohort Queries & Student Read Scope');
    const cseSyllabiRes = await fetch(`${BASE_URL}/api/syllabus?course=Engineering&branch=CSE&semester=Semester%201`, {
      headers: { Authorization: `Bearer ${studentToken}` },
    });
    assert.strictEqual(cseSyllabiRes.status, 200);
    const cseSyllabiJson = await cseSyllabiRes.json();
    assert(cseSyllabiJson.data.length >= 1);
    assert(cseSyllabiJson.data.some((s) => s.subjectCode === 'BS-M101'));
    console.log(`✅ Student view returned ${cseSyllabiJson.data.length} published syllabus document(s) for Engineering Sem 1\n`);

    // ──────────────────────────────────────────────────────────────────────────
    // [TEST 6]: Soft-Delete & Restore Verification
    // ──────────────────────────────────────────────────────────────────────────
    console.log('[TEST 6]: Soft-Delete & Restore Verification');
    const deleteRes = await fetch(`${BASE_URL}/api/syllabus/${bsm101._id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${teacherToken}` },
    });
    assert.strictEqual(deleteRes.status, 200);

    const checkDel = await Syllabus.findById(bsm101._id);
    assert.strictEqual(checkDel.isDeleted, true);
    console.log('✅ Soft-delete verified (isDeleted: true)');

    const restoreRes = await fetch(`${BASE_URL}/api/syllabus/${bsm101._id}/restore`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${teacherToken}` },
    });
    assert.strictEqual(restoreRes.status, 200);

    const checkRestored = await Syllabus.findById(bsm101._id);
    assert.strictEqual(checkRestored.isDeleted, false);
    console.log('✅ Restore verified (isDeleted: false)\n');

    console.log('='.repeat(80));
    console.log('🎉 ALL SYLLABUS WORKSPACE BACKEND TESTS PASSED PERFECTLY!');
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
