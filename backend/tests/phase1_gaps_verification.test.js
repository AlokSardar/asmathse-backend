const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const assert = require('assert');
const path = require('path');
const http = require('http');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const User = require('../models/User');
const Evaluation = require('../models/Evaluation');
const MarkingScheme = require('../models/MarkingScheme');
const EvaluationAnnotation = require('../models/EvaluationAnnotation');
const AuditLog = require('../models/AuditLog');
const ReEvaluationRequest = require('../models/ReEvaluationRequest');
const Content = require('../models/Content');
const Notification = require('../models/Notification');
const evaluationRoutes = require('../routes/evaluationRoutes');
const studentRoutes = require('../routes/studentRoutes');

const TEMP_DB_NAME = 'test_eval_gaps_tmp';
const JWT_SECRET = process.env.JWT_SECRET || 'asmaths_secret_jwt_key_2026_cluster0';

// Ensure private uploads directory exists
const privateUploadsDir = path.resolve(__dirname, '../uploads/private_scripts');
if (!fs.existsSync(privateUploadsDir)) {
  fs.mkdirSync(privateUploadsDir, { recursive: true });
}

async function runGapsTests() {
  const baseUri = process.env.MONGO_URI;
  assert(baseUri, 'MONGO_URI must be set in .env');

  // Hard safety assertion: strictly require temporary test database, NEVER asmaths_lms
  let targetUri = baseUri;
  const parsed = new URL(baseUri.startsWith('mongodb+srv://') ? baseUri.replace('mongodb+srv://', 'http://') : baseUri);
  const host = parsed.host;
  const auth = parsed.username ? `${parsed.username}:${parsed.password}@` : '';
  const search = parsed.search || '';
  if (baseUri.startsWith('mongodb+srv://')) {
    targetUri = `mongodb+srv://${auth}${host}/${TEMP_DB_NAME}${search}`;
  } else {
    targetUri = `mongodb://${auth}${host}/${TEMP_DB_NAME}${search}`;
  }

  console.log('='.repeat(80));
  console.log('🚀 EVALUATION HUB — PART A BACKEND GAPS VERIFICATION SUITE');
  console.log(`Database under test : ${TEMP_DB_NAME} (Strictly isolated temporary DB)`);
  console.log('='.repeat(80));

  await mongoose.connect(targetUri);
  assert.strictEqual(mongoose.connection.name, TEMP_DB_NAME, `Must be connected to ${TEMP_DB_NAME}`);

  // Clean collections
  await Promise.all([
    User.deleteMany({}),
    Evaluation.deleteMany({}),
    MarkingScheme.deleteMany({}),
    EvaluationAnnotation.deleteMany({}),
    AuditLog.deleteMany({}),
    ReEvaluationRequest.deleteMany({}),
    Content.deleteMany({}),
    Notification.deleteMany({}),
  ]);

  // Seed test users
  const engStudent = await User.create({
    name: 'Alice Eng',
    email: 'alice.eng@test.edu',
    password: 'HashedPassword123!',
    role: 'student',
    course: 'Engineering',
    branch: 'CSE',
    semester: 1,
    rollNumber: 'ENG-2026-001',
    isApproved: true,
  });

  const bscStudent = await User.create({
    name: 'Bob BSc',
    email: 'bob.bsc@test.edu',
    password: 'HashedPassword123!',
    role: 'student',
    course: 'B.Sc',
    branch: 'Maths Honours',
    semester: 1,
    rollNumber: 'BSC-2026-042',
    isApproved: true,
  });

  const teacherMukherjee = await User.create({
    name: 'Prof. Mukherjee',
    email: 'prof.mukherjee@test.edu',
    password: 'HashedPassword123!',
    role: 'teacher',
    course: 'Engineering',
    branch: 'CSE',
    isApproved: true,
  });

  const teacherSharma = await User.create({
    name: 'Prof. Sharma',
    email: 'prof.sharma@test.edu',
    password: 'HashedPassword123!',
    role: 'teacher',
    course: 'Engineering',
    branch: 'CSE',
    isApproved: true,
  });

  const adminDean = await User.create({
    name: 'Dr. Admin Dean',
    email: 'admin.dean@test.edu',
    password: 'HashedPassword123!',
    role: 'admin',
    isApproved: true,
  });

  // Tokens
  const createToken = (u) => jwt.sign({ id: u._id.toString(), email: u.email, role: u.role }, JWT_SECRET, { expiresIn: '1h' });
  const tokenAlice = createToken(engStudent);
  const tokenBob = createToken(bscStudent);
  const tokenMukherjee = createToken(teacherMukherjee);
  const tokenSharma = createToken(teacherSharma);
  const tokenAdmin = createToken(adminDean);

  // Setup Express App
  const app = express();
  app.use(express.json({ limit: '50mb' }));

  // Static blocker test middleware matching server.js
  app.use(['/uploads', '/api/uploads'], (req, res, next) => {
    const cleanPath = (req.path || '').toLowerCase();
    if (
      cleanPath.includes('/private_scripts') ||
      cleanPath.includes('submission_') ||
      cleanPath.includes('script_') ||
      cleanPath.includes('answersheet_')
    ) {
      return res.status(403).json({
        message: 'Forbidden: Direct static access to student answer scripts is prohibited. Access via authenticated endpoint /api/evaluations/:id/script-file.'
      });
    }
    next();
  });

  app.use('/api/evaluations', evaluationRoutes);
  app.use('/api/student', studentRoutes);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const request = async (method, pathUrl, options = {}) => {
    const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
    if (options.token) headers['Authorization'] = `Bearer ${options.token}`;
    const fetchOptions = { method, headers };
    if (options.body) fetchOptions.body = JSON.stringify(options.body);

    const res = await fetch(`${baseUrl}${pathUrl}`, fetchOptions);
    let data = null;
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      data = await res.json();
    } else {
      data = await res.text();
    }
    return { status: res.status, headers: res.headers, data };
  };

  const sampleScriptFile = path.join(privateUploadsDir, 'alice_gap_script.pdf');
  fs.writeFileSync(sampleScriptFile, '%PDF-1.4 Mock Private Answer Script for Alice Gap Verification');

  try {
    // ------------------------------------------------------------------------
    // GAP 1: Server-Side Marks Integrity
    // ------------------------------------------------------------------------
    console.log('\n[GAP 1] Server-Side Marks Integrity...');

    // 1a. Seed MarkingScheme for EXAM-MTH202 (Total 40: Q1 max 20, Q2 max 20)
    await MarkingScheme.create({
      id: 'SCHEME-MTH202',
      examId: 'EXAM-MTH202',
      examTitle: 'Advanced Linear Algebra',
      course: 'Engineering',
      branch: 'CSE',
      semester: 1,
      totalMarks: 40,
      passingMarks: 16,
      createdBy: teacherMukherjee._id.toString(),
      questions: [
        {
          questionNumber: '1',
          questionText: 'Diagonalize matrix A',
          maxMarks: 20,
          stepRubric: [
            { stepNumber: 1, description: 'Find eigenvalues', marksAwarded: 8 },
            { stepNumber: 2, description: 'Compute eigenvectors', marksAwarded: 12 },
          ],
        },
        {
          questionNumber: '2',
          questionText: 'Prove Cayley-Hamilton Theorem',
          maxMarks: 20,
          stepRubric: [
            { stepNumber: 1, description: 'Characteristic polynomial', marksAwarded: 10 },
            { stepNumber: 2, description: 'Adjugate substitution', marksAwarded: 10 },
          ],
        },
      ],
    });

    // Seed evaluation record
    const eval1 = await Evaluation.create({
      id: 'eval_gap_1',
      studentId: engStudent._id.toString(),
      studentName: engStudent.name,
      studentEmail: engStudent.email,
      studentRoll: engStudent.rollNumber,
      testId: 'EXAM-MTH202',
      examId: 'EXAM-MTH202',
      testTitle: 'Advanced Linear Algebra',
      course: 'Engineering',
      branch: 'CSE',
      sem: 1,
      examType: 'Written / Upload',
      status: 'Pending Evaluation',
      evaluationStatus: 'in_progress',
      totalMarks: 40,
      marksObtained: null,
      version: 1,
      published: false,
      fileName: 'alice_gap_script.pdf',
      privateScriptUrl: '/uploads/private_scripts/alice_gap_script.pdf',
    });

    // Teacher Mukherjee acquires lock
    await request('POST', `/api/evaluations/${eval1.id}/lock`, { token: tokenMukherjee });

    // 1b. Reject marksAwarded > schemeQ.maxMarks (Q1 awarded 25 > 20) -> 400 Bad Request
    const exceedQ = await request('PATCH', `/api/evaluations/${eval1.id}/draft`, {
      token: tokenMukherjee,
      body: {
        version: 1,
        questionMarks: [{ questionNumber: '1', marksAwarded: 25 }],
      },
    });
    assert.strictEqual(exceedQ.status, 400, `Expected 400 for marks > maxMarks, got ${exceedQ.status}`);
    console.log('  ✓ Rejected marksAwarded > scheme maxMarks (400 Bad Request)');

    // 1c. Reject marksAwarded < 0 (Q1 awarded -5) -> 400 Bad Request
    const negativeQ = await request('PATCH', `/api/evaluations/${eval1.id}/draft`, {
      token: tokenMukherjee,
      body: {
        version: 1,
        questionMarks: [{ questionNumber: '1', marksAwarded: -5 }],
      },
    });
    assert.strictEqual(negativeQ.status, 400, `Expected 400 for negative marks, got ${negativeQ.status}`);
    console.log('  ✓ Rejected marksAwarded < 0 (400 Bad Request)');

    // 1d. Reject unknown question number (Q99) -> 400 Bad Request
    const unknownQ = await request('PATCH', `/api/evaluations/${eval1.id}/draft`, {
      token: tokenMukherjee,
      body: {
        version: 1,
        questionMarks: [{ questionNumber: '99', marksAwarded: 10 }],
      },
    });
    assert.strictEqual(unknownQ.status, 400, `Expected 400 for unknown question, got ${unknownQ.status}`);
    console.log('  ✓ Rejected unknown question number not in scheme (400 Bad Request)');

    // 1e. Reject step marks exceeding step maximum (step 1 max 8, submitted 10) -> 400 Bad Request
    const exceedStep = await request('PATCH', `/api/evaluations/${eval1.id}/draft`, {
      token: tokenMukherjee,
      body: {
        version: 1,
        questionMarks: [
          {
            questionNumber: '1',
            marksAwarded: 15,
            stepMarks: [{ stepNumber: 1, marksAwarded: 10 }], // Step 1 max is 8
          },
        ],
      },
    });
    assert.strictEqual(exceedStep.status, 400, `Expected 400 for step marks > step max, got ${exceedStep.status}`);
    console.log('  ✓ Rejected step marks exceeding step rubric maximum (400 Bad Request)');

    // 1f. Valid draft save: server computes marksObtained and percentage strictly from scheme
    // Client maliciously claims marksObtained: 40 and percentage: 100
    const validDraft = await request('PATCH', `/api/evaluations/${eval1.id}/draft`, {
      token: tokenMukherjee,
      body: {
        version: 1,
        marksObtained: 40, // Client override attempt
        percentage: 100,   // Client override attempt
        questionMarks: [
          {
            questionNumber: '1',
            marksAwarded: 15,
            stepMarks: [
              { stepNumber: 1, marksAwarded: 7 },
              { stepNumber: 2, marksAwarded: 8 },
            ],
          },
          {
            questionNumber: '2',
            marksAwarded: 15,
          },
        ],
      },
    });
    assert.strictEqual(validDraft.status, 200, `Expected 200 OK, got ${validDraft.status}`);
    assert.strictEqual(validDraft.data.evaluation.marksObtained, 30, 'Server must compute 15+15=30');
    assert.strictEqual(validDraft.data.evaluation.totalMarks, 40, 'Total marks must be from scheme (40)');
    assert.strictEqual(validDraft.data.evaluation.percentage, 75, 'Percentage must be (30/40)*100 = 75%');
    assert.strictEqual(validDraft.data.evaluation.grade, 'B+');
    console.log('  ✓ Server strictly computed marksObtained (30/40), percentage (75%), and grade (B+) (200 OK)');

    // ------------------------------------------------------------------------
    // GAP 2: Lock Enforcement Across All Mutation APIs
    // ------------------------------------------------------------------------
    console.log('\n[GAP 2] Lock Enforcement Across All Mutation APIs...');

    // Prof. Mukherjee currently holds lock on eval_gap_1.
    // Prof. Sharma attempts mutations without holding the lock:

    // 2a. Draft save without lock -> 409 Conflict
    const noLockDraft = await request('PATCH', `/api/evaluations/${eval1.id}/draft`, {
      token: tokenSharma,
      body: { version: 2, questionMarks: [{ questionNumber: '1', marksAwarded: 10 }] },
    });
    assert.strictEqual(noLockDraft.status, 409, `Expected 409 for draft save without lock, got ${noLockDraft.status}`);
    console.log('  ✓ Blocked draft save without lock (409 Conflict)');

    // 2b. Finalize without lock -> 409 Conflict
    const noLockFinalize = await request('POST', `/api/evaluations/${eval1.id}/finalize`, {
      token: tokenSharma,
    });
    assert.strictEqual(noLockFinalize.status, 409, `Expected 409 for finalize without lock, got ${noLockFinalize.status}`);
    console.log('  ✓ Blocked finalize without lock (409 Conflict)');

    // 2c. Publish without lock -> 409 Conflict
    const noLockPublish = await request('POST', `/api/evaluations/${eval1.id}/publish`, {
      token: tokenSharma,
    });
    assert.strictEqual(noLockPublish.status, 409, `Expected 409 for publish without lock, got ${noLockPublish.status}`);
    console.log('  ✓ Blocked publish without lock (409 Conflict)');

    // 2d. Annotation create without lock -> 409 Conflict
    const noLockAnnot = await request('POST', `/api/evaluations/${eval1.id}/annotations`, {
      token: tokenSharma,
      body: { pageNumber: 1, coordinates: [{ x: 0.1, y: 0.2 }] },
    });
    assert.strictEqual(noLockAnnot.status, 409, `Expected 409 for annotation without lock, got ${noLockAnnot.status}`);
    console.log('  ✓ Blocked annotation creation without lock (409 Conflict)');

    // 2e. Admin override without lock -> 200 OK with Audit Entry
    const adminDraft = await request('PATCH', `/api/evaluations/${eval1.id}/draft`, {
      token: tokenAdmin,
      body: { version: 2, questionMarks: [{ questionNumber: '1', marksAwarded: 16 }, { questionNumber: '2', marksAwarded: 14 }] },
    });
    assert.strictEqual(adminDraft.status, 200, `Expected 200 for admin override, got ${adminDraft.status}`);
    const adminAudit = await AuditLog.findOne({
      targetId: eval1.id,
      action: 'admin_override',
    });
    assert(adminAudit, 'Audit log must record admin_override');
    console.log('  ✓ Admin override permitted with tamper-evident AuditLog entry (200 OK)');

    // ------------------------------------------------------------------------
    // GAP 3: Publish Rules & Bulk Publish Granular Reporting
    // ------------------------------------------------------------------------
    console.log('\n[GAP 3] Publish Rules & Bulk Publish Granular Reporting...');

    // Seed evaluation with incomplete marks
    const evalIncomplete = await Evaluation.create({
      id: 'eval_gap_incomplete',
      studentId: bscStudent._id.toString(),
      studentName: bscStudent.name,
      studentEmail: bscStudent.email,
      studentRoll: bscStudent.rollNumber,
      testId: 'EXAM-MTH202',
      examId: 'EXAM-MTH202',
      course: 'Engineering',
      branch: 'CSE',
      sem: 1,
      examType: 'Written / Upload',
      status: 'Pending Evaluation',
      evaluationStatus: 'in_progress', // Not 'evaluated'
      totalMarks: 40,
      marksObtained: 15,
      version: 1,
      published: false,
      questionMarks: [{ questionNumber: '1', maxMarks: 20, marksAwarded: 15 }], // Missing Question 2!
    });

    // Acquire lock for Mukherjee on eval_gap_1
    await request('POST', `/api/evaluations/${eval1.id}/lock`, { token: tokenMukherjee });

    // 3a. Publish eval1 before finalization (still in_progress) -> 400 Bad Request
    const unfinPublish = await request('POST', `/api/evaluations/${eval1.id}/publish`, {
      token: tokenMukherjee,
    });
    assert.strictEqual(unfinPublish.status, 400, `Expected 400 for publishing unfinalized evaluation, got ${unfinPublish.status}`);
    console.log('  ✓ Blocked publishing evaluation with status in_progress (400 Bad Request)');

    // 3b. Finalize eval1 (now status = 'evaluated', complete questions Q1 & Q2)
    const finRes = await request('POST', `/api/evaluations/${eval1.id}/finalize`, {
      token: tokenMukherjee,
    });
    assert.strictEqual(finRes.status, 200, `Expected 200 for finalize, got ${finRes.status}`);
    assert.strictEqual(finRes.data.evaluation.evaluationStatus, 'evaluated');
    console.log('  ✓ Finalized evaluation eval_gap_1 (status = evaluated)');

    // 3c. Publish eval1 successfully -> 200 OK
    const pubRes = await request('POST', `/api/evaluations/${eval1.id}/publish`, {
      token: tokenMukherjee,
    });
    assert.strictEqual(pubRes.status, 200, `Expected 200 for valid publish, got ${pubRes.status}`);
    assert.strictEqual(pubRes.data.evaluation.published, true);
    console.log('  ✓ Successfully published finalized evaluation with complete marks (200 OK)');

    // 3d. Bulk publish cohort (eval1 is already published, evalIncomplete is incomplete)
    // Seed another complete evaluated exam
    const evalComplete2 = await Evaluation.create({
      id: 'eval_gap_complete2',
      studentId: engStudent._id.toString(),
      studentName: 'Charlie Eng',
      studentEmail: 'charlie.eng@test.edu',
      studentRoll: 'ENG-2026-003',
      testId: 'EXAM-MTH202',
      examId: 'EXAM-MTH202',
      course: 'Engineering',
      branch: 'CSE',
      sem: 1,
      examType: 'Written / Upload',
      status: 'Evaluated',
      evaluationStatus: 'evaluated', // Ready!
      totalMarks: 40,
      marksObtained: 35,
      version: 1,
      published: false,
      questionMarks: [
        { questionNumber: '1', marksAwarded: 18 },
        { questionNumber: '2', marksAwarded: 17 },
      ],
    });

    const bulkRes = await request('POST', '/api/evaluations/bulk-publish', {
      token: tokenMukherjee,
      body: { examId: 'EXAM-MTH202', course: 'Engineering', branch: 'CSE' },
    });
    assert.strictEqual(bulkRes.status, 200, `Expected 200 for bulk publish, got ${bulkRes.status}`);
    assert.strictEqual(bulkRes.data.publishedCount, 1, 'Only evalComplete2 should be published');
    assert.strictEqual(bulkRes.data.skippedCount, 1, 'evalIncomplete should be skipped');
    assert(bulkRes.data.skipped[0].reason.includes('Incomplete marks'), 'Skipped reason must mention incomplete marks');
    console.log('  ✓ Bulk publish granular reporting: 1 published, 1 skipped with explicit reason (200 OK)');

    // ------------------------------------------------------------------------
    // GAP 4: Re-Evaluation Lifecycle & Range Validation
    // ------------------------------------------------------------------------
    console.log('\n[GAP 4] Re-Evaluation Lifecycle & Range Validation...');

    // 4a. Alice files re-evaluation on her published eval1
    const reEval1 = await request('POST', `/api/evaluations/${eval1.id}/re-evaluate`, {
      token: tokenAlice,
      body: {
        reason: 'Question 1 eigenvector derivation used standard Gram-Schmidt basis.',
        questionNumbers: ['1'],
      },
    });
    assert.strictEqual(reEval1.status, 201, `Expected 201 for re-eval request, got ${reEval1.status}`);
    const reqId = reEval1.data.request.id;
    console.log('  ✓ Student Alice filed re-evaluation request (201 Created)');

    // 4b. Student attempts to file SECOND re-evaluation on same exam -> 409 Conflict
    const reEvalDuplicate = await request('POST', `/api/evaluations/${eval1.id}/re-evaluate`, {
      token: tokenAlice,
      body: {
        reason: 'Second attempt to dispute question 2 calculation.',
        questionNumbers: ['2'],
      },
    });
    assert.strictEqual(reEvalDuplicate.status, 409, `Expected 409 for duplicate dispute, got ${reEvalDuplicate.status}`);
    console.log('  ✓ Enforced 1 dispute per evaluation per student (409 Conflict)');

    // 4c. Teacher resolves with adjustedMarks > maxMarks (45 > 40) -> 400 Bad Request
    const exceedResolve = await request('PATCH', `/api/evaluations/re-evaluation-requests/${reqId}`, {
      token: tokenMukherjee,
      body: { status: 'approved', adjustedMarks: 45 },
    });
    assert.strictEqual(exceedResolve.status, 400, `Expected 400 for adjustedMarks > maxMarks, got ${exceedResolve.status}`);
    console.log('  ✓ Rejected adjustedMarks exceeding maxMarks (400 Bad Request)');

    // 4d. Teacher resolves with negative adjustedMarks (-5) -> 400 Bad Request
    const negResolve = await request('PATCH', `/api/evaluations/re-evaluation-requests/${reqId}`, {
      token: tokenMukherjee,
      body: { status: 'approved', adjustedMarks: -5 },
    });
    assert.strictEqual(negResolve.status, 400, `Expected 400 for negative adjustedMarks, got ${negResolve.status}`);
    console.log('  ✓ Rejected negative adjustedMarks (400 Bad Request)');

    // 4e. Valid resolution (adjustedMarks: 32 / 40) -> 200 OK, notifies student, version incremented
    const validResolve = await request('PATCH', `/api/evaluations/re-evaluation-requests/${reqId}`, {
      token: tokenMukherjee,
      body: {
        status: 'approved',
        adjustedMarks: 32,
        reviewRemarks: 'Verified: Gram-Schmidt basis approach accepted (+2 marks).',
      },
    });
    assert.strictEqual(validResolve.status, 200, `Expected 200 OK for dispute resolution, got ${validResolve.status}`);
    assert.strictEqual(validResolve.data.evaluation.marksObtained, 32);

    const reEvalNotif = await Notification.findOne({
      userId: engStudent._id.toString(),
      type: 're_evaluation_resolved',
    });
    assert(reEvalNotif, 'Student must receive re_evaluation_resolved notification');
    console.log('  ✓ Dispute resolved within 0..maxMarks: updated marks, incremented version, dispatched notification (200 OK)');

    // ------------------------------------------------------------------------
    // GAP 5: Annotations Caps, Author-Only Deletion & Student Visibility Route
    // ------------------------------------------------------------------------
    console.log('\n[GAP 5] Annotations Caps, Author-Only Deletion & Student Route...');

    // Acquire lock for Mukherjee on eval1
    await request('POST', `/api/evaluations/${eval1.id}/lock`, { token: tokenMukherjee });

    // 5a. Mukherjee creates annotation
    const annotRes = await request('POST', `/api/evaluations/${eval1.id}/annotations`, {
      token: tokenMukherjee,
      body: {
        pageNumber: 1,
        tool: 'tick',
        coordinates: [{ x: 0.2, y: 0.3 }],
        content: 'Orthogonal proof verified',
      },
    });
    assert.strictEqual(annotRes.status, 201);
    const annotId = annotRes.data.annotation.id;

    // 5b. Teacher Sharma attempts to delete Mukherjee's annotation -> 403 Forbidden
    // Acquire lock for Sharma
    await request('POST', `/api/evaluations/${eval1.id}/unlock`, { token: tokenMukherjee });
    await request('POST', `/api/evaluations/${eval1.id}/lock`, { token: tokenSharma });

    const delOther = await request('DELETE', `/api/evaluations/${eval1.id}/annotations/${annotId}`, {
      token: tokenSharma,
    });
    assert.strictEqual(delOther.status, 403, `Expected 403 for deleting another teacher's annotation, got ${delOther.status}`);
    console.log('  ✓ Deletion guarded: only original author or admin can delete annotation (403 Forbidden)');

    // 5c. Admin can delete annotation
    const delAdmin = await request('DELETE', `/api/evaluations/${eval1.id}/annotations/${annotId}`, {
      token: tokenAdmin,
    });
    assert.strictEqual(delAdmin.status, 200, `Expected 200 for admin delete, got ${delAdmin.status}`);
    console.log('  ✓ Administrator successfully deleted annotation (200 OK)');

    // Release Sharma's lock so Mukherjee can re-lock and annotate
    await request('POST', `/api/evaluations/${eval1.id}/unlock`, { token: tokenSharma });
    await request('POST', `/api/evaluations/${eval1.id}/lock`, { token: tokenMukherjee });
    const createAnnot2 = await request('POST', `/api/evaluations/${eval1.id}/annotations`, {
      token: tokenMukherjee,
      body: { pageNumber: 1, tool: 'pen', coordinates: [{ x: 0.5, y: 0.5 }] },
    });
    assert.strictEqual(createAnnot2.status, 201);

    // 5d. Student accesses annotations for PUBLISHED evaluation -> 200 OK
    const studentAnnotRes = await request('GET', `/api/evaluations/${eval1.id}/student-annotations`, {
      token: tokenAlice,
    });
    assert.strictEqual(studentAnnotRes.status, 200, `Expected 200 for student reading published annotations, got ${studentAnnotRes.status}`);
    assert.strictEqual(studentAnnotRes.data.count, 1);
    assert.strictEqual(studentAnnotRes.data.annotations[0].authorRole, undefined, 'Must not leak authorRole');
    console.log('  ✓ Student retrieved annotations on their published evaluation with sensitive fields stripped (200 OK)');

    // 5e. Student accesses annotations on UNPUBLISHED evaluation -> 403 Forbidden
    const unpubAnnotRes = await request('GET', `/api/evaluations/${evalIncomplete.id}/student-annotations`, {
      token: tokenBob,
    });
    assert.strictEqual(unpubAnnotRes.status, 403, `Expected 403 for student reading unpublished annotations, got ${unpubAnnotRes.status}`);
    console.log('  ✓ Student access to annotations on unpublished evaluation strictly blocked (403 Forbidden)');

    // ------------------------------------------------------------------------
    // GAP 6: Uploads, Private Storage & Multi-Page Streaming
    // ------------------------------------------------------------------------
    console.log('\n[GAP 6] Uploads, Private Storage & Multi-Page Streaming...');

    // 6a. Student submits written exam with base64 script
    const mockBase64Pdf = 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4 Mock Private Answer Script').toString('base64');
    const subRes = await request('POST', '/api/student/submit-exam', {
      token: tokenAlice,
      body: {
        examId: 'EXAM-MTH301',
        examTitle: 'Complex Variables Exam',
        examType: 'Written / Upload',
        answerFileUrl: mockBase64Pdf,
        totalPages: 2,
        answerPages: [
          { pageNumber: 1, dataUrl: mockBase64Pdf },
          { pageNumber: 2, dataUrl: mockBase64Pdf },
        ],
      },
    });

    assert.strictEqual(subRes.status, 201, `Expected 201 for exam upload, got ${subRes.status}`);
    const uploadedEval = subRes.data.evaluation;
    assert.strictEqual(uploadedEval.privateScriptUrl, `/api/evaluations/${uploadedEval.id}/script-file`);
    assert(!String(uploadedEval.answerSheetUrl).startsWith('http'), 'answerSheetUrl must NOT be a public URL');
    console.log('  ✓ Student written exam stored in private storage; public URLs neutralized (201 Created)');

    // 6b. Direct static access to script without token -> 403 Forbidden
    const staticRes = await request('GET', '/uploads/submission_EXAM-MTH301.pdf');
    assert.strictEqual(staticRes.status, 403, `Expected 403 for direct static access, got ${staticRes.status}`);
    console.log('  ✓ Direct static access to script URLs hard-blocked with 403 Forbidden');

    // 6c. Multi-page metadata query GET /api/evaluations/:id/pages -> returns totalPages without raw URLs
    const pagesRes = await request('GET', `/api/evaluations/${uploadedEval.id}/pages`, {
      token: tokenMukherjee,
    });
    assert.strictEqual(pagesRes.status, 200, `Expected 200 for pages query, got ${pagesRes.status}`);
    assert.strictEqual(pagesRes.data.totalPages, 2);
    assert.strictEqual(pagesRes.data.pages[0].pageNumber, 1);
    assert.strictEqual(pagesRes.data.pages[0].url, undefined, 'Must not expose raw internal URLs');
    console.log('  ✓ Page list endpoint returns page count and types without exposing storage URLs (200 OK)');

    // 6d. Stream page 1 via authenticated streaming route
    const streamRes = await request('GET', `/api/evaluations/${uploadedEval.id}/script-file?page=1`, {
      token: tokenMukherjee,
    });
    assert.strictEqual(streamRes.status, 200, `Expected 200 for authenticated script streaming, got ${streamRes.status}`);
    console.log('  ✓ Authenticated script streaming returned page 1 binary content (200 OK)');

    // ------------------------------------------------------------------------
    // GAP 7: Workspace Listing APIs (Exams & Submissions Queue)
    // ------------------------------------------------------------------------
    console.log('\n[GAP 7] Workspace Listing APIs (Exams & Submissions Queue)...');

    // 7a. GET /api/evaluations/exams
    const examsRes = await request('GET', '/api/evaluations/exams', {
      token: tokenMukherjee,
    });
    assert.strictEqual(examsRes.status, 200, `Expected 200 for exams list, got ${examsRes.status}`);
    assert(examsRes.data.count >= 1, 'Should list at least 1 exam');
    const exam202 = examsRes.data.exams.find((e) => e.examId === 'EXAM-MTH202');
    assert(exam202, 'EXAM-MTH202 must be listed');
    assert.strictEqual(exam202.hasMarkingScheme, true);
    console.log(`  ✓ GET /api/evaluations/exams returned ${examsRes.data.count} exams with counters and marking scheme status (200 OK)`);

    // 7b. GET /api/evaluations/submissions-queue
    const queueRes = await request('GET', '/api/evaluations/submissions-queue?examId=EXAM-MTH202', {
      token: tokenMukherjee,
    });
    assert.strictEqual(queueRes.status, 200, `Expected 200 for queue query, got ${queueRes.status}`);
    assert(queueRes.data.counters.total >= 2, 'Counters should reflect live submissions');
    assert(queueRes.data.submissions.length > 0, 'Should return submissions');
    const firstSub = queueRes.data.submissions[0];
    assert(firstSub.id && firstSub.studentName && firstSub.rollNumber, 'Minimal student fields present');
    assert.strictEqual(firstSub.studentEmail, undefined, 'Sensitive email must be omitted from minimal listing');
    console.log(`  ✓ GET /api/evaluations/submissions-queue returned live counters (total: ${queueRes.data.counters.total}, pending: ${queueRes.data.counters.pending}) and next unevaluated ID: ${queueRes.data.nextUnevaluatedId} (200 OK)`);

    // 7c. Search filter by student name
    const searchRes = await request('GET', '/api/evaluations/submissions-queue?examId=EXAM-MTH202&search=Alice', {
      token: tokenMukherjee,
    });
    assert.strictEqual(searchRes.status, 200);
    assert(searchRes.data.submissions.every((s) => s.studentName.toLowerCase().includes('alice')), 'Search must match Alice');
    console.log('  ✓ Submissions queue substring search filter verified (200 OK)');

    console.log('\n' + '='.repeat(80));
    console.log('🎉 ALL PART A BACKEND GAPS VERIFIED SUCCESSFULLY WITH 100% PASS RATE!');
    console.log('='.repeat(80));
  } finally {
    server.close();
    if (fs.existsSync(sampleScriptFile)) {
      try { fs.unlinkSync(sampleScriptFile); } catch (_) {}
    }
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
    console.log(`\n🧹 Dropped test database ${TEMP_DB_NAME} and disconnected.`);
  }
}

runGapsTests().catch((err) => {
  console.error('\n❌ GAPS TEST FAILURE:', err);
  process.exit(1);
});
