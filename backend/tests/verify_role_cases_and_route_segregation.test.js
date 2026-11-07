/**
 * Comprehensive Verification: Role Normalization across Cases & Route Segregation
 *
 * Verifies:
 * 1. POST /api/auth/login for 'Admin', 'admin', 'Student', 'student', 'teacher', 'Teacher'
 *    -> Assert returned JSON 'role' is ALWAYS lowercase ('admin', 'student', 'teacher').
 * 2. Teacher token accessing admin-only routes (/api/admin/students, /api/admin/content, /api/admin/assignments)
 *    -> Assert HTTP 403 Forbidden.
 * 3. Student token accessing teacher routes (/api/doubts/teacher/queue, /api/doubts/:id/teacher-reply)
 *    -> Assert HTTP 403 Forbidden.
 */

const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const assert = require('assert');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const User = require('../models/User');
const authRoutes = require('../routes/authRoutes');
const adminRoutes = require('../routes/adminRoutes');
const doubtRoutes = require('../routes/doubtRoutes');
const { verifyRoleSegregation } = require('../middleware/authMiddleware');

const TEST_PASSWORD = 'TestRolePassword123!';
const TEST_USERS = [
  { email: 'role.case.admin.upper@asmaths.edu', role: 'Admin', expectedRole: 'admin', loginRole: 'admin' },
  { email: 'role.case.admin.lower@asmaths.edu', role: 'admin', expectedRole: 'admin', loginRole: 'admin' },
  { email: 'role.case.teacher.upper@asmaths.edu', role: 'Teacher', expectedRole: 'teacher', loginRole: 'admin' },
  { email: 'role.case.teacher.lower@asmaths.edu', role: 'teacher', expectedRole: 'teacher', loginRole: 'admin' },
  { email: 'role.case.student.upper@asmaths.edu', role: 'Student', expectedRole: 'student', loginRole: 'student' },
  { email: 'role.case.student.lower@asmaths.edu', role: 'student', expectedRole: 'student', loginRole: 'student' },
];

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('='.repeat(75));
  console.log('🧪 ROLE NORMALIZATION & ROUTE SEGREGATION VERIFICATION SUITE');
  console.log(`Connected to Database: ${mongoose.connection.name}`);
  console.log('='.repeat(75));

  // 1. Seed the 6 test users with specific mixed-case roles
  const salt = await bcrypt.genSalt(10);
  const hashedPassword = await bcrypt.hash(TEST_PASSWORD, salt);

  for (const t of TEST_USERS) {
    await User.findOneAndUpdate(
      { email: t.email },
      {
        name: `Test User ${t.role}`,
        email: t.email,
        password: hashedPassword,
        role: t.role,
        isApproved: true,
        targetCourse: 'engineering',
        branch: 'CSE',
        semester: 1,
      },
      { upsert: true, returnDocument: 'after' }
    );
  }

  // 2. Build ephemeral test server
  const app = express();
  app.use(express.json());
  app.use(verifyRoleSegregation);
  app.use('/api/auth', authRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/doubts', doubtRoutes);

  const server = app.listen(0);
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`Ephemeral test server active on ${baseUrl}\n`);

  const tokens = {};

  // ── TEST 1: POST /api/auth/login for all 6 case variants ──────────────────
  console.log('[TEST 1]: Verifying HTTP POST /api/auth/login Role Normalization...');
  for (const t of TEST_USERS) {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: t.email,
        password: TEST_PASSWORD,
        role: t.loginRole,
      }),
    });

    const body = await res.json();
    console.log(`  Login: Stored role="${t.role}" | Requested as "${t.loginRole}"`);
    console.log(`    -> HTTP Status : ${res.status}`);
    console.log(`    -> Returned role: "${body.role}" (Expected: "${t.expectedRole}")`);

    assert.strictEqual(res.status, 200, `Login for ${t.email} should return 200`);
    assert.strictEqual(body.role, t.expectedRole, `Role returned must be lowercase "${t.expectedRole}"`);
    tokens[t.expectedRole] = body.token;
  }
  console.log('  ✅ ALL 6 ROLE VARIANTS RETURNED LOWERCASE JSON ROLES!\n');

  // ── TEST 2: Teacher Token access to Admin-Only Routes ─────────────────────
  console.log('[TEST 2]: Verifying Teacher Token is blocked with 403 on Admin-Only Routes...');
  const teacherToken = tokens['teacher'];
  assert(teacherToken, 'Teacher token must be present');

  const adminRoutesToTest = [
    { name: 'User Management (GET /api/admin/students/CSE/1)', url: `${baseUrl}/api/admin/students/CSE/1`, method: 'GET' },
    { name: 'Content Management (POST /api/admin/content)', url: `${baseUrl}/api/admin/content`, method: 'POST', body: { title: 'Test' } },
    { name: 'Assignment Management (POST /api/admin/assignments)', url: `${baseUrl}/api/admin/assignments`, method: 'POST', body: { title: 'Test' } },
  ];

  for (const route of adminRoutesToTest) {
    const res = await fetch(route.url, {
      method: route.method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${teacherToken}`,
      },
      body: route.body ? JSON.stringify(route.body) : undefined,
    });
    const body = await res.json().catch(() => ({}));
    console.log(`  Route: ${route.name}`);
    console.log(`    -> HTTP Status: ${res.status} (Expected: 403)`);
    console.log(`    -> Message    : "${body.message || body.error}"`);
    assert.strictEqual(res.status, 403, `Teacher should receive 403 on ${route.name}`);
  }
  console.log('  ✅ TEACHER TOKEN STRICTLY BLOCKED FROM ALL ADMIN MANAGEMENT ROUTES!\n');

  // ── TEST 3: Student Token access to Teacher Routes ────────────────────────
  console.log('[TEST 3]: Verifying Student Token is blocked with 403 on Teacher Routes...');
  const studentToken = tokens['student'];
  assert(studentToken, 'Student token must be present');

  const teacherRoutesToTest = [
    { name: 'Teacher Review Queue (GET /api/doubts/teacher/queue)', url: `${baseUrl}/api/doubts/teacher/queue`, method: 'GET' },
    { name: 'Teacher Reply (POST /api/doubts/672000000000000000000001/teacher-reply)', url: `${baseUrl}/api/doubts/672000000000000000000001/teacher-reply`, method: 'POST', body: { replyText: 'Answer' } },
  ];

  for (const route of teacherRoutesToTest) {
    const res = await fetch(route.url, {
      method: route.method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${studentToken}`,
      },
      body: route.body ? JSON.stringify(route.body) : undefined,
    });
    const body = await res.json().catch(() => ({}));
    console.log(`  Route: ${route.name}`);
    console.log(`    -> HTTP Status: ${res.status} (Expected: 403)`);
    console.log(`    -> Message    : "${body.message || body.error}"`);
    assert.strictEqual(res.status, 403, `Student should receive 403 on ${route.name}`);
  }
  console.log('  ✅ STUDENT TOKEN STRICTLY BLOCKED FROM ALL TEACHER QUEUE & REPLY ROUTES!\n');

  // ── Clean up test users ──────────────────────────────────────────────────
  console.log('[STEP 4]: Cleaning up ephemeral role test users...');
  const emails = TEST_USERS.map((u) => u.email);
  const del = await User.deleteMany({ email: { $in: emails } });
  console.log(`  Deleted ${del.deletedCount} temporary role test accounts.`);

  server.close();
  await mongoose.disconnect();
  console.log('='.repeat(75));
  console.log('🎉 ALL ROLE NORMALIZATION & ROUTE SEGREGATION CHECKS PASSED (100%)');
  console.log('='.repeat(75) + '\n');
}

run().catch((err) => {
  console.error('❌ Role test failed:', err);
  process.exit(1);
});
