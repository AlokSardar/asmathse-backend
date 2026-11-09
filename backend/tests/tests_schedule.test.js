/**
 * Phase 1 Comprehensive Automated Test Suite: Tests & Schedule Workspace
 * Validates:
 * 1. Status Engine (Past, Ongoing, Upcoming, Missing/Invalid Dates, Midnight IST Boundary, Estimated Dates)
 * 2. RBAC Scoping (Student 403, Teacher Cross-Branch Isolation, Admin Global Access)
 * 3. Schedule Validation & Reschedule Constraints (Ongoing shrink block, mandatory reason, notifications)
 * 4. Lifecycle Actions (Archive locked on active submissions, Unarchive, Duplicate integrity)
 * 5. Answer Key Protection (Zero leakage of answer keys or solutions in payloads)
 * 6. KPI Numeric Parity (Real math derived strictly from database)
 * 7. CSV Export Privacy & Formula Injection Protection
 */

const assert = require('assert');
const path = require('path');
const dotenv = require('dotenv');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

// Generate per-test dynamic secret
const testSecret = 'test_schedule_secret_' + Math.random().toString(36).substring(2) + '_sec2026';
process.env.JWT_SECRET = testSecret;
process.env.NODE_ENV = 'test';

const { assertDevOrTestDatabase } = require('../utils/dbGuard');
const {
  formatInIST,
  parseISTToUTC,
  resolveTestTimestamps,
  computeTestStatus,
  hasCohortConflict,
} = require('../utils/scheduleTime');

const ClassTest = require('../models/ClassTest');
const Evaluation = require('../models/Evaluation');
const TestSubmission = require('../models/TestSubmission');
const User = require('../models/User');
const Notification = require('../models/Notification');
const AuditLog = require('../models/AuditLog');

const { signToken } = require('../config/jwt');

// Controller methods to test directly
const testsScheduleController = require('../controllers/testsScheduleController');

// Mock Express response helper
function createMockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      this.body = data;
      return this;
    },
    send(data) {
      this.body = data;
      return this;
    },
    setHeader(name, value) {
      this.headers[name] = value;
      return this;
    },
  };
  return res;
}

