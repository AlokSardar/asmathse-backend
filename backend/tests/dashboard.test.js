/**
 * Automated Test Suite for Admin Dashboard API
 * Tests /api/dashboard/stats, /api/dashboard/activity-feed, /api/evaluations/weekly-volume,
 * cohort filtering, deltas, and role-based access control.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const http = require('http');
const assert = require('assert');
const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

const User = require('../models/User');
const Content = require('../models/Content');
const ClassTest = require('../models/ClassTest');
const Evaluation = require('../models/Evaluation');
const { assertDevOrTestDatabase } = require('../utils/dbGuard');
const { clearDashboardCache } = require('../controllers/dashboardController');
const dashboardRoutes = require('../routes/dashboardRoutes');
const evaluationRoutes = require('../routes/evaluationRoutes');

const TEST_DB_NAME = 'test_admin_dashboard_tmp';
const JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_dashboard_suite_32ch';

let server;
let app;
let baseUrl;

async function setupTestApp() {
  app = express();
  app.use(express.json());

  app.use('/api/dashboard', dashboardRoutes);
  app.use('/api/evaluations', evaluationRoutes);

  return new Promise((resolve) => {
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

const adminToken = jwt.sign(
  { id: 'master_admin_id', role: 'admin', tokenVersion: 0 },
  JWT_SECRET,
  { expiresIn: '1h' }
);

const studentUser = {
  _id: new mongoose.Types.ObjectId(),
  name: 'Student For Dashboard Test',
  email: `student_dash_${Date.now()}@test.com`,
  password: 'password123',
  role: 'student',
  approvalStatus: 'approved',
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
  console.log('📊 ADMIN DASHBOARD REDESIGN TEST SUITE');
  console.log(`Database under test: ${TEST_DB_NAME}`);
  console.log('='.repeat(80) + '\n');

  assertDevOrTestDatabase(TEST_DB_NAME);

  const baseUri = process.env.MONGO_URI;
  if (!baseUri) {
    throw new Error('MONGO_URI not set');
  }
  const targetUri = baseUri.replace(/\/([^/?]+)(\?|$)/, `/${TEST_DB_NAME}$2`);

  try {
    await mongoose.connect(targetUri);
    console.log(`Connected to isolated test database: ${TEST_DB_NAME}\n`);

    baseUrl = await setupTestApp();

    // Clean up test collections
    await Content.deleteMany({});
    await ClassTest.deleteMany({});
    await Evaluation.deleteMany({});
    await User.deleteMany({});

    // Seed test user
    await User.create(studentUser);

    // Seed some test contents
    await Content.create([
      {
        title: 'Calculus Question 1',
        type: 'question',
        course: 'Engineering',
        branch: 'CSE',
        semester: 'Semester 1',
        validationStatus: 'valid',
        createdAt: new Date(),
      },
      {
        title: 'Calculus Question 2',
        type: 'question',
        course: 'Engineering',
        branch: 'CSE',
        semester: 'Semester 1',
        validationStatus: 'warning',
        createdAt: new Date(),
      },
      {
        title: 'PYQ 2024 Exam Paper',
        type: 'pyq',
        course: 'Engineering',
        branch: 'IT',
        semester: 'Semester 1',
        validationStatus: 'valid',
        createdAt: new Date(),
      },
      {
        title: 'Lecture Note 1',
        type: 'material',
        course: 'Engineering',
        branch: 'CSE',
        semester: 'Semester 1',
        visibility: 'published',
        createdAt: new Date(),
      },
    ]);

    // Seed a pending student
    await User.create({
      name: 'Pending Student',
      email: `pending_${Date.now()}@test.com`,
      password: 'password123',
      role: 'student',
      approvalStatus: 'pending',
      targetCourse: 'Engineering',
      branch: 'CSE',
      semester: 'Semester 1',
      tokenVersion: 0,
    });

    // Seed an evaluation
    await Evaluation.create({
      testId: new mongoose.Types.ObjectId(),
      studentId: studentUser._id,
      course: 'Engineering',
      branch: 'CSE',
      semester: 'Semester 1',
      score: 85,
      maxScore: 100,
      percentage: 85,
      grade: 'A',
      evaluationStatus: 'evaluated',
      submittedAt: new Date(),
    });

    // ──────────────────────────────────────────────────────────────────────────
    // [TEST 1]: Security & RBAC Guards
    // ──────────────────────────────────────────────────────────────────────────
    console.log('[TEST 1]: Security & RBAC Guards');

    const unauthRes = await fetch(`${baseUrl}/api/dashboard/stats`);
    assert.strictEqual(unauthRes.status, 401, `Expected 401, got ${unauthRes.status}`);
    console.log('✅ Unauthenticated GET /api/dashboard/stats -> 401');

    const studentRes = await fetch(`${baseUrl}/api/dashboard/stats`, {
      headers: { Authorization: `Bearer ${studentToken}` },
    });
    assert.strictEqual(studentRes.status, 403, `Expected 403, got ${studentRes.status}`);
    console.log('✅ Student token GET /api/dashboard/stats -> 403\n');

    // ──────────────────────────────────────────────────────────────────────────
    // [TEST 2]: Admin Stats Schema & Content
    // ──────────────────────────────────────────────────────────────────────────
    console.log('[TEST 2]: Admin Stats Schema & Content');
    clearDashboardCache();

    const statsRes = await fetch(`${baseUrl}/api/dashboard/stats`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.strictEqual(statsRes.status, 200, `Expected 200, got ${statsRes.status}`);
    const statsJson = await statsRes.json();
    assert.strictEqual(statsJson.success, true);
    const data = statsJson.data;

    assert(data.questionBankCount >= 2, `Expected QB >= 2, got ${data.questionBankCount}`);
    assert(data.pyqCount >= 1, `Expected PYQ >= 1, got ${data.pyqCount}`);
    assert(data.materialsCount >= 1, `Expected Materials >= 1, got ${data.materialsCount}`);
    assert(data.studentsCount >= 2, `Expected Students >= 2, got ${data.studentsCount}`);
    assert.strictEqual(typeof data.questionBankWeeklyDelta, 'number');
    assert.strictEqual(typeof data.pyqWeeklyDelta, 'number');
    assert.strictEqual(typeof data.materialsWeeklyDelta, 'number');
    assert.strictEqual(typeof data.studentsWeeklyDelta, 'number');
    assert.strictEqual(typeof data.testsMonthlyDelta, 'number');

    assert(data.contentOverview, 'contentOverview missing');
    assert.strictEqual(data.contentOverview.questionBank, data.questionBankCount);
    assert.strictEqual(data.contentOverview.pyqs, data.pyqCount);

    assert(data.validationSummary, 'validationSummary missing');
    assert.strictEqual(data.validationSummary.valid, 2);
    assert.strictEqual(data.validationSummary.warnings, 1);

    assert(Array.isArray(data.departmentPerformance), 'departmentPerformance must be array');
    const cseDept = data.departmentPerformance.find((d) => d.branch === 'CSE');
    assert(cseDept, 'CSE department must be present');
    assert.strictEqual(cseDept.avgScore, 85);

    assert.strictEqual(data.pendingApprovals, 1);
    assert.strictEqual(typeof data.totalDoubts, 'number');

    console.log('✅ All top stats, deltas, donut metrics, and department averages verified');

    // ──────────────────────────────────────────────────────────────────────────
    // [TEST 3]: Cohort Filtering on Dashboard Stats
    // ──────────────────────────────────────────────────────────────────────────
    console.log('\n[TEST 3]: Cohort Filtering');
    clearDashboardCache();

    const cseFilteredRes = await fetch(`${baseUrl}/api/dashboard/stats?course=Engineering&branch=CSE`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const cseFilteredJson = await cseFilteredRes.json();
    assert.strictEqual(cseFilteredJson.success, true);
    assert.strictEqual(cseFilteredJson.data.pyqCount, 0, 'PYQ is in IT, so CSE filter should yield 0');
    assert.strictEqual(cseFilteredJson.data.questionBankCount, 2, 'CSE has 2 questions');
    console.log('✅ Cohort filtering successfully filtered out IT contents');

    // ──────────────────────────────────────────────────────────────────────────
    // [TEST 4]: Activity Feed
    // ──────────────────────────────────────────────────────────────────────────
    console.log('\n[TEST 4]: Activity Feed');
    const activityRes = await fetch(`${baseUrl}/api/dashboard/activity-feed?limit=5`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.strictEqual(activityRes.status, 200);
    const activityJson = await activityRes.json();
    assert.strictEqual(activityJson.success, true);
    assert(Array.isArray(activityJson.data), 'Activity feed must be array');
    assert(activityJson.data.length > 0, 'Activity feed should have items');
    assert(activityJson.data[0].timeAgo, 'Activity item should have timeAgo string');
    console.log(`✅ Activity feed returned ${activityJson.data.length} recent events with timeAgo`);

    // ──────────────────────────────────────────────────────────────────────────
    // [TEST 5]: Weekly Volume Endpoint
    // ──────────────────────────────────────────────────────────────────────────
    console.log('\n[TEST 5]: Weekly Volume Endpoint');
    const weeklyRes = await fetch(`${baseUrl}/api/evaluations/weekly-volume`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.strictEqual(weeklyRes.status, 200);
    const weeklyJson = await weeklyRes.json();
    assert.strictEqual(weeklyJson.success, true);
    assert(Array.isArray(weeklyJson.data), 'Weekly data must be array');
    assert.strictEqual(weeklyJson.data.length, 7, 'Weekly data must have 7 days');
    assert.strictEqual(typeof weeklyJson.total, 'number');
    assert.strictEqual(typeof weeklyJson.isHighActivity, 'boolean');
    console.log(`✅ Weekly volume returned 7 days with total ${weeklyJson.total}`);

    console.log('\n' + '='.repeat(80));
    console.log('🎉 ALL DASHBOARD TESTS PASSED SUCCESSFULLY (0 ERRORS)');
    console.log('='.repeat(80));
  } finally {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    await mongoose.disconnect();
  }
}

runTests().catch((err) => {
  console.error('\n❌ TEST SUITE FAILED:', err);
  process.exit(1);
});
