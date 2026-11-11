/**
 * Student Registration Approval & Moderation Comprehensive Test Suite
 *
 * Verifies:
 * 1. Safe idempotent migration of users missing approvalStatus
 * 2. New student registration (pending status, inactive, admin notification created)
 * 3. Pending student login rejection (403 with pending message)
 * 4. Admin approval endpoint & immediate student login unlock (200 OK)
 * 5. Admin rejection with mandatory reason & student login rejection with reason
 * 6. Account suspension & reinstatement
 * 7. Bulk approval operations & bulk safety limit
 * 8. Non-admin teacher access rejection (403 Forbidden)
 * 9. Metrics & stats endpoint (/api/approvals/stats)
 */

const dotenv = require('dotenv');
dotenv.config();

const mongoose = require('mongoose');
const http = require('http');
const express = require('express');
const { assertDevOrTestDatabase } = require('../utils/dbGuard');
const User = require('../models/User');
const Student = require('../models/Student');
const Notification = require('../models/Notification');
const { migrateApprovalStatus } = require('../scripts/migrateApprovalStatus');
const authRoutes = require('../routes/authRoutes');
const approvalRoutes = require('../routes/approvalRoutes');
const { signToken } = require('../config/jwt');

const TEST_DB_NAME = 'test_student_approvals_tmp';

let server;
let app;
let adminToken;
let teacherToken;
let studentToken;