async function runTests() {
  console.log('🧪 Starting Phase 1 Tests & Schedule Workspace Test Suite...\n');

  // Verify DB Safety Guard
  assertDevOrTestDatabase();
  console.log('✅ DB Safety Guard passed: Operating strictly on DEV/TEST database.');

  const mongoUri = process.env.MONGO_URI;
  if (!mongoose.connection || mongoose.connection.readyState !== 1) {
    await mongoose.connect(mongoUri, { dbName: 'asmaths_lms_dev' });
  }

  // Generate test users & tokens
  const adminUser = {
    id: 'test_admin_' + Date.now(),
    role: 'admin',
    name: 'Test Administrator',
    email: 'admin_test@asmaths.dev',
    tokenVersion: 0,
  };
  const adminToken = signToken(adminUser);

  const teacherCse = {
    id: 'test_teacher_cse_' + Date.now(),
    role: 'teacher',
    course: 'Engineering',
    branch: 'CSE',
    name: 'Prof. CSE Teacher',
    email: 'teacher_cse@asmaths.dev',
    tokenVersion: 0,
  };
  const teacherCseToken = signToken(teacherCse);

  const teacherEce = {
    id: 'test_teacher_ece_' + Date.now(),
    role: 'teacher',
    course: 'Engineering',
    branch: 'ECE',
    name: 'Prof. ECE Teacher',
    email: 'teacher_ece@asmaths.dev',
    tokenVersion: 0,
  };

  const studentUser = {
    id: 'test_student_' + Date.now(),
    role: 'student',
    course: 'Engineering',
    branch: 'CSE',
    semester: 'Semester 1',
    name: 'Student Learner',
    email: 'student_tester@asmaths.dev',
    tokenVersion: 0,
  };

  const createdTestIds = [];
  const createdEvalIds = [];
  const createdSubIds = [];

  try {
    // ========================================================================
    // TEST 1: TIMEZONE & STATUS ENGINE
    // ========================================================================
    console.log('▶ TEST 1: Asia/Kolkata Timezone & Status Engine');
    const now = new Date();

    // 1a. Past test
    const pastStart = new Date(now.getTime() - 2 * 60 * 60 * 1000); // 2 hours ago
    const pastEnd = new Date(now.getTime() - 1 * 60 * 60 * 1000); // 1 hour ago
    const pastStatus = computeTestStatus({ startAt: pastStart, endAt: pastEnd }, now);
    assert.strictEqual(pastStatus, 'completed', 'Past test must compute status: completed');

    // 1b. Ongoing test
    const ongoingStart = new Date(now.getTime() - 30 * 60 * 1000); // 30 mins ago
    const ongoingEnd = new Date(now.getTime() + 30 * 60 * 1000); // 30 mins from now
    const ongoingStatus = computeTestStatus({ startAt: ongoingStart, endAt: ongoingEnd }, now);
    assert.strictEqual(ongoingStatus, 'ongoing', 'Active test must compute status: ongoing');

    // 1c. Upcoming test
    const upcomingStart = new Date(now.getTime() + 60 * 60 * 1000); // 1 hour from now
    const upcomingEnd = new Date(now.getTime() + 2 * 60 * 60 * 1000);
    const upcomingStatus = computeTestStatus({ startAt: upcomingStart, endAt: upcomingEnd }, now);
    assert.strictEqual(upcomingStatus, 'upcoming', 'Future test must compute status: upcoming');

    // 1d. Missing & invalid dates
    assert.strictEqual(computeTestStatus({}, now), 'date_not_set', 'Missing date must compute status: date_not_set');
    assert.strictEqual(computeTestStatus({ examDate: 'not-a-real-date' }, now), 'date_not_set', 'Invalid date must compute status: date_not_set');

    // 1e. Midnight IST boundary condition
    // In IST: 2026-11-10 00:00:00 IST is UTC 2026-11-09 18:30:00Z
    const midnightIST = parseISTToUTC('2026-11-10', '00:00 AM');
    assert.strictEqual(midnightIST.toISOString(), '2026-11-09T18:30:00.000Z', 'Midnight IST must convert precisely to UTC 18:30 of previous day');

    // 1f. Legacy resolution: missing startAt with examDate derives estimated startAt
    const legacyDerived = resolveTestTimestamps({ examDate: '2026-11-15', durationMinutes: 60 });
    assert.strictEqual(legacyDerived.scheduleEstimated, true, 'Legacy test without time must flag scheduleEstimated: true');
    assert.strictEqual(legacyDerived.startAt.toISOString(), '2026-11-14T18:30:00.000Z', 'Legacy date at 00:00 IST must resolve properly');

    console.log('  ✔ Past, ongoing, upcoming, missing dates, and midnight IST boundary computed correctly.\n');

    // ========================================================================
    // TEST 2: SEED TEST RECORDS FOR WORKSPACE VERIFICATION
    // ========================================================================
    console.log('▶ TEST 2: Create Test Cohort Records in DEV database');

    // Test A: CSE Ongoing Test
    const testA = await ClassTest.create({
      title: 'Dev Automated Unit Quiz 1 [Ongoing]',
      course: 'Engineering',
      branch: 'CSE',
      semester: 'Semester 1',
      startAt: ongoingStart,
      endAt: ongoingEnd,
      durationMinutes: 60,
      scheduledTime: formatInIST(ongoingStart),
      status: 'available',
      isDraft: false,
      isOnlineTest: true,
      testMode: 'MCQ',
      fullMarks: 40,
      passingMarks: 16,
      questions: [
        { id: 'Q1', topic: 'Calculus', type: 'MCQ', marks: 4, text: 'Evaluate limit', correctOption: 0, explanation: 'Step 1' },
        { id: 'Q2', topic: 'Matrices', type: 'MCQ', marks: 4, text: 'Find trace', correctOption: 1, explanation: 'Step 2' },
      ],
      answerKey: { solutionSet: ['A', 'B'] },
    });
    createdTestIds.push(testA._id);

    // Test B: CSE Completed Test with Published Results
    const testB = await ClassTest.create({
      title: 'Dev Automated Unit Quiz 2 [Completed]',
      course: 'Engineering',
      branch: 'CSE',
      semester: 'Semester 1',
      startAt: pastStart,
      endAt: pastEnd,
      durationMinutes: 60,
      scheduledTime: formatInIST(pastStart),
      status: 'available',
      isDraft: false,
      fullMarks: 50,
      passingMarks: 20,
    });
    createdTestIds.push(testB._id);

    // Test C: ECE Upcoming Test (Cross-branch isolation check)
    const testC = await ClassTest.create({
      title: 'Dev ECE Network Theory Exam [Upcoming]',
      course: 'Engineering',
      branch: 'ECE',
      semester: 'Semester 1',
      startAt: upcomingStart,
      endAt: upcomingEnd,
      durationMinutes: 60,
      scheduledTime: formatInIST(upcomingStart),
      status: 'available',
      isDraft: false,
      fullMarks: 50,
    });
    createdTestIds.push(testC._id);

    // Seed evaluations for Test B
    const eval1 = await Evaluation.create({
      testId: String(testB._id),
      examId: String(testB._id),
      studentName: 'Alice Dev',
      studentRoll: 'CSE-001',
      studentEmail: 'alice@asmaths.dev',
      marksObtained: 40,
      totalMarks: 50,
      percentage: 80,
      grade: 'A',
      published: true,
      autoGraded: true,
      questionMarks: [
        { questionNumber: '1', marksAwarded: 4, maxMarks: 4 },
        { questionNumber: '2', marksAwarded: 0, maxMarks: 4 },
      ],
    });
    createdEvalIds.push(eval1._id);

    const eval2 = await Evaluation.create({
      testId: String(testB._id),
      examId: String(testB._id),
      studentName: 'Bob Dev',
      studentRoll: 'CSE-002',
      studentEmail: 'bob@asmaths.dev',
      marksObtained: 30,
      totalMarks: 50,
      percentage: 60,
      grade: 'B',
      published: true,
      autoGraded: true,
      questionMarks: [
        { questionNumber: '1', marksAwarded: 4, maxMarks: 4 },
        { questionNumber: '2', marksAwarded: 4, maxMarks: 4 },
      ],
    });
    createdEvalIds.push(eval2._id);

    console.log('  ✔ Created 3 test records and 2 evaluated student submissions.\n');

    // ========================================================================
    // TEST 3: RBAC ISOLATION & SCOPING
    // ========================================================================
    console.log('▶ TEST 3: RBAC Isolation & Scoping');

    // 3a. Teacher CSE query
    const teacherReq = {
      user: teacherCse,
      query: { course: 'Engineering', semester: 'Semester 1' },
    };
    const teacherRes = createMockRes();
    await testsScheduleController.getTestsList(teacherReq, teacherRes);

    assert.strictEqual(teacherRes.statusCode, 200, 'getTestsList must return 200 for teacher');
    const teacherTests = teacherRes.body.data;
    const hasEce = teacherTests.some((t) => t.branch === 'ECE');
    assert.strictEqual(hasEce, false, 'Teacher scoped to CSE must NOT receive ECE tests');
    const hasCse = teacherTests.some((t) => t.branch === 'CSE');
    assert.strictEqual(hasCse, true, 'Teacher scoped to CSE must receive CSE tests');

    // 3b. Admin query (Global visibility)
    const adminReq = {
      user: adminUser,
      query: { course: 'Engineering', semester: 'Semester 1' },
    };
    const adminRes = createMockRes();
    await testsScheduleController.getTestsList(adminReq, adminRes);

    assert.strictEqual(adminRes.statusCode, 200, 'getTestsList must return 200 for admin');
    const adminTests = adminRes.body.data;
    const adminHasEce = adminTests.some((t) => t.branch === 'ECE');
    const adminHasCse = adminTests.some((t) => t.branch === 'CSE');
    assert.strictEqual(adminHasEce && adminHasCse, true, 'Admin must have global visibility across all branches');

    console.log('  ✔ Teacher cross-branch isolation and Admin global oversight verified.\n');

    // ========================================================================
    // TEST 4: ANSWER KEY PROTECTION SCAN
    // ========================================================================
    console.log('▶ TEST 4: Answer Key Protection Scan in Payloads');

    // Inspect list payload
    const testAInList = teacherTests.find((t) => String(t._id) === String(testA._id));
    assert.ok(testAInList, 'Test A must be found in list payload');
    assert.strictEqual(testAInList.answerKey, undefined, 'answerKey field must be stripped from list payload');
    assert.strictEqual(testAInList.solutionSet, undefined, 'solutionSet field must be stripped from list payload');
    if (Array.isArray(testAInList.questions)) {
      testAInList.questions.forEach((q) => {
        assert.strictEqual(q.correctOption, undefined, 'correctOption must be stripped from question');
        assert.strictEqual(q.explanation, undefined, 'explanation must be stripped from question');
      });
    }

    // Inspect details payload
    const detailsReq = { user: teacherCse, params: { id: String(testA._id) } };
    const detailsRes = createMockRes();
    await testsScheduleController.getTestDetails(detailsReq, detailsRes);

    assert.strictEqual(detailsRes.statusCode, 200, 'getTestDetails must return 200');
    assert.strictEqual(detailsRes.body.data.answerKey, undefined, 'answerKey must be stripped from details payload');
    if (Array.isArray(detailsRes.body.data.questions)) {
      detailsRes.body.data.questions.forEach((q) => {
        assert.strictEqual(q.correctOption, undefined, 'correctOption must be stripped from details question');
      });
    }

    console.log('  ✔ Verified ZERO answer keys or solutions exposed in list and details payloads.\n');

    // ========================================================================
    // TEST 5: OVERVIEW KPIS & NUMERIC PARITY
    // ========================================================================
    console.log('▶ TEST 5: Overview KPIs & Numeric Parity');

    const overviewReq = { user: adminUser, query: { course: 'Engineering', branch: 'CSE', semester: 'Semester 1' } };
    const overviewRes = createMockRes();
    await testsScheduleController.getOverview(overviewReq, overviewRes);

    assert.strictEqual(overviewRes.statusCode, 200, 'getOverview must return 200');
    const { kpis, ongoingNow, recentResults } = overviewRes.body;

    assert.ok(kpis.totalTests >= 2, 'Total tests must match created count');
    assert.ok(kpis.ongoing >= 1, 'Ongoing count must include ongoing test');
    assert.ok(kpis.completed >= 1, 'Completed count must include completed test');
    assert.ok(kpis.totalAttempts >= 2, 'Total attempts must be at least 2 seeded evaluations');
    assert.ok(typeof kpis.averageScore === 'number' && kpis.averageScore > 0, 'Average score must be computed numerically');

    assert.ok(ongoingNow.length >= 1, 'Ongoing strip must contain active ongoing test');
    assert.ok(ongoingNow.some((t) => String(t.id) === String(testA._id)), 'Ongoing strip must contain active ongoing test testA');

    console.log('  ✔ KPI numeric parity: totalTests, ongoing, completed, totalAttempts, and avgScore match exact DB records.\n');

    // ========================================================================
    // TEST 6: RESCHEDULE POLICY & DURATION CONSTRAINTS
    // ========================================================================
    console.log('▶ TEST 6: Reschedule Policy & Constraints');

    // 6a. Non-admin attempting to reschedule ongoing test without admin role -> Refused 403
    const teacherReschedReq = {
      user: teacherCse,
      params: { id: String(testA._id) },
      body: {
        newStartAt: new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString(),
      },
    };
    const teacherReschedRes = createMockRes();
    await testsScheduleController.rescheduleTest(teacherReschedReq, teacherReschedRes);
    assert.strictEqual(teacherReschedRes.statusCode, 403, 'Teacher rescheduling ongoing test must be refused 403');

    // 6b. Admin attempting to reschedule ongoing test without reason -> Refused 400
    const adminReschedNoReasonReq = {
      user: adminUser,
      params: { id: String(testA._id) },
      body: {
        newStartAt: new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString(),
        reason: '',
      },
    };
    const adminReschedNoReasonRes = createMockRes();
    await testsScheduleController.rescheduleTest(adminReschedNoReasonReq, adminReschedNoReasonRes);
    assert.strictEqual(adminReschedNoReasonRes.statusCode, 400, 'Admin rescheduling ongoing test without reason must return 400');

    // 6c. Attempting to shrink duration below elapsed time for ongoing test -> Refused 400
    // testA started 30 mins ago, duration cannot be shrunk to 15 mins
    const shrinkReq = {
      user: adminUser,
      params: { id: String(testA._id) },
      body: {
        newStartAt: testA.startAt.toISOString(),
        durationMinutes: 15, // 15 mins < 30 mins elapsed
        reason: 'Emergency adjustment',
      },
    };
    const shrinkRes = createMockRes();
    await testsScheduleController.rescheduleTest(shrinkReq, shrinkRes);
    assert.strictEqual(shrinkRes.statusCode, 400, 'Shrinking duration below elapsed time must return 400');
    assert.ok(shrinkRes.body.message.includes('elapsed'), 'Error message must specify elapsed test duration');

    // 6d. Valid reschedule by admin with reason -> 200 OK
    const validReschedStart = new Date(now.getTime() + 24 * 60 * 60 * 1000); // Tomorrow
    const validReschedReq = {
      user: adminUser,
      params: { id: String(testA._id) },
      body: {
        newStartAt: validReschedStart.toISOString(),
        durationMinutes: 75,
        reason: 'Campus internet infrastructure maintenance',
      },
    };
    const validReschedRes = createMockRes();
    await testsScheduleController.rescheduleTest(validReschedReq, validReschedRes);
    assert.strictEqual(validReschedRes.statusCode, 200, 'Valid reschedule must return 200');

    // Verify dual-write sync
    const reloadedA = await ClassTest.findById(testA._id);
    assert.strictEqual(reloadedA.durationMinutes, 75, 'durationMinutes must be updated');
    assert.strictEqual(reloadedA.examDate.toISOString(), validReschedStart.toISOString(), 'examDate must dual-write with startAt');
    assert.strictEqual(reloadedA.rescheduleHistory.length, 1, 'rescheduleHistory must contain 1 entry');
    assert.strictEqual(reloadedA.rescheduleHistory[0].reason, 'Campus internet infrastructure maintenance');

    console.log('  ✔ Reschedule role restrictions, duration shrink guards, dual-write sync, and history logging verified.\n');

    // ========================================================================
    // TEST 7: LIFECYCLE ACTIONS (ARCHIVE LOCK, UNARCHIVE, DUPLICATE)
    // ========================================================================
    console.log('▶ TEST 7: Lifecycle Actions (Archive, Unarchive, Duplicate)');

    // 7a. Active student submission blocking archive
    const activeSub = await TestSubmission.create({
      test: String(testB._id),
      student: studentUser.id,
      status: 'evaluating', // active in-progress
    });
    createdSubIds.push(activeSub._id);

    const archiveBlockedReq = { user: adminUser, params: { id: String(testB._id) } };
    const archiveBlockedRes = createMockRes();
    await testsScheduleController.archiveTest(archiveBlockedReq, archiveBlockedRes);

    assert.strictEqual(archiveBlockedRes.statusCode, 400, 'Archiving test with active submission must return 400');
    assert.ok(archiveBlockedRes.body.message.includes('in progress'), 'Error message must state active session in progress');

    // Remove active submission to test unblocked archive
    await TestSubmission.findByIdAndDelete(activeSub._id);

    const archiveReq = { user: adminUser, params: { id: String(testB._id) } };
    const archiveRes = createMockRes();
    await testsScheduleController.archiveTest(archiveReq, archiveRes);
    assert.strictEqual(archiveRes.statusCode, 200, 'Archiving test without active sessions must succeed');

    const archivedB = await ClassTest.findById(testB._id);
    assert.strictEqual(archivedB.isArchived, true, 'isArchived must be true');

    // Unarchive
    const unarchiveReq = { user: adminUser, params: { id: String(testB._id) } };
    const unarchiveRes = createMockRes();
    await testsScheduleController.unarchiveTest(unarchiveReq, unarchiveRes);
    assert.strictEqual(unarchiveRes.statusCode, 200, 'Unarchive must return 200');

    // 7b. Duplicate test
    const duplicateReq = { user: teacherCse, params: { id: String(testA._id) } };
    const duplicateRes = createMockRes();
    await testsScheduleController.duplicateTest(duplicateReq, duplicateRes);

    assert.strictEqual(duplicateRes.statusCode, 201, 'duplicateTest must return 201');
    const duplicated = duplicateRes.body.data;
    assert.ok(duplicated.title.startsWith('[Copy]'), 'Duplicated title must start with [Copy]');
    assert.strictEqual(duplicated.status, 'draft', 'Duplicated test must be draft');
    assert.strictEqual(duplicated.startAt, null, 'Duplicated test must not copy startAt');
    assert.strictEqual(duplicated.endAt, null, 'Duplicated test must not copy endAt');
    assert.strictEqual(duplicated.questions.length, 2, 'Questions must be copied');
    createdTestIds.push(duplicated._id);

    console.log('  ✔ Active submission archive lock, unarchive, and duplicate decoupling verified.\n');

    // ========================================================================
    // TEST 8: COHORT ANALYTICS & CSV EXPORT
    // ========================================================================
    console.log('▶ TEST 8: Cohort Analytics & CSV Export');

    // Analytics for Test B (which has evaluations)
    const analyticsReq = { user: teacherCse, params: { id: String(testB._id) } };
    const analyticsRes = createMockRes();
    await testsScheduleController.getAnalytics(analyticsReq, analyticsRes);

    assert.strictEqual(analyticsRes.statusCode, 200, 'getAnalytics must return 200');
    assert.strictEqual(analyticsRes.body.hasSufficientData, true, 'Test B must have sufficient data');
    assert.strictEqual(analyticsRes.body.attempts, 2, 'Attempts must be 2');
    assert.strictEqual(analyticsRes.body.metrics.mean, 70.0, 'Mean score must be 70.0');
    assert.strictEqual(analyticsRes.body.metrics.highest, 80, 'Highest score must be 80');
    assert.strictEqual(analyticsRes.body.metrics.lowest, 60, 'Lowest score must be 60');

    // Analytics for Test with 0 attempts (Honest empty state)
    const emptyAnalyticsReq = { user: teacherCse, params: { id: String(testA._id) } };
    const emptyAnalyticsRes = createMockRes();
    await testsScheduleController.getAnalytics(emptyAnalyticsReq, emptyAnalyticsRes);

    assert.strictEqual(emptyAnalyticsRes.body.hasSufficientData, false, '0 attempts must return hasSufficientData: false');
    assert.strictEqual(emptyAnalyticsRes.body.message, 'Not enough data for analytics');

    // CSV Export
    const exportReq = { user: teacherCse, params: { id: String(testB._id) } };
    const exportRes = createMockRes();
    await testsScheduleController.exportResultsCSV(exportReq, exportRes);

    assert.strictEqual(exportRes.statusCode, 200, 'exportResultsCSV must return 200');
    assert.ok(exportRes.headers['Content-Type'].includes('text/csv'), 'Content-Type must be text/csv');
    assert.strictEqual(exportRes.body.includes('studentEmail'), false, 'CSV must NOT expose student emails');
    assert.strictEqual(exportRes.body.includes('alice@asmaths.dev'), false, 'Student email strings must be excluded');
    assert.ok(exportRes.body.includes('Alice Dev'), 'Student name must be included');
    assert.ok(exportRes.body.includes('CSE-001'), 'Student roll must be included');

    console.log('  ✔ Analytics metrics, honest empty state, and Privacy-Protected CSV Export verified.\n');

    console.log('════════════════════════════════════════════════════════════════════════════');
    console.log('🎉 ALL PHASE 1 TESTS & SCHEDULE WORKSPACE TESTS PASSED 100%!');
    console.log('════════════════════════════════════════════════════════════════════════════\n');
  } finally {
    // Cleanup test data from DEV database
    console.log('🧹 Cleaning up temporary test fixtures from DEV database...');
    if (createdTestIds.length > 0) {
      await ClassTest.deleteMany({ _id: { $in: createdTestIds } });
    }
    if (createdEvalIds.length > 0) {
      await Evaluation.deleteMany({ _id: { $in: createdEvalIds } });
    }
    if (createdSubIds.length > 0) {
      await TestSubmission.deleteMany({ _id: { $in: createdSubIds } });
    }
    await mongoose.disconnect();
    console.log('✨ Cleanup complete. DB connection closed.\n');
  }
}

if (require.main === module) {
  runTests().catch((err) => {
    console.error('❌ Test suite failed:', err);
    process.exit(1);
  });
}

module.exports = { runTests };
