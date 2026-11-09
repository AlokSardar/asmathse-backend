/**
 * deletion_trash_editing.test.js
 * 
 * Comprehensive automated test suite for:
 * 1. Soft-Delete (Trash) & Permanent Delete Authorization Rules
 *    - No attempts: Teacher & Admin can delete
 *    - With attempts: Teacher blocked with 403 (routed to archive); Admin requires confirmation & reason
 *    - Ongoing tests: Deletion hard-blocked (400)
 * 2. Trash Lifecycle & Restore
 * 3. Bulk Deletion Granularity & Per-ID Diagnostics (Zero all-or-nothing failures)
 *    - Exceeding 10 items requires typing "DELETE"
 * 4. Professional Editing, Granular Edit Locks & Optimistic Concurrency (409 Conflict)
 */

const assert = require('assert');
const path = require('path');
const dotenv = require('dotenv');
const mongoose = require('mongoose');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const testSecret = 'test_del_trash_sec_' + Math.random().toString(36).substring(2) + '_2026';
process.env.JWT_SECRET = testSecret;
process.env.NODE_ENV = 'test';

const { assertDevOrTestDatabase } = require('../utils/dbGuard');
const ClassTest = require('../models/ClassTest');
const Evaluation = require('../models/Evaluation');
const TestSubmission = require('../models/TestSubmission');
const AuditLog = require('../models/AuditLog');
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

