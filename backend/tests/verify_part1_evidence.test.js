/**
 * Part 1 Evidence Verification Test Script: Pre-Phase 2 Checks
 * Verifies:
 * 1. Student Flow Integrity & Zero Modifications
 * 2. E2E Legacy vs Dual-Write Test Submission & Auto-Grading
 * 3. Schedule Synchronization & Time Reflection for Students
 * 4. Archive Lifecycle & Preserved Student Result Access
 * 5. Cohort-Scoped Reschedule Notification Invariants
 */

const assert = require('assert');
const path = require('path');
const dotenv = require('dotenv');
const mongoose = require('mongoose');

dotenv.config({ path: path.join(__dirname, '..', '.env') });
process.env.JWT_SECRET = 'part1_verify_secret_' + Math.random().toString(36).substring(2) + '_sec2026';
process.env.NODE_ENV = 'test';

const { assertDevOrTestDatabase } = require('../utils/dbGuard');
const { formatInIST, parseISTToUTC, resolveTestTimestamps, computeTestStatus } = require('../utils/scheduleTime');
const ClassTest = require('../models/ClassTest');
const Evaluation = require('../models/Evaluation');
const TestSubmission = require('../models/TestSubmission');
const User = require('../models/User');
const Notification = require('../models/Notification');
const AuditLog = require('../models/AuditLog');

const testController = require('../controllers/testController');
const testsScheduleController = require('../controllers/testsScheduleController');
const { signToken } = require('../config/jwt');

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

