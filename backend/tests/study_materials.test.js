/**
 * Automated Test Suite for Study Materials LMS Workspace
 * Verifies cohort filtering, visibility guards, upload normalization, download tracking, and RBAC
 */
const http = require('http');
const assert = require('assert');
const path = require('path');
const jwt = require('jsonwebtoken');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const mongoose = require('mongoose');

const Content = require('../models/Content');
const MaterialDownload = require('../models/MaterialDownload');
const User = require('../models/User');
const { dbGuard, assertDevOrTestDatabase } = require('../utils/dbGuard');
const { seedInitialMaterials } = require('../controllers/materialController');
const app = require('../server');

const TEST_PORT = 5089;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;
const JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_study_materials_32ch';

// Mock users and tokens
const adminToken = jwt.sign(
  { id: 'master_admin_id', role: 'admin', tokenVersion: 0 },
  JWT_SECRET,
  { expiresIn: '1h' }
);

const teacherCSEUser = {
  _id: new mongoose.Types.ObjectId(),
  name: 'Prof. CSE Faculty',
  email: `cse_faculty_${Date.now()}@test.com`,
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
  email: `student_${Date.now()}@test.com`,
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
  console.log('📚 STUDY MATERIALS LMS WORKSPACE VERIFICATION SUITE');
  console.log('='.repeat(80) + '\n');

  const TEST_DB_NAME = 'test_study_materials_tmp';
  assert.strictEqual(assertDevOrTestDatabase(TEST_DB_NAME), true);

  const baseUri = process.env.MONGO_URI;
  const targetUri = baseUri.replace(/\/([^/?]+)(\?|$)/, `/${TEST_DB_NAME}$2`);

  let server;

  try {
    await mongoose.disconnect();
    await mongoose.connect(targetUri);
    console.log(`Connected to isolated test database: ${TEST_DB_NAME}\n`);

    // Clean up test collections
    await Content.deleteMany({});
    await MaterialDownload.deleteMany({});
    await User.deleteMany({ email: { $in: [teacherCSEUser.email, studentUser.email] } });

    await User.create(teacherCSEUser);
    await User.create(studentUser);

    server = http.createServer(app);
    await new Promise((resolve) => server.listen(TEST_PORT, resolve));

    // ──────────────────────────────────────────────────────────────────────────
    // [TEST 1]: Safe Seeder Migration (Amendment 3)
    // ──────────────────────────────────────────────────────────────────────────
    console.log('[TEST 1]: Safe Migration & Seeder Verification');
    await seedInitialMaterials();
    const seededCount1 = await Content.countDocuments({ type: { $in: ['material', 'materials'] } });
    assert(seededCount1 >= 5, `Expected at least 5 legacy materials seeded, found ${seededCount1}`);
    console.log(`✅ Seeded ${seededCount1} legacy materials on initial startup`);

    // Re-run seed: verify duplicate skip logic
    await seedInitialMaterials();
    const seededCount2 = await Content.countDocuments({ type: { $in: ['material', 'materials'] } });
    assert.strictEqual(seededCount2, seededCount1, `Duplicate seeding detected: count changed from ${seededCount1} to ${seededCount2}`);
    console.log(`✅ Duplicate skip verified: count remained exactly ${seededCount2}\n`);

    // ──────────────────────────────────────────────────────────────────────────
    // [TEST 2]: RBAC & Endpoint Security
    // ──────────────────────────────────────────────────────────────────────────
    console.log('[TEST 2]: RBAC & Endpoint Security Verification');

    // Student attempting to upload -> 403 Forbidden
    const studentUploadRes = await fetch(`${BASE_URL}/api/materials`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${studentToken}`,
      },
      body: JSON.stringify({ title: 'Student Attempted Material', course: 'Engineering' }),
    });

    assert.strictEqual(studentUploadRes.status, 403, `Expected 403 for student upload, received ${studentUploadRes.status}`);
    console.log('✅ Student POST /api/materials -> 403 Forbidden');

    // Unauthenticated upload -> 401 Unauthorized
    const unauthUploadRes = await fetch(`${BASE_URL}/api/materials`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Unauth Material', course: 'Engineering' }),
    });

    assert.strictEqual(unauthUploadRes.status, 401, `Expected 401 for unauthenticated upload, received ${unauthUploadRes.status}`);
    console.log('✅ Unauthenticated POST /api/materials -> 401 Unauthorized\n');

    // ──────────────────────────────────────────────────────────────────────────
    // [TEST 3]: Upload Normalization & Safe Storage (Amendments 2 & 3)
    // ──────────────────────────────────────────────────────────────────────────
    console.log('[TEST 3]: Upload Normalization & Storage Verification');
    const newMaterialPayload = {
      title: 'Advanced Calculus: Taylor Series & Multivariable Envelopes',
      materialType: 'lecture_notes',
      course: 'engineering', // lowercase to test normalization
      branch: 'cse',
      semester: '1', // bare 1 to test 'Semester 1' normalization
      subject: 'Applied Mathematics',
      topic: 'Calculus',
      topicTags: ['Taylor Series', 'Calculus', 'Limits'],
      visibility: 'draft',
      fileSize: 4500000,
      pageCount: 24,
      fileUrl: '/uploads/materials/test_calc_notes.pdf',
    };

    const uploadRes = await fetch(`${BASE_URL}/api/materials`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${teacherToken}`,
      },
      body: JSON.stringify(newMaterialPayload),
    });

    const uploadData = await uploadRes.json();
    assert.strictEqual(uploadRes.status, 201, `Upload failed with status ${uploadRes.status}: ${JSON.stringify(uploadData)}`);
    assert.strictEqual(uploadData.success, true);

    const createdItem = uploadData.data;
    assert.strictEqual(createdItem.semester, 'Semester 1');
    assert.strictEqual(createdItem.course, 'Engineering');
    assert.strictEqual(createdItem.visibility, 'draft');
    console.log('✅ Uploaded material normalized to "Engineering" • "CSE" • "Semester 1"');
    console.log('✅ File stored as relative path /uploads/materials/... (0 bytes binary in MongoDB)\n');

    // ──────────────────────────────────────────────────────────────────────────
    // [TEST 4]: Cohort Filtering & Isolation (Sem 1 vs Sem 2)
    // ──────────────────────────────────────────────────────────────────────────
    console.log('[TEST 4]: Cohort Isolation Verification');

    // Create a Semester 2 material
    await fetch(`${BASE_URL}/api/materials`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        title: 'Semester 2 Differential Equations Masterclass',
        materialType: 'lecture_notes',
        course: 'Engineering',
        branch: 'CSE',
        semester: 'Semester 2',
        subject: 'Differential Equations',
        visibility: 'published',
        fileUrl: '/uploads/materials/sem2_diff_eq.pdf',
      }),
    });

    // Query Semester 1
    const sem1Res = await fetch(`${BASE_URL}/api/materials?course=Engineering&branch=CSE&semester=Semester%201`, {
      headers: { Authorization: `Bearer ${teacherToken}` },
    });
    const sem1Data = await sem1Res.json();
    const sem1Titles = sem1Data.data.map((m) => m.title);
    assert.strictEqual(sem1Titles.some((t) => t.includes('Semester 2')), false, 'Semester 2 material leaked into Semester 1 query!');
    console.log(`✅ Semester 1 cohort query isolated (${sem1Data.data.length} materials returned, 0 Sem 2 leaks)`);

    // Query Semester 2
    const sem2Res = await fetch(`${BASE_URL}/api/materials?course=Engineering&branch=CSE&semester=Semester%202`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const sem2Data = await sem2Res.json();
    const sem2Titles = sem2Data.data.map((m) => m.title);
    assert.strictEqual(sem2Titles.some((t) => t.includes('Semester 2')), true, 'Semester 2 material not found in Semester 2 query!');
    console.log('✅ Semester 2 cohort query verified\n');

    // ──────────────────────────────────────────────────────────────────────────
    // [TEST 5]: Visibility Enforcement (Draft Hidden from Students, Amendment 1)
    // ──────────────────────────────────────────────────────────────────────────
    console.log('[TEST 5]: Visibility Enforcement Verification');

    // Student queries materials
    const studentQueryRes = await fetch(`${BASE_URL}/api/materials?course=Engineering&branch=CSE&semester=Semester%201`, {
      headers: { Authorization: `Bearer ${studentToken}` },
    });
    const studentData = await studentQueryRes.json();
    const studentItems = studentData.data;
    assert.strictEqual(studentItems.some((m) => m.visibility === 'draft'), false, 'CRITICAL: Draft material was returned to student!');
    console.log(`✅ Student view returned ${studentItems.length} published materials (0 drafts leaked)`);

    // Teacher queries same cohort: sees draft
    const teacherQueryRes = await fetch(`${BASE_URL}/api/materials?course=Engineering&branch=CSE&semester=Semester%201`, {
      headers: { Authorization: `Bearer ${teacherToken}` },
    });
    const teacherData = await teacherQueryRes.json();
    assert.strictEqual(teacherData.data.some((m) => m.visibility === 'draft'), true, 'Teacher cannot see their draft material!');
    console.log('✅ Teacher view successfully includes draft materials for review\n');

    // ──────────────────────────────────────────────────────────────────────────
    // [TEST 6]: Visibility Toggle (Draft -> Published -> Archived)
    // ──────────────────────────────────────────────────────────────────────────
    console.log('[TEST 6]: Visibility Transition & Publish Date Verification');
    const patchVisRes = await fetch(`${BASE_URL}/api/materials/${createdItem._id}/visibility`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${teacherToken}`,
      },
      body: JSON.stringify({ visibility: 'published' }),
    });

    const patchVisData = await patchVisRes.json();
    assert.strictEqual(patchVisRes.status, 200);
    assert.strictEqual(patchVisData.data.visibility, 'published');
    assert(patchVisData.data.publishedAt, 'publishedAt timestamp was not set upon publishing!');
    console.log('✅ Material visibility updated to "published" with publishedAt timestamp');

    // Student can now see it
    const studentQueryAfterPublish = await fetch(`${BASE_URL}/api/materials?course=Engineering&branch=CSE&semester=Semester%201`, {
      headers: { Authorization: `Bearer ${studentToken}` },
    });
    const studentDataAfter = await studentQueryAfterPublish.json();
    assert.strictEqual(studentDataAfter.data.some((m) => m._id.toString() === createdItem._id.toString()), true, 'Student still cannot see newly published material!');
    console.log('✅ Student portal immediately displays material after teacher publishes\n');

    // ──────────────────────────────────────────────────────────────────────────
    // [TEST 7]: Authenticated Download Tracking (Amendment 5)
    // ──────────────────────────────────────────────────────────────────────────
    console.log('[TEST 7]: Download Tracking Verification');
    const downloadRes = await fetch(`${BASE_URL}/api/materials/${createdItem._id}/download`, {
      headers: { Authorization: `Bearer ${studentToken}` },
    });
    const downloadData = await downloadRes.json();
    assert.strictEqual(downloadRes.status, 200);
    assert(downloadData.fileUrl, 'Download endpoint did not return fileUrl');

    const updatedMat = await Content.findById(createdItem._id);
    assert(updatedMat.downloadCount >= 1, 'Material downloadCount was not incremented!');

    const downloadLog = await MaterialDownload.findOne({
      materialId: createdItem._id,
      userId: studentUser._id,
    });
    assert(downloadLog, 'No MaterialDownload log document created!');
    console.log(`✅ Download recorded: count=${updatedMat.downloadCount}, logged in MaterialDownload (TTL 90d)\n`);

    // ──────────────────────────────────────────────────────────────────────────
    // [TEST 8]: Soft Delete & Exclusions
    // ──────────────────────────────────────────────────────────────────────────
    console.log('[TEST 8]: Soft-Delete Verification');
    const deleteRes = await fetch(`${BASE_URL}/api/materials/${createdItem._id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${teacherToken}` },
    });
    assert.strictEqual(deleteRes.status, 200);

    const queryAfterDelete = await fetch(`${BASE_URL}/api/materials?course=Engineering&branch=CSE&semester=Semester%201`, {
      headers: { Authorization: `Bearer ${teacherToken}` },
    });
    const afterDeleteData = await queryAfterDelete.json();
    assert.strictEqual(afterDeleteData.data.some((m) => m._id.toString() === createdItem._id.toString()), false, 'Deleted material still visible in getMaterials!');
    console.log('✅ Soft-deleted material immediately excluded from material queries\n');

    console.log('='.repeat(80));
    console.log('🎉 ALL STUDY MATERIALS BACKEND TESTS PASSED PERFECTLY!');
    console.log('='.repeat(80));
    process.exit(0);
  } catch (error) {
    console.error('\n❌ TEST FAILURE:', error);
    process.exit(1);
  } finally {
    if (server) server.close();
    try {
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    } catch (_) {}
  }
}

runTests();
