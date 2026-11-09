/**
 * Answer Key Protection & Role Scoping Security Suite
 * 
 * Verifies:
 * 1. RBAC enforcement: Student access blocked with HTTP 403 on all tests-schedule endpoints.
 * 2. Teacher Course/Branch Isolation: Teachers cannot access or modify tests outside their assigned scope.
 * 3. Deep Payload Scanning: Asserts ZERO leakage of answer keys, correct answers, solutions, or explanations.
 * 4. CSV Formula Injection & Privacy: Asserts no student emails leaked and formula injection tokens are sanitized.
 */

const assert = require('assert');
const path = require('path');
const dotenv = require('dotenv');
const mongoose = require('mongoose');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const testSecret = 'test_answer_key_sec_' + Math.random().toString(36).substring(2) + '_2026';
process.env.JWT_SECRET = testSecret;
process.env.NODE_ENV = 'test';

const { assertDevOrTestDatabase } = require('../utils/dbGuard');
const ClassTest = require('../models/ClassTest');
const Evaluation = require('../models/Evaluation');
const { requireTeacherOrAdmin, authorize } = require('../middleware/authMiddleware');
const testsScheduleController = require('../controllers/testsScheduleController');

function createMockRes() {
  return {
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
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v;
      return this;
    },
  };
}

// Deep scanner looking for sensitive answer key keywords and values
function scanForForbiddenKeysAndValues(obj, forbiddenStrings = [], path = '') {
  const leaks = [];
  if (!obj) return leaks;

  const forbiddenKeys = new Set([
    'answerkey',
    'solutionset',
    'correctanswers',
    'correctoption',
    'correctanswer',
    'solution',
    'explanation',
  ]);

  if (typeof obj === 'string') {
    for (const secret of forbiddenStrings) {
      if (secret && obj.includes(secret)) {
        leaks.push(`Forbidden string "${secret}" found at path ${path}: "${obj}"`);
      }
    }
    return leaks;
  }

  if (Array.isArray(obj)) {
    obj.forEach((item, idx) => {
      leaks.push(...scanForForbiddenKeysAndValues(item, forbiddenStrings, `${path}[${idx}]`));
    });
    return leaks;
  }

  if (typeof obj === 'object') {
    for (const [key, val] of Object.entries(obj)) {
      if (forbiddenKeys.has(key.toLowerCase())) {
        leaks.push(`Forbidden answer key property "${key}" found at path ${path}.${key}`);
      }
      leaks.push(...scanForForbiddenKeysAndValues(val, forbiddenStrings, `${path}.${key}`));
    }
  }

  return leaks;
}