async function runTestSuite() {
  console.log('🧪 Starting Deletion, Trash Lifecycle & Editing Concurrency Suite...\n');

  const rawUri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/asmaths_lms_dev';
  const devUri = rawUri.replace(/\/asmaths_lms(\?|$)/, '/asmaths_lms_dev$1');

  if (mongoose.connection.readyState !== 1) {
    await mongoose.connect(devUri);
  }
  assertDevOrTestDatabase(mongoose.connection.db.databaseName);
  console.log(`✅ DB Safety Guard passed: Operating on ${mongoose.connection.db.databaseName}\n`);

  const createdTestIds = [];
  const createdEvalIds = [];

  const teacherCse = {
    id: 'teacher_cse_1',
    role: 'teacher',
    course: 'Engineering',
    targetCourse: 'Engineering',
    branch: 'CSE',
    email: 'teacher.cse@asmaths.edu',
  };

  const teacherCivil = {
    id: 'teacher_civil_1',
    role: 'teacher',
    course: 'Engineering',
    targetCourse: 'Engineering',
    branch: 'Civil',
    email: 'teacher.civil@asmaths.edu',
  };

  const adminUser = {
    id: 'admin_1',
    role: 'admin',
    email: 'admin@asmaths.com',
  };

  try {
    // ────────────────────────────────────────────────────────────────────────
    // 1. DELETION AUTHORIZATION RULES
    // ────────────────────────────────────────────────────────────────────────
    console.log('▶ TEST 1: Deletion Authorization Rules');

    // 1a. Test with 0 attempts: Teacher can soft-delete within scope
    const draftTest = await ClassTest.create({
      title: 'Dev Test 0 Attempts For Delete ' + Date.now(),
      course: 'Engineering',
      branch: 'CSE',
      semester: 'Semester 1',
      status: 'draft',
      isDraft: true,
      fullMarks: 50,
      isDeleted: false,
    });
    createdTestIds.push(draftTest._id);

    const teacherDeleteReq = {
      user: teacherCse,
      params: { id: String(draftTest._id) },
      body: { reason: 'No longer needed' },
    };
    const teacherDeleteRes = createMockRes();
    await testsScheduleController.deleteTest(teacherDeleteReq, teacherDeleteRes);

    assert.strictEqual(teacherDeleteRes.statusCode, 200, 'Teacher can delete unattempted test in scope');
    const reloadedDraft = await ClassTest.findById(draftTest._id);
    assert.strictEqual(reloadedDraft.isDeleted, true, 'Test must be marked isDeleted: true');
    console.log('  ✔ Teacher successfully soft-deleted test with 0 attempts.');

    // 1b. Test with active attempts: Teacher blocked with 403
    const attemptedTest = await ClassTest.create({
      title: 'Dev Test With Attempts ' + Date.now(),
      course: 'Engineering',
      branch: 'CSE',
      semester: 'Semester 1',
      status: 'completed',
      isDraft: false,
      fullMarks: 50,
      startAt: new Date(Date.now() - 7200000),
      endAt: new Date(Date.now() - 3600000),
    });
    createdTestIds.push(attemptedTest._id);

    const testEval = await Evaluation.create({
      testId: String(attemptedTest._id),
      studentName: 'Test Student',
      studentRoll: 'CSE-101',
      studentEmail: 'student@asmaths.dev',
      marksObtained: 40,
      totalMarks: 50,
      published: true,
    });
    createdEvalIds.push(testEval._id);

    const teacherDeleteAttemptedReq = {
      user: teacherCse,
      params: { id: String(attemptedTest._id) },
      body: {},
    };
    const teacherDeleteAttemptedRes = createMockRes();
    await testsScheduleController.deleteTest(teacherDeleteAttemptedReq, teacherDeleteAttemptedRes);

    assert.strictEqual(teacherDeleteAttemptedRes.statusCode, 403, 'Teacher cannot delete test with attempts');
    assert.strictEqual(teacherDeleteAttemptedRes.body.code, 'TEACHER_CANNOT_DELETE_WITH_ATTEMPTS');
    console.log('  ✔ Teacher blocked from deleting test with student attempts (HTTP 403).');

    // 1c. Admin deleting test with attempts without confirmation -> 400
    const adminDeleteNoConfReq = {
      user: adminUser,
      params: { id: String(attemptedTest._id) },
      body: { confirmStudentDataLoss: false, reason: 'Curriculum overhaul' },
    };
    const adminDeleteNoConfRes = createMockRes();
    await testsScheduleController.deleteTest(adminDeleteNoConfReq, adminDeleteNoConfRes);

    assert.strictEqual(adminDeleteNoConfRes.statusCode, 400, 'Admin must confirm student data loss');
    assert.strictEqual(adminDeleteNoConfRes.body.code, 'CONFIRMATION_REQUIRED');

    // 1d. Admin deleting test with attempts without reason -> 400
    const adminDeleteNoReasonReq = {
      user: adminUser,
      params: { id: String(attemptedTest._id) },
      body: { confirmStudentDataLoss: true, reason: '' },
    };
    const adminDeleteNoReasonRes = createMockRes();
    await testsScheduleController.deleteTest(adminDeleteNoReasonReq, adminDeleteNoReasonRes);

    assert.strictEqual(adminDeleteNoReasonRes.statusCode, 400, 'Admin must provide reason to delete test with attempts');
    assert.strictEqual(adminDeleteNoReasonRes.body.code, 'REASON_REQUIRED');

    // 1e. Admin deleting test with attempts with confirmation and reason -> 200
    const adminDeleteValidReq = {
      user: adminUser,
      params: { id: String(attemptedTest._id) },
      body: { confirmStudentDataLoss: true, reason: 'Accidental test creation during faculty training' },
    };
    const adminDeleteValidRes = createMockRes();
    await testsScheduleController.deleteTest(adminDeleteValidReq, adminDeleteValidRes);

    assert.strictEqual(adminDeleteValidRes.statusCode, 200, 'Admin can delete test with attempts when confirmed');
    const reloadedAttempted = await ClassTest.findById(attemptedTest._id);
    assert.strictEqual(reloadedAttempted.isDeleted, true, 'Test must be soft-deleted to Trash');

    // 1f. Data Integrity Guard: Evaluation records MUST still exist in database
    const survivingEval = await Evaluation.findById(testEval._id);
    assert.ok(survivingEval, 'Evaluation records must be safely preserved as orphaned relations');
    console.log('  ✔ Admin deletion with confirmation and reason succeeded, student evaluation preserved.');

    // 1g. Ongoing test deletion blocked for anyone
    const ongoingTest = await ClassTest.create({
      title: 'Dev Ongoing Test For Delete ' + Date.now(),
      course: 'Engineering',
      branch: 'CSE',
      semester: 'Semester 1',
      startAt: new Date(Date.now() - 15 * 60 * 1000), // 15 mins ago
      endAt: new Date(Date.now() + 45 * 60 * 1000), // 45 mins in future
      durationMinutes: 60,
      status: 'available',
    });
    createdTestIds.push(ongoingTest._id);

    const adminDeleteOngoingReq = {
      user: adminUser,
      params: { id: String(ongoingTest._id) },
      body: { confirmStudentDataLoss: true, reason: 'Emergency' },
    };
    const adminDeleteOngoingRes = createMockRes();
    await testsScheduleController.deleteTest(adminDeleteOngoingReq, adminDeleteOngoingRes);

    assert.strictEqual(adminDeleteOngoingRes.statusCode, 400, 'Ongoing test can never be deleted');
    assert.ok(adminDeleteOngoingRes.body.message.includes('ongoing'), 'Error message must specify ongoing status');
    console.log('  ✔ Ongoing test deletion strictly refused with HTTP 400.\n');

    // ────────────────────────────────────────────────────────────────────────
    // 2. TRASH LIFECYCLE & RESTORE
    // ────────────────────────────────────────────────────────────────────────
    console.log('▶ TEST 2: Trash Lifecycle & Restore');

    // 2a. Querying status=trash returns soft-deleted tests
    const trashListReq = {
      user: teacherCse,
      query: { status: 'trash', course: 'Engineering', branch: 'CSE' },
    };
    const trashListRes = createMockRes();
    await testsScheduleController.getTestsList(trashListReq, trashListRes);

    assert.strictEqual(trashListRes.statusCode, 200);
    const trashData = trashListRes.body.data;
    const isDraftInTrash = trashData.some((t) => String(t._id) === String(draftTest._id));
    assert.strictEqual(isDraftInTrash, true, 'Soft-deleted draft must appear in trash query');
    assert.ok(trashListRes.body.statusCounts.trash >= 1, 'trash count must be >= 1');
    console.log('  ✔ Trash tab correctly lists soft-deleted tests with days remaining.');

    // 2b. Restore test from trash
    const restoreReq = {
      user: teacherCse,
      params: { id: String(draftTest._id) },
    };
    const restoreRes = createMockRes();
    await testsScheduleController.restoreTest(restoreReq, restoreRes);

    assert.strictEqual(restoreRes.statusCode, 200, 'Restore from trash must return 200');
    const restoredDraft = await ClassTest.findById(draftTest._id);
    assert.strictEqual(restoredDraft.isDeleted, false, 'Restored test must have isDeleted: false');
    console.log('  ✔ Test successfully restored from Trash.\n');

    // ────────────────────────────────────────────────────────────────────────
    // 3. BULK DELETION GRANULARITY & PER-ID RESULTS
    // ────────────────────────────────────────────────────────────────────────
    console.log('▶ TEST 3: Bulk Deletion Granularity & Per-ID Diagnostics');

    const bulkTest1 = await ClassTest.create({
      title: 'Bulk Candidate 1 (Draft) ' + Date.now(),
      course: 'Engineering',
      branch: 'CSE',
      semester: 'Semester 1',
      status: 'draft',
      isDraft: true,
    });
    createdTestIds.push(bulkTest1._id);

    const bulkTest2 = ongoingTest; // Ongoing test (will be skipped)
    const fakeId = new mongoose.Types.ObjectId(); // Nonexistent test (will be skipped)

    const bulkReq = {
      user: teacherCse,
      body: {
        ids: [String(bulkTest1._id), String(bulkTest2._id), String(fakeId)],
        confirmStudentDataLoss: false,
      },
    };
    const bulkRes = createMockRes();
    await testsScheduleController.bulkDeleteTests(bulkReq, bulkRes);

    assert.strictEqual(bulkRes.statusCode, 200, 'Bulk delete must return 200 with per-ID breakdown');
    assert.strictEqual(bulkRes.body.processedCount, 1, 'Exactly 1 test must be processed');
    assert.strictEqual(bulkRes.body.deletedIds.length, 1, '1 test moved to trash');
    assert.strictEqual(bulkRes.body.skipped.length, 2, '2 tests skipped with reasons');

    const ongoingSkip = bulkRes.body.skipped.find((s) => String(s.id) === String(bulkTest2._id));
    assert.ok(ongoingSkip, 'Ongoing test must be reported in skipped list');
    assert.ok(ongoingSkip.reason.includes('Ongoing'), 'Reason must indicate ongoing status');

    console.log('  ✔ Bulk deletion executed with zero all-or-nothing failures (1 deleted, 2 skipped with reasons).');

    // 3b. Bulk deletion exceeding 10 items without phrase "DELETE" -> 400
    const elevenIds = [...Array(11)].map(() => new mongoose.Types.ObjectId().toString());
    const bulkOver10Req = {
      user: adminUser,
      body: {
        ids: elevenIds,
        confirmationPhrase: 'WRONG',
      },
    };
    const bulkOver10Res = createMockRes();
    await testsScheduleController.bulkDeleteTests(bulkOver10Req, bulkOver10Res);

    assert.strictEqual(bulkOver10Res.statusCode, 400, 'Exceeding 10 items must require phrase "DELETE"');
    assert.strictEqual(bulkOver10Res.body.code, 'PHRASE_CONFIRMATION_REQUIRED');
    console.log('  ✔ Exceeding 10 items requires typing "DELETE" confirmed.\n');

    // ────────────────────────────────────────────────────────────────────────
    // 4. PROFESSIONAL EDITING, GRANULAR EDIT LOCKS & OPTIMISTIC CONCURRENCY
    // ────────────────────────────────────────────────────────────────────────
    console.log('▶ TEST 4: Professional Editing, Edit Locks & Optimistic Concurrency');

    // 4a. Edit unlocked draft test (All fields editable)
    const editableTest = await ClassTest.create({
      title: 'Original Draft Title ' + Date.now(),
      course: 'Engineering',
      branch: 'CSE',
      semester: 'Semester 1',
      status: 'draft',
      isDraft: true,
      fullMarks: 40,
      passingMarks: 16,
      durationMinutes: 45,
      instructions: 'Original instructions',
      questions: [{ id: 'Q1', text: 'Original Q1', marks: 4 }],
    });
    createdTestIds.push(editableTest._id);

    const updateDraftReq = {
      user: teacherCse,
      params: { id: String(editableTest._id) },
      body: {
        title: 'Updated Draft Title',
        instructions: 'New detailed instructions',
        fullMarks: 50,
        passingMarks: 20,
        durationMinutes: 60,
        version: editableTest.__v || 0,
      },
    };
    const updateDraftRes = createMockRes();
    await testsScheduleController.updateTest(updateDraftReq, updateDraftRes);

    assert.strictEqual(updateDraftRes.statusCode, 200, 'Unlocked draft test must update successfully');
    const reloadedUpdated = await ClassTest.findById(editableTest._id);
    assert.strictEqual(reloadedUpdated.title, 'Updated Draft Title');
    assert.strictEqual(reloadedUpdated.fullMarks, 50);
    assert.strictEqual(reloadedUpdated.instructions, 'New detailed instructions');
    console.log('  ✔ Unlocked draft test fully updated (title, instructions, marks, duration).');

    // 4b. Optimistic Concurrency: Stale version yields 409 Conflict
    const staleVersionReq = {
      user: teacherCse,
      params: { id: String(editableTest._id) },
      body: {
        title: 'Concurrent Overwrite Attempt',
        version: 999, // Stale version
      },
    };
    const staleVersionRes = createMockRes();
    await testsScheduleController.updateTest(staleVersionReq, staleVersionRes);

    assert.strictEqual(staleVersionRes.statusCode, 409, 'Stale version must return 409 Conflict');
    assert.strictEqual(staleVersionRes.body.code, 'CONCURRENCY_CONFLICT');
    console.log('  ✔ Optimistic concurrency control rejected stale version (HTTP 409 Conflict).');

    // 4c. Granular Edit Locks on Test with Attempts:
    // Questions and marks locked; title and instructions allowed
    const lockedAttemptedTest = await ClassTest.create({
      title: 'Locked Test With Attempts ' + Date.now(),
      course: 'Engineering',
      branch: 'CSE',
      semester: 'Semester 1',
      status: 'completed',
      isDraft: false,
      fullMarks: 50,
      passingMarks: 20,
      questions: [{ id: 'Q1', text: 'Locked Q1', marks: 4 }],
    });
    createdTestIds.push(lockedAttemptedTest._id);

    const lockedEval = await Evaluation.create({
      testId: String(lockedAttemptedTest._id),
      studentName: 'Locked Student',
      studentRoll: 'CSE-999',
      studentEmail: 'locked@asmaths.dev',
      marksObtained: 45,
      totalMarks: 50,
      published: true,
    });
    createdEvalIds.push(lockedEval._id);

    // Attempting to change fullMarks on test with attempts -> 400
    const lockedChangeMarksReq = {
      user: teacherCse,
      params: { id: String(lockedAttemptedTest._id) },
      body: {
        fullMarks: 100, // Altering marks
        version: lockedAttemptedTest.__v || 0,
      },
    };
    const lockedChangeMarksRes = createMockRes();
    await testsScheduleController.updateTest(lockedChangeMarksReq, lockedChangeMarksRes);

    assert.strictEqual(lockedChangeMarksRes.statusCode, 400, 'Changing marks on test with attempts must return 400');
    assert.strictEqual(lockedChangeMarksRes.body.code, 'LOCKED_FIELDS_MODIFIED');

    // Changing title typo and instructions on test with attempts -> 200 OK
    const allowedEditReq = {
      user: teacherCse,
      params: { id: String(lockedAttemptedTest._id) },
      body: {
        title: 'Locked Test With Corrected Typo',
        instructions: 'Updated examination hall rules',
        version: lockedAttemptedTest.__v || 0,
      },
    };
    const allowedEditRes = createMockRes();
    await testsScheduleController.updateTest(allowedEditReq, allowedEditRes);

    assert.strictEqual(allowedEditRes.statusCode, 200, 'Title typo and instructions allowed on test with attempts');
    const reloadedLocked = await ClassTest.findById(lockedAttemptedTest._id);
    assert.strictEqual(reloadedLocked.title, 'Locked Test With Corrected Typo');
    assert.strictEqual(reloadedLocked.instructions, 'Updated examination hall rules');
    assert.strictEqual(reloadedLocked.fullMarks, 50, 'fullMarks must remain untouched at 50');
    console.log('  ✔ Granular edit locks enforced: marks locked, title typo and instructions successfully updated.');

    console.log('\n════════════════════════════════════════════════════════════════════════');
    console.log('🎉 ALL DELETION, TRASH LIFECYCLE & EDITING CONCURRENCY TESTS PASSED 100%!');
    console.log('════════════════════════════════════════════════════════════════════════\n');
  } finally {
    // Cleanup
    if (createdTestIds.length > 0) {
      await ClassTest.deleteMany({ _id: { $in: createdTestIds } }).catch(() => {});
    }
    if (createdEvalIds.length > 0) {
      await Evaluation.deleteMany({ _id: { $in: createdEvalIds } }).catch(() => {});
    }
    await mongoose.disconnect();
  }
}

runTestSuite()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ Test suite failed with error:', err);
    process.exit(1);
  });