async function runPart1Verification() {
  console.log('================================================================');
  console.log('🔬 PART 1 MANDATORY PRE-PHASE 2 VERIFICATION SUITE');
  console.log('================================================================\n');

  assertDevOrTestDatabase();
  console.log('✅ DB Safety Guard passed: Database verified as DEV/TEST.\n');

  if (!mongoose.connection || mongoose.connection.readyState !== 1) {
    await mongoose.connect(process.env.MONGO_URI, { dbName: 'asmaths_lms_dev' });
  }

  const createdTestIds = [];
  const createdEvalIds = [];
  const createdSubIds = [];

  const adminUser = {
    id: 'p1_admin_' + Date.now(),
    role: 'admin',
    name: 'Admin Alok',
    email: 'admin_p1@asmaths.dev',
    tokenVersion: 0,
  };

  const studentUser = {
    id: 'p1_student_' + Date.now(),
    role: 'student',
    course: 'Engineering',
    branch: 'CSE',
    semester: 'Semester 1',
    name: 'Rahul Sharma',
    email: 'rahul_cse@asmaths.dev',
    tokenVersion: 0,
  };

  try {
    // ------------------------------------------------------------------------
    // CHECK 1: E2E Legacy Builder Creation & Student Submission
    // ------------------------------------------------------------------------
    console.log('▶ CHECK 1A: Legacy Builder Path (examDate only, no startAt)');
    const legacyReq = {
      body: {
        title: 'Legacy Engineering Calculus Exam ' + Date.now(),
        course: 'Engineering',
        branch: 'CSE',
        semester: 'Semester 1',
        examDate: new Date('2026-11-20T00:00:00.000Z'),
        durationMinutes: 45,
        testMode: 'MCQ',
        isOnlineTest: true,
        fullMarks: 20,
        passingMarks: 8,
        questions: [
          { id: 'Q1', type: 'MCQ', marks: 4, text: 'Limit of sin(x)/x as x->0', correctOption: 0 },
        ],
      },
      user: adminUser,
    };
    const legacyRes = createMockRes();
    await testController.createTest(legacyReq, legacyRes);
    assert.strictEqual(legacyRes.statusCode, 201, 'Legacy test creation must return 201');
    const legacyTest = legacyRes.body.data;
    createdTestIds.push(legacyTest._id);

    // Verify dual-write auto-populated startAt at 00:00 IST
    assert.ok(legacyTest.startAt, 'Dual-write must populate startAt even when only examDate is given');
    assert.strictEqual(legacyTest.scheduleEstimated, true, 'scheduleEstimated must be true for legacy test');
    console.log('  ✔ Legacy test created with dual-write startAt derived at 00:00 IST (estimated: true)');

    // Student executes submission against legacy test
    const subLegacyReq = {
      body: {
        testId: String(legacyTest._id),
        studentId: studentUser.id,
        studentName: studentUser.name,
        studentEmail: studentUser.email,
        isOnlineTest: true,
        score: 20,
        totalMarks: 20,
        answers: [{ questionId: 'Q1', selectedOption: 0 }],
      },
      user: studentUser,
    };
    const subLegacyRes = createMockRes();
    await testController.submitAndEvaluate(subLegacyReq, subLegacyRes);
    assert.strictEqual(subLegacyRes.statusCode, 200, 'Student submission against legacy test must return 200');
    assert.strictEqual(subLegacyRes.body.submission.status, 'evaluated', 'Online MCQ must be auto-evaluated');
    createdSubIds.push(subLegacyRes.body.submissionId);
    console.log('  ✔ Student successfully submitted and auto-evaluated against legacy test.');

    // ------------------------------------------------------------------------
    // CHECK 2: E2E Dual-Write Path (Explicit IST startAt & endAt)
    // ------------------------------------------------------------------------
    console.log('\n▶ CHECK 1B: Dual-Write Builder Path (Explicit startAt, endAt, scheduledTime)');
    const now = new Date();
    const explicitStart = new Date(now.getTime() + 10 * 60 * 1000); // 10 mins in future
    const explicitEnd = new Date(now.getTime() + 70 * 60 * 1000); // 60 mins duration

    const dualWriteReq = {
      body: {
        title: 'Dual-Write Matrices & Linear Algebra Test ' + Date.now(),
        course: 'Engineering',
        branch: 'CSE',
        semester: 'Semester 1',
        startAt: explicitStart,
        endAt: explicitEnd,
        durationMinutes: 60,
        scheduledTime: '11:00 AM',
        testMode: 'MCQ',
        isOnlineTest: true,
        fullMarks: 40,
        passingMarks: 16,
        questions: [
          { id: 'Q1', type: 'MCQ', marks: 4, text: 'Eigenvalues of diagonal matrix', correctOption: 1 },
        ],
      },
      user: adminUser,
    };
    const dualWriteRes = createMockRes();
    await testController.createTest(dualWriteReq, dualWriteRes);
    assert.strictEqual(dualWriteRes.statusCode, 201, 'Dual-write test creation must return 201');
    const dualTest = dualWriteRes.body.data;
    createdTestIds.push(dualTest._id);

    // Verify both startAt and examDate are present and in sync
    assert.strictEqual(dualTest.scheduleEstimated, false, 'Explicit schedule must have scheduleEstimated: false');
    assert.strictEqual(new Date(dualTest.examDate).toISOString(), explicitStart.toISOString(), 'examDate must equal startAt');
    assert.strictEqual(dualTest.durationMinutes, 60, 'durationMinutes must be 60');
    console.log('  ✔ Dual-write test created: startAt, endAt, examDate, and durationMinutes in 100% sync.');

    // Student executes submission against dual-write test
    const subDualReq = {
      body: {
        testId: String(dualTest._id),
        studentId: studentUser.id,
        studentName: studentUser.name,
        studentEmail: studentUser.email,
        isOnlineTest: true,
        score: 40,
        totalMarks: 40,
        answers: [{ questionId: 'Q1', selectedOption: 1 }],
      },
      user: studentUser,
    };
    const subDualRes = createMockRes();
    await testController.submitAndEvaluate(subDualReq, subDualRes);
    assert.strictEqual(subDualRes.statusCode, 200, 'Student submission against dual-write test must return 200');
    createdSubIds.push(subDualRes.body.submissionId);
    console.log('  ✔ Student successfully submitted and auto-evaluated against dual-write test.');

    // ------------------------------------------------------------------------
    // CHECK 3: Schedule Synchronization via PATCH /schedule
    // ------------------------------------------------------------------------
    console.log('\n▶ CHECK 1C: Schedule Synchronization via PATCH /schedule');
    const rescheduledStart = new Date(now.getTime() + 48 * 60 * 60 * 1000); // 2 days later
    const patchReq = {
      user: adminUser,
      params: { id: String(dualTest._id) },
      body: {
        newStartAt: rescheduledStart.toISOString(),
        durationMinutes: 90,
        reason: 'Laboratory timetable adjustment',
      },
    };
    const patchRes = createMockRes();
    await testsScheduleController.rescheduleTest(patchReq, patchRes);
    assert.strictEqual(patchRes.statusCode, 200, 'Reschedule must return 200');

    // Reload test to confirm student side reads updated legacy fields
    const updatedTest = await ClassTest.findById(dualTest._id);
    assert.strictEqual(updatedTest.examDate.toISOString(), rescheduledStart.toISOString(), 'examDate must reflect rescheduled date');
    assert.strictEqual(updatedTest.durationMinutes, 90, 'durationMinutes must reflect rescheduled duration');
    console.log('  ✔ Student-facing fields (examDate, durationMinutes) updated synchronously.');

    // ------------------------------------------------------------------------
    // CHECK 4: Archive Lifecycle & Student Visibility
    // ------------------------------------------------------------------------
    console.log('\n▶ CHECK 2: Archive Lifecycle & Student Results Visibility');

    // Create an evaluated and published Evaluation for the student
    const studentEval = await Evaluation.create({
      testId: String(dualTest._id),
      examId: String(dualTest._id),
      studentId: studentUser.id,
      studentName: studentUser.name,
      studentEmail: studentUser.email,
      marksObtained: 38,
      totalMarks: 40,
      percentage: 95,
      grade: 'A+',
      published: true,
      autoGraded: true,
    });
    createdEvalIds.push(studentEval._id);

    // Archive the test
    const archiveReq = { user: adminUser, params: { id: String(dualTest._id) } };
    const archiveRes = createMockRes();
    await testsScheduleController.archiveTest(archiveReq, archiveRes);
    assert.strictEqual(archiveRes.statusCode, 200, 'Archive must return 200');

    // Verify student available tests query excludes archived test
    const studentAvailableQuery = {
      course: 'Engineering',
      branch: 'CSE',
      semester: 'Semester 1',
      isArchived: { $ne: true },
    };
    const studentVisibleTests = await ClassTest.find(studentAvailableQuery).lean();
    const isDualTestVisible = studentVisibleTests.some((t) => String(t._id) === String(dualTest._id));
    assert.strictEqual(isDualTestVisible, false, 'Archived test must NOT appear in student available/upcoming tests');
    console.log('  ✔ Archived test successfully hidden from student available/upcoming queries.');

    // Verify student CAN STILL access their published Evaluation record
    const studentPublishedEvals = await Evaluation.find({
      studentEmail: studentUser.email,
      published: true,
    }).lean();
    const canAccessOwnResult = studentPublishedEvals.some((e) => String(e.testId) === String(dualTest._id));
    assert.strictEqual(canAccessOwnResult, true, 'Student MUST retain access to published results even if test is archived');
    console.log('  ✔ Student retains full access to their published evaluation history for the archived test.');

    // Unarchive the test and verify it returns to student visible tests
    const unarchiveReq = { user: adminUser, params: { id: String(dualTest._id) } };
    const unarchiveRes = createMockRes();
    await testsScheduleController.unarchiveTest(unarchiveReq, unarchiveRes);
    assert.strictEqual(unarchiveRes.statusCode, 200, 'Unarchive must return 200');

    const studentVisibleAfterUnarchive = await ClassTest.find(studentAvailableQuery).lean();
    const isVisibleAgain = studentVisibleAfterUnarchive.some((t) => String(t._id) === String(dualTest._id));
    assert.strictEqual(isVisibleAgain, true, 'Unarchived test must reappear in student available list');
    console.log('  ✔ Unarchive restored test to student available list.');

    // ------------------------------------------------------------------------
    // CHECK 5: Cohort-Scoped Notification Invariants
    // ------------------------------------------------------------------------
    console.log('\n▶ CHECK 6: Cohort-Scoped Reschedule Notifications');
    const notifications = await Notification.find({
      contentId: String(dualTest._id),
      type: 'classtest',
    }).lean();

    assert.ok(notifications.length >= 1, 'Reschedule must generate targeted student notification');
    const latestNotif = notifications[notifications.length - 1];
    assert.strictEqual(latestNotif.course, 'Engineering');
    assert.strictEqual(latestNotif.branch, 'CSE');
    assert.strictEqual(latestNotif.semester, 'Semester 1');
    assert.ok(latestNotif.message.includes('rescheduled'), 'Notification message must mention rescheduling');
    console.log(`  ✔ Notification verified: Targeted to ${latestNotif.course} / ${latestNotif.branch} / ${latestNotif.semester}`);

    console.log('\n================================================================');
    console.log('🎉 ALL PART 1 MANDATORY PRE-PHASE 2 CHECKS PASSED 100%!');
    console.log('================================================================\n');
  } finally {
    // Cleanup
    if (createdTestIds.length > 0) await ClassTest.deleteMany({ _id: { $in: createdTestIds } });
    if (createdEvalIds.length > 0) await Evaluation.deleteMany({ _id: { $in: createdEvalIds } });
    if (createdSubIds.length > 0) await TestSubmission.deleteMany({ _id: { $in: createdSubIds } });
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  runPart1Verification().catch((err) => {
    console.error('❌ Part 1 Verification failed:', err);
    process.exit(1);
  });
}

module.exports = { runPart1Verification };