async function runSecurityScanTests() {
  console.log('🔒 Starting Answer Key Protection & Security Scan Suite...\n');

  const rawUri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/asmaths_lms_dev';
  const devUri = rawUri.replace(/\/asmaths_lms(\?|$)/, '/asmaths_lms_dev$1');

  if (mongoose.connection.readyState !== 1) {
    await mongoose.connect(devUri);
  }
  assertDevOrTestDatabase(mongoose.connection.db.databaseName);
  console.log(`✅ DB Safety Guard passed: Connected to ${mongoose.connection.db.databaseName}\n`);

  const secretSolution = 'SECRET_DERIVATION_SOL_xyz_9988';
  const secretExplanation = 'SECRET_EXPLANATION_STEP_BY_STEP_4422';
  const secretCorrectOption = 'SECRET_CORRECT_OPTION_D';

  const testTitle = 'Security Scan MCQ Exam 2026';
  await ClassTest.deleteMany({ title: testTitle });

  const cseTest = await ClassTest.create({
    title: testTitle,
    course: 'B.Tech',
    branch: 'Computer Science',
    semester: 'Semester 1',
    subject: 'Discrete Mathematics',
    durationMinutes: 60,
    fullMarks: 50,
    passingMarks: 20,
    isDraft: false,
    published: true,
    startAt: new Date(Date.now() - 3600000),
    endAt: new Date(Date.now() + 3600000),
    answerKey: 'SECRET_ANSWER_KEY_TOKEN',
    solutionSet: ['A', 'B', 'C', 'SECRET_CORRECT_OPTION_D'],
    correctAnswers: ['SECRET_CORRECT_OPTION_D'],
    questions: [
      {
        questionNumber: 1,
        question: 'Solve for x in 2x + 4 = 10',
        topic: 'Linear Algebra',
        type: 'MCQ',
        marks: 4,
        options: ['1', '2', '3', '4'],
        correctOption: secretCorrectOption,
        correctAnswer: secretCorrectOption,
        solution: secretSolution,
        explanation: secretExplanation,
      },
    ],
  });

  const civilTeacher = {
    id: 'teacher_civil_99',
    role: 'teacher',
    course: 'B.Tech',
    targetCourse: 'B.Tech',
    branch: 'Civil Engineering',
    email: 'teacher.civil@asmaths.edu',
  };

  const cseTeacher = {
    id: 'teacher_cse_101',
    role: 'teacher',
    course: 'B.Tech',
    targetCourse: 'B.Tech',
    branch: 'Computer Science',
    email: 'teacher.cse@asmaths.edu',
  };

  const studentUser = {
    id: 'student_777',
    role: 'student',
    email: 'student.secure@asmaths.edu',
  };

  const adminUser = {
    id: 'admin_master_1',
    role: 'admin',
    email: 'admin.master@asmaths.edu',
  };

  const forbiddenStrings = [
    'SECRET_ANSWER_KEY_TOKEN',
    secretSolution,
    secretExplanation,
    secretCorrectOption,
  ];

  // ──────────────────────────────────────────────────────────────────────────
  // 1. RBAC: Student Role 403 Blocking via requireTeacherOrAdmin Middleware
  // ──────────────────────────────────────────────────────────────────────────
  console.log('--- Test Group 1: Student 403 Forbidden Access Guard ---');
  {
    const req = { user: studentUser };
    const res = createMockRes();
    let nextCalled = false;

    const teacherOrAdminGuard = authorize('teacher', 'admin');
    teacherOrAdminGuard(req, res, () => {
      nextCalled = true;
    });

    assert.strictEqual(res.statusCode, 403, 'Student access must be rejected with HTTP 403');
    assert.strictEqual(nextCalled, false, 'Next middleware must not be invoked for students');
    console.log('✅ Student access rejected with HTTP 403 Forbidden on tests-schedule routes');
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 2. Teacher Course / Branch Isolation (Cross-Branch 403)
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n--- Test Group 2: Teacher Course & Branch Isolation ---');
  {
    // A) getTestDetails across branch
    const req = { user: civilTeacher, params: { id: String(cseTest._id) } };
    const res = createMockRes();
    await testsScheduleController.getTestDetails(req, res);
    assert.strictEqual(res.statusCode, 403, 'Teacher from Civil must receive 403 when accessing CSE test details');
    console.log('✅ Cross-branch test details rejected with HTTP 403');

    // B) reschedule across branch
    const resResched = createMockRes();
    await testsScheduleController.rescheduleTest(
      {
        user: civilTeacher,
        params: { id: String(cseTest._id) },
        body: { newStartAt: new Date().toISOString() },
      },
      resResched
    );
    assert.strictEqual(resResched.statusCode, 403, 'Teacher from Civil must receive 403 when rescheduling CSE test');
    console.log('✅ Cross-branch test reschedule rejected with HTTP 403');

    // C) archive across branch
    const resArch = createMockRes();
    await testsScheduleController.archiveTest(
      { user: civilTeacher, params: { id: String(cseTest._id) } },
      resArch
    );
    assert.strictEqual(resArch.statusCode, 403, 'Teacher from Civil must receive 403 when archiving CSE test');
    console.log('✅ Cross-branch test archive rejected with HTTP 403');

    // D) duplicate across branch
    const resDup = createMockRes();
    await testsScheduleController.duplicateTest(
      { user: civilTeacher, params: { id: String(cseTest._id) } },
      resDup
    );
    assert.strictEqual(resDup.statusCode, 403, 'Teacher from Civil must receive 403 when duplicating CSE test');
    console.log('✅ Cross-branch test duplication rejected with HTTP 403');

    // E) analytics across branch
    const resAna = createMockRes();
    await testsScheduleController.getAnalytics(
      { user: civilTeacher, params: { id: String(cseTest._id) } },
      resAna
    );
    assert.strictEqual(resAna.statusCode, 403, 'Teacher from Civil must receive 403 when requesting CSE test analytics');
    console.log('✅ Cross-branch test analytics rejected with HTTP 403');

    // F) CSV export across branch
    const resExp = createMockRes();
    await testsScheduleController.exportResultsCSV(
      { user: civilTeacher, params: { id: String(cseTest._id) } },
      resExp
    );
    assert.strictEqual(resExp.statusCode, 403, 'Teacher from Civil must receive 403 when exporting CSE test results');
    console.log('✅ Cross-branch CSV export rejected with HTTP 403');
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 3. Deep Answer Key Scanning on All Endpoints
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n--- Test Group 3: Deep Answer Key & Solution Leakage Scan ---');

  // A) GET /overview
  {
    const req = { user: cseTeacher, query: { course: 'B.Tech', branch: 'Computer Science', semester: 'Semester 1' } };
    const res = createMockRes();
    await testsScheduleController.getOverview(req, res);
    assert.strictEqual(res.statusCode, 200);
    const leaks = scanForForbiddenKeysAndValues(res.body, forbiddenStrings, 'overview');
    assert.strictEqual(leaks.length, 0, `Overview response leaked answer data: ${leaks.join(', ')}`);
    console.log('✅ GET /api/tests-schedule/overview: 0 answer keys or solutions leaked');
  }

  // B) GET /list
  {
    const req = { user: cseTeacher, query: { search: 'Security Scan' } };
    const res = createMockRes();
    await testsScheduleController.getTestsList(req, res);
    assert.strictEqual(res.statusCode, 200);
    const leaks = scanForForbiddenKeysAndValues(res.body, forbiddenStrings, 'list');
    assert.strictEqual(leaks.length, 0, `List response leaked answer data: ${leaks.join(', ')}`);
    console.log('✅ GET /api/tests-schedule/list: 0 answer keys or solutions leaked');
  }

  // C) GET /calendar
  {
    const req = { user: cseTeacher, query: {} };
    const res = createMockRes();
    await testsScheduleController.getCalendarEvents(req, res);
    assert.strictEqual(res.statusCode, 200);
    const leaks = scanForForbiddenKeysAndValues(res.body, forbiddenStrings, 'calendar');
    assert.strictEqual(leaks.length, 0, `Calendar response leaked answer data: ${leaks.join(', ')}`);
    console.log('✅ GET /api/tests-schedule/calendar: 0 answer keys or solutions leaked');
  }

  // D) GET /:id/details
  {
    const req = { user: cseTeacher, params: { id: String(cseTest._id) } };
    const res = createMockRes();
    await testsScheduleController.getTestDetails(req, res);
    assert.strictEqual(res.statusCode, 200);
    const leaks = scanForForbiddenKeysAndValues(res.body, forbiddenStrings, 'details');
    assert.strictEqual(leaks.length, 0, `Details response leaked answer data: ${leaks.join(', ')}`);
    console.log('✅ GET /api/tests-schedule/:id/details: 0 answer keys or solutions leaked');
  }

  // E) GET /cohort-analytics
  {
    const req = { user: cseTeacher, query: { course: 'B.Tech', branch: 'Computer Science' } };
    const res = createMockRes();
    await testsScheduleController.getCohortAnalytics(req, res);
    assert.strictEqual(res.statusCode, 200);
    const leaks = scanForForbiddenKeysAndValues(res.body, forbiddenStrings, 'cohortAnalytics');
    assert.strictEqual(leaks.length, 0, `Cohort analytics response leaked answer data: ${leaks.join(', ')}`);
    console.log('✅ GET /api/tests-schedule/cohort-analytics: 0 answer keys or solutions leaked');
  }

  // F) GET /:id/analytics
  {
    // Seed evaluation with question marks to test question difficulty stats
    await Evaluation.deleteMany({ testId: String(cseTest._id) });
    await Evaluation.create({
      testId: String(cseTest._id),
      studentEmail: 'student.victim@asmaths.edu',
      studentRoll: '=HYPERLINK("http://evil.com")',
      studentName: '+cmd|calc',
      marksObtained: 40,
      totalMarks: 50,
      percentage: 80,
      published: true,
      questionMarks: [{ questionNumber: '1', marksAwarded: 4, totalMarks: 4 }],
    });

    const req = { user: cseTeacher, params: { id: String(cseTest._id) } };
    const res = createMockRes();
    await testsScheduleController.getAnalytics(req, res);
    assert.strictEqual(res.statusCode, 200);
    const leaks = scanForForbiddenKeysAndValues(res.body, forbiddenStrings, 'testAnalytics');
    assert.strictEqual(leaks.length, 0, `Test analytics response leaked answer data: ${leaks.join(', ')}`);
    console.log('✅ GET /api/tests-schedule/:id/analytics: 0 answer keys or solutions leaked');
  }

  // G) GET /:id/export (CSV privacy & formula injection)
  {
    const req = { user: cseTeacher, params: { id: String(cseTest._id) } };
    const res = createMockRes();
    await testsScheduleController.exportResultsCSV(req, res);
    assert.strictEqual(res.statusCode, 200);
    const csv = String(res.body || '');

    // Assert student email is NOT present anywhere in CSV
    assert.strictEqual(csv.includes('student.victim@asmaths.edu'), false, 'CSV must not leak student emails');
    assert.strictEqual(csv.includes('Email'), false, 'CSV header must not contain student email column');

    // Assert formula injection sanitization: '=HYPERLINK' must be prefixed with single quote
    assert.ok(csv.includes('\'=HYPERLINK'), 'Formula injection "=" must be prepended with "\'"');
    assert.ok(csv.includes('\'+cmd'), 'Formula injection "+" must be prepended with "\'"');

    console.log('✅ GET /api/tests-schedule/:id/export: Email omitted and formula injection sanitized');
  }

  // Cleanup
  await ClassTest.deleteMany({ title: testTitle });
  await Evaluation.deleteMany({ testId: String(cseTest._id) });

  console.log('\n✨ All Answer Key Protection & Security Scan Tests PASSED successfully!\n');
}

runSecurityScanTests()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ Test failed with error:', err);
    process.exit(1);
  });