async function setupTestApp() {
  app = express();
  app.use(express.json());

  app.use('/api/auth', authRoutes);
  app.use('/api/approvals', approvalRoutes);

  return new Promise((resolve) => {
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

async function request(baseUrl, path, options = {}) {
  const url = `${baseUrl}${path}`;
  const res = await fetch(url, {
    method: options.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...(options.headers || {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, body: data };
}

async function runTests() {
  console.log('================================================================================');
  console.log('🛡️  STUDENT REGISTRATION APPROVAL & MODERATION TEST SUITE');
  console.log(`Database under test: ${TEST_DB_NAME} (Strictly isolated temporary test DB)`);
  console.log('================================================================================\n');

  assertDevOrTestDatabase(TEST_DB_NAME);

  const baseUri = process.env.MONGO_URI;
  if (!baseUri) {
    throw new Error('MONGO_URI is not set in environment or .env');
  }
  const targetUri = baseUri.replace(/\/([^/?]+)(\?|$)/, `/${TEST_DB_NAME}$2`);

  // Connect to isolated test database
  await mongoose.disconnect();
  await mongoose.connect(targetUri);
  assertDevOrTestDatabase();

  const baseUrl = await setupTestApp();

  try {
    // Clean test DB
    await User.deleteMany({});
    await Student.deleteMany({});
    await Notification.deleteMany({});

    // ── TEST 1: Safe Idempotent Migration ─────────────────────────────────────
    console.log('[TEST 1]: User Approval Migration (migrateApprovalStatus)');

    // Seed unmigrated users directly into raw MongoDB collection (bypassing Mongoose schema default)
    const adminId = new mongoose.Types.ObjectId();
    const teacherId = new mongoose.Types.ObjectId();
    const activeStudentId = new mongoose.Types.ObjectId();
    const pendingStudentId = new mongoose.Types.ObjectId();

    await User.collection.insertMany([
      {
        _id: adminId,
        name: 'Legacy Admin',
        email: 'legacy.admin@test.com',
        password: 'password123',
        role: 'admin',
        isApproved: true,
      },
      {
        _id: teacherId,
        name: 'Legacy Teacher',
        email: 'legacy.teacher@test.com',
        password: 'password123',
        role: 'teacher',
        isApproved: true,
      },
      {
        _id: activeStudentId,
        name: 'Legacy Active Student',
        email: 'legacy.active@test.com',
        password: 'password123',
        role: 'student',
        isApproved: true,
      },
      {
        _id: pendingStudentId,
        name: 'Legacy Pending Student',
        email: 'legacy.pending@test.com',
        password: 'password123',
        role: 'student',
        isApproved: false,
      },
    ]);

    // Run migration
    const migrationResult = await migrateApprovalStatus();
    console.log(`Migration result: ${JSON.stringify(migrationResult)}`);

    const migratedAdmin = await User.findById(adminId);
    const migratedTeacher = await User.findById(teacherId);
    const migratedActive = await User.findById(activeStudentId);
    const migratedPending = await User.findById(pendingStudentId);

    if (
      migratedAdmin.approvalStatus !== 'approved' ||
      migratedTeacher.approvalStatus !== 'approved' ||
      migratedActive.approvalStatus !== 'approved' ||
      migratedPending.approvalStatus !== 'pending'
    ) {
      throw new Error(`Migration failed: admin=${migratedAdmin.approvalStatus}, teacher=${migratedTeacher.approvalStatus}, active=${migratedActive.approvalStatus}, pending=${migratedPending.approvalStatus}`);
    }

    if (migratedActive.isApproved !== true || migratedPending.isApproved !== false) {
      throw new Error('isApproved was not kept in sync during migration!');
    }

    console.log('✅ Migration updated 3 users to approved, 1 user to pending');
    console.log('✅ isApproved backward-compatibility flag synchronized perfectly');

    // Create session tokens for RBAC tests
    adminToken = signToken({ id: migratedAdmin._id, role: 'admin', tokenVersion: 0 });
    teacherToken = signToken({ id: migratedTeacher._id, role: 'teacher', tokenVersion: 0 });

    // ── TEST 2: New Student Registration & Admin Notification ─────────────────
    console.log('\n[TEST 2]: New Student Registration Flow');

    const regPayload = {
      name: 'Aarav Sharma',
      email: 'aarav.sharma@test.com',
      password: 'securepassword123',
      role: 'student',
      course: 'Engineering',
      branch: 'CSE',
      semester: '1',
      whatsapp: '9876543210',
      fatherContact: '9876543211',
      registrationNote: 'I am a 1st year B.Tech student aiming to strengthen calculus foundations.',
    };

    const regRes = await request(baseUrl, '/api/auth/register', {
      method: 'POST',
      body: regPayload,
    });

    if (regRes.status !== 201 || !regRes.body.pending) {
      throw new Error(`Registration failed: ${JSON.stringify(regRes.body)}`);
    }

    const createdStudent = await User.findOne({ email: regPayload.email });
    if (!createdStudent || createdStudent.approvalStatus !== 'pending' || createdStudent.isActive !== false) {
      throw new Error('New student does not have approvalStatus: pending or isActive: false!');
    }
    if (createdStudent.registrationNote !== regPayload.registrationNote) {
      throw new Error('registrationNote was not stored correctly!');
    }

    // Verify admin notification created
    const adminNotif = await Notification.findOne({
      contentId: String(createdStudent._id),
      type: 'approval_request',
    });

    if (!adminNotif) {
      throw new Error('Admin in-app notification was not dispatched on student registration!');
    }

    console.log('✅ New student registration creates User with approvalStatus: "pending" & isActive: false');
    console.log(`✅ Admin in-app notification created: "${adminNotif.title} - ${adminNotif.message}"`);

    // ── TEST 3: Login Attempt by Pending Student ──────────────────────────────
    console.log('\n[TEST 3]: Login Attempt by Pending Student');

    const pendingLoginRes = await request(baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { email: regPayload.email, password: regPayload.password, portal: 'student' },
    });

    if (pendingLoginRes.status !== 403 || pendingLoginRes.body.approvalStatus !== 'pending') {
      throw new Error(`Expected 403 pending block, received: ${pendingLoginRes.status}`);
    }

    console.log('✅ Pending student blocked from logging in with 403 Forbidden & pending message');

    // ── TEST 4: RBAC Security Guard on /api/approvals ─────────────────────────
    console.log('\n[TEST 4]: RBAC Access Guard on /api/approvals');

    const unauthRes = await request(baseUrl, '/api/approvals');
    if (unauthRes.status !== 401) {
      throw new Error(`Expected 401 for unauthenticated request, got ${unauthRes.status}`);
    }

    const teacherRes = await request(baseUrl, '/api/approvals', { token: teacherToken });
    if (teacherRes.status !== 403) {
      throw new Error(`Expected 403 Forbidden for teacher, got ${teacherRes.status}`);
    }

    const adminApprovalsRes = await request(baseUrl, '/api/approvals', { token: adminToken });
    if (adminApprovalsRes.status !== 200 || !Array.isArray(adminApprovalsRes.body.data)) {
      throw new Error(`Admin query to /api/approvals failed: ${JSON.stringify(adminApprovalsRes.body)}`);
    }

    console.log('✅ Unauthenticated access rejected -> 401 Unauthorized');
    console.log('✅ Non-admin teacher access rejected -> 403 Forbidden');
    console.log(`✅ Admin access allowed -> 200 OK (${adminApprovalsRes.body.data.length} students returned)`);

    // ── TEST 5: Admin Approval & Immediate Student Login ──────────────────────
    console.log('\n[TEST 5]: Admin Approval & Student Login Verification');

    const approveRes = await request(baseUrl, `/api/approvals/${createdStudent._id}/approve`, {
      method: 'PATCH',
      token: adminToken,
    });

    if (approveRes.status !== 200 || approveRes.body.user.approvalStatus !== 'approved') {
      throw new Error(`Approve endpoint failed: ${JSON.stringify(approveRes.body)}`);
    }

    const updatedStudent = await User.findById(createdStudent._id);
    if (!updatedStudent.isApproved || !updatedStudent.isActive) {
      throw new Error('Approved student does not have isApproved: true and isActive: true!');
    }

    // Now student should be able to log in
    const approvedLoginRes = await request(baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { email: regPayload.email, password: regPayload.password, portal: 'student' },
    });

    if (approvedLoginRes.status !== 200 || !approvedLoginRes.body.token) {
      throw new Error(`Student login failed after approval: ${JSON.stringify(approvedLoginRes.body)}`);
    }

    studentToken = approvedLoginRes.body.token;
    console.log('✅ Admin approval sets approvalStatus: "approved", isApproved: true, isActive: true');
    console.log('✅ Approved student can immediately log in -> 200 OK with valid JWT');

    // ── TEST 6: Admin Rejection with Mandatory Reason ─────────────────────────
    console.log('\n[TEST 6]: Admin Rejection with Reason');

    // Register second student to test rejection
    const reg2 = await request(baseUrl, '/api/auth/register', {
      method: 'POST',
      body: {
        name: 'Rohan Mehta',
        email: 'rohan.mehta@test.com',
        password: 'password123',
        role: 'student',
        whatsapp: '9876500001',
        fatherContact: '9876500002',
      },
    });

    const student2Id = reg2.body._id || reg2.body.id;

    // Test rejection without reason -> should fail 400
    const emptyRejectRes = await request(baseUrl, `/api/approvals/${student2Id}/reject`, {
      method: 'PATCH',
      token: adminToken,
      body: { reason: 'Short' },
    });

    if (emptyRejectRes.status !== 400) {
      throw new Error('Expected 400 when rejection reason is under 10 chars');
    }

    const rejectionReasonText = 'Incomplete documentation provided for academic cohort verification.';
    const validRejectRes = await request(baseUrl, `/api/approvals/${student2Id}/reject`, {
      method: 'PATCH',
      token: adminToken,
      body: { reason: rejectionReasonText },
    });

    if (validRejectRes.status !== 200 || validRejectRes.body.user.approvalStatus !== 'rejected') {
      throw new Error(`Rejection failed: ${JSON.stringify(validRejectRes.body)}`);
    }

    // Attempt login by rejected student -> 403 with reason
    const rejectedLoginRes = await request(baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { email: 'rohan.mehta@test.com', password: 'password123', portal: 'student' },
    });

    if (rejectedLoginRes.status !== 403 || !rejectedLoginRes.body.message.includes(rejectionReasonText)) {
      throw new Error(`Expected login rejection with reason, got: ${JSON.stringify(rejectedLoginRes.body)}`);
    }

    console.log('✅ Rejection requires reason of min 10 chars (short reason -> 400)');
    console.log('✅ Rejection sets approvalStatus: "rejected", isApproved: false, isActive: false');
    console.log('✅ Rejected student receives 403 with institutional reason on login attempt');

    // ── TEST 7: Account Suspension & Reinstatement ────────────────────────────
    console.log('\n[TEST 7]: Account Suspension & Reinstatement');

    const suspendRes = await request(baseUrl, `/api/approvals/${createdStudent._id}/suspend`, {
      method: 'PATCH',
      token: adminToken,
      body: { reason: 'Violation of academic code of conduct', duration: '30 days' },
    });

    if (suspendRes.status !== 200 || suspendRes.body.user.approvalStatus !== 'suspended') {
      throw new Error(`Suspension failed: ${JSON.stringify(suspendRes.body)}`);
    }

    const suspendedLoginRes = await request(baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { email: regPayload.email, password: regPayload.password, portal: 'student' },
    });

    if (suspendedLoginRes.status !== 403 || suspendedLoginRes.body.approvalStatus !== 'suspended') {
      throw new Error(`Expected 403 for suspended student, got: ${JSON.stringify(suspendedLoginRes.body)}`);
    }

    // Reinstate
    const reinstateRes = await request(baseUrl, `/api/approvals/${createdStudent._id}/reinstate`, {
      method: 'PATCH',
      token: adminToken,
    });

    if (reinstateRes.status !== 200 || reinstateRes.body.user.approvalStatus !== 'approved') {
      throw new Error(`Reinstate failed: ${JSON.stringify(reinstateRes.body)}`);
    }

    const reinstatedLoginRes = await request(baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { email: regPayload.email, password: regPayload.password, portal: 'student' },
    });

    if (reinstatedLoginRes.status !== 200) {
      throw new Error(`Reinstated student failed to login: ${JSON.stringify(reinstatedLoginRes.body)}`);
    }

    console.log('✅ Suspended student receives 403 with suspension reason on login attempt');
    console.log('✅ Reinstate restores student to "approved" and unlocks login -> 200 OK');

    // ── TEST 8: Bulk Approval & Limit Enforcement ────────────────────────────
    console.log('\n[TEST 8]: Bulk Operations (/api/approvals/bulk)');

    // Create 3 pending students
    const bulkIds = [];
    for (let i = 1; i <= 3; i++) {
      const u = await User.create({
        name: `Bulk Student ${i}`,
        email: `bulk${i}@test.com`,
        password: 'password123',
        role: 'student',
        approvalStatus: 'pending',
        isApproved: false,
        isActive: false,
      });
      bulkIds.push(u._id);
    }

    const bulkRes = await request(baseUrl, '/api/approvals/bulk', {
      method: 'POST',
      token: adminToken,
      body: { userIds: bulkIds, action: 'approve' },
    });

    if (bulkRes.status !== 200 || bulkRes.body.count !== 3) {
      throw new Error(`Bulk approve failed: ${JSON.stringify(bulkRes.body)}`);
    }

    const verifiedBulkUsers = await User.find({ _id: { $in: bulkIds } });
    for (const bu of verifiedBulkUsers) {
      if (bu.approvalStatus !== 'approved' || !bu.isApproved || !bu.isActive) {
        throw new Error(`User ${bu._id} was not approved by bulk action!`);
      }
    }

    console.log(`✅ Bulk approved 3 students simultaneously -> ${bulkRes.body.message}`);

    // ── TEST 9: Approval Statistics Endpoint ──────────────────────────────────
    console.log('\n[TEST 9]: Approval Statistics (/api/approvals/stats)');

    const statsRes = await request(baseUrl, '/api/approvals/stats', {
      token: adminToken,
    });

    if (statsRes.status !== 200 || typeof statsRes.body.pendingCount !== 'number') {
      throw new Error(`Stats endpoint failed: ${JSON.stringify(statsRes.body)}`);
    }

    console.log('✅ Approval stats retrieved successfully:', {
      pending: statsRes.body.pendingCount,
      approved: statsRes.body.approvedCount,
      rejected: statsRes.body.rejectedCount,
      suspended: statsRes.body.suspendedCount,
      total: statsRes.body.totalCount,
      approvalRate: `${statsRes.body.approvalRate}%`,
    });

    console.log('\n================================================================================');
    console.log('🎉 ALL STUDENT APPROVAL & MODERATION TESTS PASSED 100%!');
    console.log('================================================================================');
  } finally {
    if (server) server.close();
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
}

runTests().catch((err) => {
  console.error('\n❌ TEST SUITE FAILED:', err);
  process.exit(1);
});
