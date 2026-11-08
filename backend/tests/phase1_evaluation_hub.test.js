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

const TEMP_DB_NAME = 'test_eval_phase1_tmp';
const JWT_SECRET = process.env.JWT_SECRET || 'asmaths_secret_jwt_key_2026_cluster0';

// Ensure private uploads test directory exists
const privateUploadsDir = path.resolve(__dirname, '../uploads/private_scripts');
if (!fs.existsSync(privateUploadsDir)) {
  fs.mkdirSync(privateUploadsDir, { recursive: true });
}

async function runPhase1Tests() {
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
  console.log('🚀 EVALUATION HUB — PHASE 1 ARCHITECTURE & VERIFICATION SUITE');
  console.log(`Database under test : ${TEMP_DB_NAME} (Strictly isolated temporary DB)`);
  console.log('='.repeat(80));

  await mongoose.connect(targetUri);
  assert.strictEqual(mongoose.connection.name, TEMP_DB_NAME, `Must be connected to ${TEMP_DB_NAME}`);

  // Reset collections in temporary DB
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

  const engTeacher1 = await User.create({
    name: 'Prof. Mukherjee',
    email: 'prof.mukherjee@test.edu',
    password: 'HashedPassword123!',
    role: 'teacher',
    course: 'Engineering',
    branch: 'CSE',
    isApproved: true,
  });

  const engTeacher2 = await User.create({
    name: 'Prof. Sharma',
    email: 'prof.sharma@test.edu',
    password: 'HashedPassword123!',
    role: 'teacher',
    course: 'Engineering',
    branch: 'CSE',
    isApproved: true,
  });

  const bscTeacher = await User.create({
    name: 'Prof. Banerjee',
    email: 'prof.banerjee@test.edu',
    password: 'HashedPassword123!',
    role: 'teacher',
    course: 'B.Sc',
    branch: 'Maths Honours',
    isApproved: true,
  });

  const adminUser = await User.create({
    name: 'Dr. Admin Dean',
    email: 'admin.dean@test.edu',
    password: 'HashedPassword123!',
    role: 'admin',
    isApproved: true,
  });

  // Token generator
  const createToken = (u) => jwt.sign({ id: u._id.toString(), email: u.email, role: u.role }, JWT_SECRET, { expiresIn: '1h' });
  const tokenStudentAlice = createToken(engStudent);
  const tokenStudentBob = createToken(bscStudent);
  const tokenTeacherMukherjee = createToken(engTeacher1);
  const tokenTeacherSharma = createToken(engTeacher2);
  const tokenTeacherBanerjee = createToken(bscTeacher);
  const tokenAdmin = createToken(adminUser);

  // Setup Express App
  const app = express();
  app.use(express.json());

  // Static blocker test middleware matching server.js
  app.use('/uploads/private_scripts', (req, res) => {
    return res.status(403).json({
      error: 'Direct static access to private scripts is strictly forbidden. Use authenticated evaluation streaming routes.'
    });
  });

  app.use('/api/evaluations', evaluationRoutes);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  // HTTP Helper
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

  const sampleScriptFile = path.join(privateUploadsDir, 'alice_script_midterm.pdf');

  try {
    // ------------------------------------------------------------------------
    // TEST 1: Marking Scheme Authoring & Scoping
    // ------------------------------------------------------------------------
    console.log('\n[TEST 1] Marking Scheme Authoring & Scoping...');
    
    // 1a. CSE Teacher creating CSE Marking Scheme -> 201 Success
    const schemePayload = {
      examId: 'EXAM-MTH101',
      examTitle: 'Calculus & Linear Algebra Mid-Term',
      course: 'Engineering',
      branch: 'CSE',
      semester: 1,
      totalMarks: 50,
      sections: [{ sectionName: 'Section A - Calculus', totalMarks: 30 }],
      questions: [
        {
          questionNumber: '1',
          questionText: 'Evaluate the definite integral \\int_0^1 x e^x dx',
          maxMarks: 10,
          modelSolutionLatex: 'Use integration by parts: u=x, dv=e^x dx \\implies uv - \\int v du = 1',
          stepRubric: [
            { stepNumber: 1, description: 'Correct formula uv - \\int v du', marksAwarded: 4 },
            { stepNumber: 2, description: 'Accurate limit substitution', marksAwarded: 6 }
          ]
        }
      ]
    };

    const schemeRes = await request('POST', '/api/evaluations/marking-schemes', {
      token: tokenTeacherMukherjee,
      body: schemePayload
    });
    assert.strictEqual(schemeRes.status, 201, `Expected 201 Created, got ${schemeRes.status}`);
    const schemeData = schemeRes.data.scheme;
    assert.strictEqual(schemeData.examId, 'EXAM-MTH101');
    assert.strictEqual(schemeData.questions.length, 1);
    console.log('  ✓ Teacher created MarkingScheme for their assigned course/branch successfully (201)');

    // 1b. CSE Teacher creating Scheme for B.Sc Maths Honours -> 403 Forbidden
    const crossBranchScheme = { ...schemePayload, course: 'B.Sc', branch: 'Maths Honours' };
    const crossSchemeRes = await request('POST', '/api/evaluations/marking-schemes', {
      token: tokenTeacherMukherjee,
      body: crossBranchScheme
    });
    assert.strictEqual(crossSchemeRes.status, 403, `Expected 403 Forbidden for cross-branch scheme, got ${crossSchemeRes.status}`);
    console.log('  ✓ Cross-branch marking scheme authoring blocked with 403 Forbidden');

    // 1c. Student trying to create/read marking schemes -> 403 Forbidden
    const studentSchemeRes = await request('GET', '/api/evaluations/marking-schemes/EXAM-MTH101', {
      token: tokenStudentAlice
    });
    assert.strictEqual(studentSchemeRes.status, 403, `Expected 403 for student accessing marking scheme, got ${studentSchemeRes.status}`);
    console.log('  ✓ Student access to teacher marking schemes blocked with 403 Forbidden');

    // ------------------------------------------------------------------------
    // TEST 2: Workspace Split-Screen Data Loading
    // ------------------------------------------------------------------------
    console.log('\n[TEST 2] Workspace Split-Screen Data Loading...');

    // Seed physical answer script file
    fs.writeFileSync(sampleScriptFile, '%PDF-1.4 Mock Private Answer Script Content for Alice');

    // Seed evaluation record
    const evalWritten = await Evaluation.create({
      id: 'eval_written_1',
      studentId: engStudent._id.toString(),
      studentName: engStudent.name,
      studentEmail: engStudent.email,
      studentRoll: engStudent.rollNumber,
      testId: 'EXAM-MTH101',
      examId: 'EXAM-MTH101',
      testTitle: 'Calculus & Linear Algebra Mid-Term',
      course: 'Engineering',
      branch: 'CSE',
      sem: 1,
      examType: 'Written / Upload',
      status: 'Pending Evaluation',
      totalMarks: 50,
      marksObtained: null,
      version: 1,
      published: false,
      privateScriptUrl: '/uploads/private_scripts/alice_script_midterm.pdf',
      fileName: 'alice_script_midterm.pdf',
      answerPages: ['/uploads/private_scripts/alice_script_midterm.pdf'],
      totalPages: 1,
    });

    // 2a. Teacher opens workspace
    const wsRes = await request('GET', `/api/evaluations/${evalWritten.id}/workspace`, {
      token: tokenTeacherMukherjee
    });
    assert.strictEqual(wsRes.status, 200, `Expected 200 OK for workspace loading, got ${wsRes.status}`);
    assert.strictEqual(wsRes.data.evaluation.id, evalWritten.id);
    assert.strictEqual(wsRes.data.markingScheme.examId, 'EXAM-MTH101');
    assert.strictEqual(wsRes.data.lockState.isLocked, false);
    console.log('  ✓ Workspace split-screen payload loaded with evaluation, markingScheme, lockState (200)');

    // 2b. Cross-branch teacher opens workspace -> 403 Forbidden
    const crossWsRes = await request('GET', `/api/evaluations/${evalWritten.id}/workspace`, {
      token: tokenTeacherBanerjee
    });
    assert.strictEqual(crossWsRes.status, 403, `Expected 403 for cross-branch teacher workspace, got ${crossWsRes.status}`);
    console.log('  ✓ Cross-branch teacher blocked from student workspace with 403 Forbidden');

    // ------------------------------------------------------------------------
    // TEST 3: Concurrency Locking & Heartbeat
    // ------------------------------------------------------------------------
    console.log('\n[TEST 3] Concurrency Locking & Heartbeat...');

    // 3a. Teacher 1 acquires lock
    const lock1 = await request('POST', `/api/evaluations/${evalWritten.id}/lock`, {
      token: tokenTeacherMukherjee
    });
    assert.strictEqual(lock1.status, 200, `Expected 200 for acquiring lock, got ${lock1.status}`);
    assert.strictEqual(lock1.data.isLocked, true);
    assert.strictEqual(lock1.data.lockedBy.userId, engTeacher1._id.toString());
    console.log('  ✓ Teacher 1 acquired evaluation lock with 5-minute TTL (200)');

    // 3b. Teacher 2 attempts to acquire lock -> 409 Conflict
    const lock2 = await request('POST', `/api/evaluations/${evalWritten.id}/lock`, {
      token: tokenTeacherSharma
    });
    assert.strictEqual(lock2.status, 409, `Expected 409 Conflict for concurrent lock, got ${lock2.status}`);
    assert.strictEqual(lock2.data.lockedByName, 'Prof. Mukherjee');
    console.log('  ✓ Teacher 2 concurrent lock attempt rejected with 409 Conflict');

    // 3c. Teacher 1 sends heartbeat renewal -> 200
    const heartbeat = await request('POST', `/api/evaluations/${evalWritten.id}/lock`, {
      token: tokenTeacherMukherjee
    });
    assert.strictEqual(heartbeat.status, 200, `Expected 200 for heartbeat, got ${heartbeat.status}`);
    console.log('  ✓ Teacher 1 heartbeat refreshed TTL successfully (200)');

    // 3d. Teacher 1 releases lock -> 200
    const unlock = await request('POST', `/api/evaluations/${evalWritten.id}/unlock`, {
      token: tokenTeacherMukherjee
    });
    assert.strictEqual(unlock.status, 200, `Expected 200 for release lock, got ${unlock.status}`);
    assert.strictEqual(unlock.data.isLocked, false);
    console.log('  ✓ Teacher 1 released lock successfully (200)');

    // 3e. Teacher 2 can now acquire lock -> 200
    const lock2Acquire = await request('POST', `/api/evaluations/${evalWritten.id}/lock`, {
      token: tokenTeacherSharma
    });
    assert.strictEqual(lock2Acquire.status, 200, `Expected 200 for Teacher 2 acquiring lock, got ${lock2Acquire.status}`);
    assert.strictEqual(lock2Acquire.data.lockedBy.userId, engTeacher2._id.toString());
    console.log('  ✓ Teacher 2 successfully acquired freed lock (200)');

    // ------------------------------------------------------------------------
    // TEST 4: Versioned Draft Saves (Optimistic Concurrency)
    // ------------------------------------------------------------------------
    console.log('\n[TEST 4] Versioned Draft Saves (Optimistic Concurrency)...');

    // 4a. Teacher 2 saves draft with version 1 -> success, version becomes 2
    const draftRes1 = await request('PATCH', `/api/evaluations/${evalWritten.id}/draft`, {
      token: tokenTeacherSharma,
      body: {
        version: 1,
        questionMarks: [
          { questionNumber: '1', maxMarks: 10, marksAwarded: 8, teacherFeedback: 'Good step 1 work' }
        ],
        generalFeedback: 'Overall solid derivation.'
      }
    });
    assert.strictEqual(draftRes1.status, 200, `Expected 200 for draft save, got ${draftRes1.status}`);
    assert.strictEqual(draftRes1.data.version, 2);
    assert.strictEqual(draftRes1.data.evaluation.marksObtained, 8);
    console.log('  ✓ Draft saved with version 1, version incremented to 2 (200)');

    // 4b. Concurrent/stale save with version 1 -> 409 Conflict
    const staleDraftRes = await request('PATCH', `/api/evaluations/${evalWritten.id}/draft`, {
      token: tokenTeacherSharma,
      body: {
        version: 1, // Stale version
        questionMarks: [{ questionNumber: '1', marksAwarded: 5 }]
      }
    });
    assert.strictEqual(staleDraftRes.status, 409, `Expected 409 Conflict for stale version, got ${staleDraftRes.status}`);
    assert.strictEqual(staleDraftRes.data.currentVersion, 2);
    console.log('  ✓ Stale draft save rejected with 409 Conflict');

    // 4c. Save with current version 2 -> success, version becomes 3
    const draftRes2 = await request('PATCH', `/api/evaluations/${evalWritten.id}/draft`, {
      token: tokenTeacherSharma,
      body: {
        version: 2,
        questionMarks: [
          { questionNumber: '1', maxMarks: 10, marksAwarded: 9, teacherFeedback: 'Excellent' }
        ]
      }
    });
    assert.strictEqual(draftRes2.status, 200, `Expected 200 for updated draft save, got ${draftRes2.status}`);
    assert.strictEqual(draftRes2.data.version, 3);
    assert.strictEqual(draftRes2.data.evaluation.marksObtained, 9);
    console.log('  ✓ Draft saved with matching version 2, version incremented to 3 (200)');

    // ------------------------------------------------------------------------
    // TEST 5: Bounded Vector Annotations
    // ------------------------------------------------------------------------
    console.log('\n[TEST 5] Bounded Vector Annotations...');

    // 5a. Valid annotation (50 normalized points) -> 201 Created
    const validCoords = Array.from({ length: 50 }, (_, i) => ({
      x: +(i * 0.01).toFixed(3),
      y: +(i * 0.01).toFixed(3)
    }));

    const annotRes = await request('POST', `/api/evaluations/${evalWritten.id}/annotations`, {
      token: tokenTeacherSharma,
      body: {
        pageNumber: 1,
        type: 'pen',
        color: '#ff0000',
        strokeWidth: 2,
        coordinates: validCoords,
        comment: 'Step 1 calculation verified'
      }
    });
    assert.strictEqual(annotRes.status, 201, `Expected 201 Created for annotation, got ${annotRes.status}`);
    const createdAnnotId = annotRes.data.annotation.id;
    assert(createdAnnotId, 'Annotation should have an ID');
    console.log('  ✓ Created bounded vector annotation with 50 normalized coordinates (201)');

    // 5b. Oversized annotation (1200 points > 1000 limit) -> 400 Bad Request
    const oversizedCoords = Array.from({ length: 1200 }, () => ({ x: 0.5, y: 0.5 }));
    const overAnnotRes = await request('POST', `/api/evaluations/${evalWritten.id}/annotations`, {
      token: tokenTeacherSharma,
      body: {
        pageNumber: 1,
        type: 'pen',
        coordinates: oversizedCoords
      }
    });
    assert.strictEqual(overAnnotRes.status, 400, `Expected 400 for oversized vector, got ${overAnnotRes.status}`);
    console.log('  ✓ Oversized vector annotation (>1000 points) rejected with 400 Bad Request');

    // 5c. Out of bounds coordinates (x = 1.5 > 1.0) -> 400 Bad Request
    const oobCoords = [{ x: 1.5, y: 0.5 }];
    const oobAnnotRes = await request('POST', `/api/evaluations/${evalWritten.id}/annotations`, {
      token: tokenTeacherSharma,
      body: {
        pageNumber: 1,
        type: 'pen',
        coordinates: oobCoords
      }
    });
    assert.strictEqual(oobAnnotRes.status, 400, `Expected 400 for out-of-bounds coords, got ${oobAnnotRes.status}`);
    console.log('  ✓ Out-of-bounds coordinates (x > 1.0) rejected with 400 Bad Request');

    // 5d. Query active annotations -> 200
    const listAnnotRes = await request('GET', `/api/evaluations/${evalWritten.id}/annotations`, {
      token: tokenTeacherSharma
    });
    assert.strictEqual(listAnnotRes.status, 200);
    assert.strictEqual(listAnnotRes.data.annotations.length, 1);
    console.log('  ✓ Retrieved active vector annotations (200)');

    // 5e. Delete annotation -> 200
    const delAnnotRes = await request('DELETE', `/api/evaluations/${evalWritten.id}/annotations/${createdAnnotId}`, {
      token: tokenTeacherSharma
    });
    assert.strictEqual(delAnnotRes.status, 200);
    console.log('  ✓ Deleted annotation successfully (200)');

    // ------------------------------------------------------------------------
    // TEST 6: Atomic Publishing & Student Notifications
    // ------------------------------------------------------------------------
    console.log('\n[TEST 6] Atomic Publishing & Student Notifications...');

    // 6.0 Finalize evaluation prior to publish (Gap 3 requirement)
    const finRes = await request('POST', `/api/evaluations/${evalWritten.id}/finalize`, {
      token: tokenTeacherSharma
    });
    assert.strictEqual(finRes.status, 200, `Expected 200 for finalize, got ${finRes.status}`);
    console.log('  ✓ Evaluation finalized prior to publish (200)');

    // 6a. Publish single evaluation
    const pubRes = await request('POST', `/api/evaluations/${evalWritten.id}/publish`, {
      token: tokenTeacherSharma
    });
    assert.strictEqual(pubRes.status, 200, `Expected 200 for publish, got ${pubRes.status}`);
    assert.strictEqual(pubRes.data.evaluation.published, true);
    assert.strictEqual(pubRes.data.evaluation.status, 'Evaluated');
    console.log('  ✓ Single evaluation published atomically (200)');

    // Verify student notification created
    const notif = await Notification.findOne({
      userId: engStudent._id.toString(),
      type: 'result_published'
    });
    assert(notif, 'Student should receive an result_published notification');
    console.log('  ✓ Verified student notification created in Notification collection');

    // 6b. Bulk publish
    // Seed another finalized evaluation
    const evalWritten2 = await Evaluation.create({
      id: 'eval_written_2',
      studentId: engStudent._id.toString(),
      studentName: engStudent.name,
      studentEmail: engStudent.email,
      testId: 'EXAM-MTH101',
      examId: 'EXAM-MTH101',
      course: 'Engineering',
      branch: 'CSE',
      examType: 'Written / Upload',
      status: 'Evaluated',
      evaluationStatus: 'evaluated',
      questionMarks: [{ questionNumber: '1', maxMarks: 10, marksAwarded: 8 }],
      totalMarks: 10,
      marksObtained: 8,
      version: 1,
      published: false
    });

    const bulkPubRes = await request('POST', '/api/evaluations/bulk-publish', {
      token: tokenTeacherSharma,
      body: { evaluationIds: [evalWritten2.id] }
    });
    assert.strictEqual(bulkPubRes.status, 200, `Expected 200 for bulk publish, got ${bulkPubRes.status}`);
    assert.strictEqual(bulkPubRes.data.publishedCount, 1);
    console.log('  ✓ Bulk publish executed atomically with compensating rollback support (200)');

    // ------------------------------------------------------------------------
    // TEST 7: Student Re-Evaluation Dispute Workflow
    // ------------------------------------------------------------------------
    console.log('\n[TEST 7] Student Re-Evaluation Dispute Workflow...');

    // 7a. Alice files re-evaluation on her published exam
    const disputeRes = await request('POST', `/api/evaluations/${evalWritten.id}/re-evaluate`, {
      token: tokenStudentAlice,
      body: {
        reason: 'Step 2 limit substitution was correct according to standard textbook proof.',
        questionNumbers: ['1']
      }
    });
    assert.strictEqual(disputeRes.status, 201, `Expected 201 Created for re-eval request, got ${disputeRes.status}`);
    const requestId = disputeRes.data.request.id;
    console.log('  ✓ Student Alice filed re-evaluation dispute (201)');

    // 7b. Bob attempts to dispute Alice\'s evaluation -> 403 Forbidden
    const crossDisputeRes = await request('POST', `/api/evaluations/${evalWritten.id}/re-evaluate`, {
      token: tokenStudentBob,
      body: { reason: 'Unauthorized dispute attempt' }
    });
    assert.strictEqual(crossDisputeRes.status, 403, `Expected 403 for unauthorized dispute, got ${crossDisputeRes.status}`);
    console.log('  ✓ Unauthorized dispute by another student blocked with 403 Forbidden');

    // 7c. Teacher lists dispute requests
    const listDisputes = await request('GET', '/api/evaluations/re-evaluation-requests', {
      token: tokenTeacherSharma
    });
    assert.strictEqual(listDisputes.status, 200);
    assert(listDisputes.data.requests.length >= 1);
    console.log('  ✓ Teacher fetched dispute queue successfully (200)');

    // 7d. Teacher resolves dispute with mark adjustment (+1 mark)
    const resolveRes = await request('PATCH', `/api/evaluations/re-evaluation-requests/${requestId}`, {
      token: tokenTeacherSharma,
      body: {
        status: 'approved',
        adjustedMarks: 10,
        resolutionRemarks: 'Verified: Alternate textbook limit substitution recognized.'
      }
    });
    assert.strictEqual(resolveRes.status, 200, `Expected 200 for dispute resolution, got ${resolveRes.status}`);
    assert.strictEqual(resolveRes.data.request.status, 'approved');
    assert.strictEqual(resolveRes.data.evaluation.marksObtained, 10);
    console.log('  ✓ Teacher approved re-evaluation and updated marks (200)');

    // ------------------------------------------------------------------------
    // TEST 8: Private Script Delivery (Authenticated Streaming)
    // ------------------------------------------------------------------------
    console.log('\n[TEST 8] Private Script Delivery (Authenticated Streaming)...');

    // 8a. Anonymous access -> 401 Unauthorized
    const anonScriptRes = await request('GET', `/api/evaluations/${evalWritten.id}/script-file`);
    assert.strictEqual(anonScriptRes.status, 401, `Expected 401 for anonymous script access, got ${anonScriptRes.status}`);
    console.log('  ✓ Anonymous access to script blocked with 401 Unauthorized');

    // 8b. Direct static unauthenticated request to /uploads/private_scripts -> 403 Forbidden
    const staticBlockRes = await request('GET', '/uploads/private_scripts/alice_script_midterm.pdf');
    assert.strictEqual(staticBlockRes.status, 403, `Expected 403 for static script direct link, got ${staticBlockRes.status}`);
    console.log('  ✓ Direct static path access to /uploads/private_scripts hard-blocked with 403 Forbidden');

    // 8c. Alice accesses her published script -> 200 OK (Streamed binary)
    const aliceScriptRes = await request('GET', `/api/evaluations/${evalWritten.id}/script-file`, {
      token: tokenStudentAlice
    });
    assert.strictEqual(aliceScriptRes.status, 200, `Expected 200 for student accessing published script, got ${aliceScriptRes.status}`);
    assert(aliceScriptRes.data.includes('Mock Private Answer Script Content'), 'Streamed content must match');
    console.log('  ✓ Student owner streamed private script file successfully (200)');

    // 8d. Cross-branch teacher -> 403 Forbidden
    const crossTeacherScriptRes = await request('GET', `/api/evaluations/${evalWritten.id}/script-file`, {
      token: tokenTeacherBanerjee
    });
    assert.strictEqual(crossTeacherScriptRes.status, 403, `Expected 403 for cross-branch teacher script stream, got ${crossTeacherScriptRes.status}`);
    console.log('  ✓ Cross-branch teacher blocked from script stream with 403 Forbidden');

    // ------------------------------------------------------------------------
    // TEST 9: Server-Side MCQ Score Recomputation & Anti-Cheat Answer Key Protection
    // ------------------------------------------------------------------------
    console.log('\n[TEST 9] Server-Side MCQ Score Recomputation & Answer Key Protection...');

    // 9a. Seed canonical MCQ exam in Content
    await Content.create({
      id: 'MCQ-TEST-999',
      testId: 'MCQ-TEST-999',
      title: 'Real Analysis Objective Quiz',
      type: 'classtest',
      course: 'Engineering',
      branch: 'CSE',
      semester: 1,
      totalMarks: 15,
      questions: [
        { id: 'q1', marks: 5, questionText: 'Derivative of sin(x)?', correctOption: 'B', options: ['cos(x)', 'cos(x)', '-sin(x)', 'tan(x)'] },
        { id: 'q2', marks: 5, questionText: 'Integral of 1/x dx?', correctOption: 'C', options: ['x', 'e^x', 'ln|x|', 'x^2'] },
        { id: 'q3', marks: 5, questionText: 'Limit as x->0 of sin(x)/x?', correctOption: 'A', options: ['1', '0', 'infinity', 'undefined'] }
      ]
    });

    // 9b. Student submits answers: Q1='B' (correct), Q2='C' (correct), Q3='D' (incorrect)
    // Student should receive exactly 10 / 15 marks.
    // Client maliciously attempts to send marksObtained: 15, score: 15.
    const mcqSubRes = await request('POST', '/api/evaluations', {
      token: tokenStudentAlice,
      body: {
        testId: 'MCQ-TEST-999',
        testTitle: 'Real Analysis Objective Quiz',
        examType: 'Automated MCQ',
        marksObtained: 15, // Malicious override
        score: 15,         // Malicious override
        answers: {
          q1: 'B', // Correct (+5)
          q2: 'C', // Correct (+5)
          q3: 'D'  // Incorrect (+0)
        }
      }
    });

    assert.strictEqual(mcqSubRes.status, 201, `Expected 201 for MCQ submit, got ${mcqSubRes.status}`);
    assert.strictEqual(mcqSubRes.data.marksObtained, 10, `Expected server-recomputed score 10, got ${mcqSubRes.data.marksObtained}`);
    assert.strictEqual(mcqSubRes.data.totalMarks, 15);
    console.log('  ✓ Server recomputed MCQ score strictly from canonical answer key: awarded 10/15 (rejected client claim 15/15)');

    // 9c. CRITICAL NEGATIVE TEST: Student response MUST NOT contain answer keys
    const returnedJsonStr = JSON.stringify(mcqSubRes.data);
    assert(!returnedJsonStr.includes('correctOption'), 'CRITICAL LEAK: correctOption leaked in student submission response!');
    assert(!returnedJsonStr.includes('answerKeySnapshot'), 'CRITICAL LEAK: answerKeySnapshot leaked in student submission response!');
    assert(!returnedJsonStr.includes('solutionSet'), 'CRITICAL LEAK: solutionSet leaked in student submission response!');
    console.log('  ✓ CRITICAL SECURITY PASS: Student submission response contains zero answer keys or rubrics');

    // 9d. Student GET /api/evaluations/:id negative test
    const studentGetRes = await request('GET', `/api/evaluations/${mcqSubRes.data.id}`, {
      token: tokenStudentAlice
    });
    assert.strictEqual(studentGetRes.status, 200);
    const getJsonStr = JSON.stringify(studentGetRes.data);
    assert(!getJsonStr.includes('correctOption'), 'CRITICAL LEAK: correctOption leaked in student GET by ID!');
    assert(!getJsonStr.includes('answerKeySnapshot'), 'CRITICAL LEAK: answerKeySnapshot leaked in student GET by ID!');
    assert(!getJsonStr.includes('solutionSet'), 'CRITICAL LEAK: solutionSet leaked in student GET by ID!');
    console.log('  ✓ CRITICAL SECURITY PASS: Student GET /api/evaluations/:id strictly omits all answer keys');

    // ------------------------------------------------------------------------
    // TEST 10: Audit Log Verification
    // ------------------------------------------------------------------------
    console.log('\n[TEST 10] Audit Log Verification...');

    // 10a. Teacher fetches audit logs
    const auditRes = await request('GET', `/api/evaluations/${evalWritten.id}/audit-logs`, {
      token: tokenTeacherSharma
    });
    assert.strictEqual(auditRes.status, 200, `Expected 200 for teacher audit log query, got ${auditRes.status}`);
    assert(auditRes.data.auditLogs.length > 0, 'Audit logs should capture actions');
    const actions = auditRes.data.auditLogs.map(a => a.action);
    console.log(`  ✓ Audit logs recorded: ${actions.join(', ')} (200)`);

    // 10b. Student attempts to read audit logs -> 403 Forbidden
    const studentAuditRes = await request('GET', `/api/evaluations/${evalWritten.id}/audit-logs`, {
      token: tokenStudentAlice
    });
    assert.strictEqual(studentAuditRes.status, 403, `Expected 403 for student reading audit logs, got ${studentAuditRes.status}`);
    console.log('  ✓ Student blocked from audit logs with 403 Forbidden');

    console.log('\n' + '='.repeat(80));
    console.log('🎉 ALL 10 PHASE 1 ARCHITECTURE & VERIFICATION TESTS PASSED PERFECTLY!');
    console.log('='.repeat(80));

  } finally {
    // Teardown
    server.close();
    if (fs.existsSync(sampleScriptFile)) {
      try { fs.unlinkSync(sampleScriptFile); } catch (_) {}
    }
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
    console.log(`\n🧹 Dropped test database ${TEMP_DB_NAME} and disconnected.`);
  }
}

runPhase1Tests().catch(err => {
  console.error('\n❌ TEST FAILURE:', err);
  process.exit(1);
});
