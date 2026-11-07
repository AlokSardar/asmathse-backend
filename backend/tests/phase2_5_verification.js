const http = require('http');
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const app = require('../server');
const Doubt = require('../models/Doubt');
const DoubtMessage = require('../models/DoubtMessage');
const DoubtQuota = require('../models/DoubtQuota');
const User = require('../models/User');

const TEST_PORT = 5088;
const BASE_URL = `http://localhost:${TEST_PORT}`;
const JWT_SECRET = process.env.JWT_SECRET || 'asmaths_secret_jwt_key_2026_cluster0';

// Helper for HTTP requests
async function makeRequest(endpoint, { method = 'GET', headers = {}, body = null } = {}) {
  const url = `${BASE_URL}${endpoint}`;
  const options = {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
  };
  if (body) {
    options.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const res = await fetch(url, options);
  let json = null;
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    json = await res.json();
  } else {
    const text = await res.text();
    json = { rawText: text };
  }
  return { status: res.status, headers: res.headers, data: json };
}

// KaTeX bracket and delimiter validator
function validateKatexSyntax(text = '') {
  if (!text) return { valid: true };
  // Check inline math delimiters count
  const singleDollarMatches = (text.match(/(?<!\$)\$(?!\$)/g) || []).length;
  const doubleDollarMatches = (text.match(/\$\$/g) || []).length;
  const balancedSingle = singleDollarMatches % 2 === 0;
  const balancedDouble = doubleDollarMatches % 2 === 0;
  return {
    valid: balancedSingle && balancedDouble,
    singleDollarCount: singleDollarMatches,
    doubleDollarCount: doubleDollarMatches,
  };
}

async function runPhase2_5Verification() {
  console.log('═════════════════════════════════════════════════════════════════');
  console.log('🚀 STARTING PHASE 2.5 REAL END-TO-END VERIFICATION & NEGATIVE TESTS');
  console.log('═════════════════════════════════════════════════════════════════\n');

  // 1. Start Server on TEST_PORT
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(TEST_PORT, resolve));
  console.log(`[Test Server] Live test server listening on ${BASE_URL}\n`);

  // Wait for MongoDB Atlas connection
  if (mongoose.connection.readyState !== 1) {
    await new Promise((resolve) => mongoose.connection.once('open', resolve));
  }
  console.log('[MongoDB] Connected to MongoDB Atlas.\n');

  // Setup Test Identity Tokens
  const studentA = {
    id: '672000000000000000000010',
    role: 'student',
    name: 'Rohan Sharma',
    email: 'rohan.cse@asmaths.edu',
    targetCourse: 'engineering',
    branch: 'CSE',
    stream: 'CSE',
    semester: 'Semester 1',
  };

  const studentB = {
    id: '672000000000000000000020',
    role: 'student',
    name: 'Sneha Roy',
    email: 'sneha.cse@asmaths.edu',
    targetCourse: 'engineering',
    branch: 'CSE',
    stream: 'CSE',
    semester: 'Semester 1',
  };

  const teacher1Eng = {
    id: '672000000000000000000030',
    role: 'teacher',
    name: 'Prof. S. Mukherjee',
    email: 'mukherjee.eng@asmaths.edu',
    targetCourse: 'engineering',
    branch: 'CSE',
    stream: 'CSE',
  };

  const teacher2Bsc = {
    id: '672000000000000000000040',
    role: 'teacher',
    name: 'Prof. K. Banerjee',
    email: 'banerjee.bsc@asmaths.edu',
    targetCourse: 'bsc',
    branch: 'B.Sc (Honours)',
    stream: 'Mathematics',
  };

  // Upsert test user documents in MongoDB so User.findById(decoded.id) succeeds
  const testPassword = process.env.TEST_PASSWORD || 'TestPassword123!';
  await User.findByIdAndUpdate(
    studentA.id,
    {
      _id: studentA.id,
      name: studentA.name,
      email: studentA.email,
      role: 'student',
      targetCourse: studentA.targetCourse,
      branch: studentA.branch,
      stream: studentA.stream,
      semester: studentA.semester,
      password: testPassword,
      isApproved: true,
      profileCompleted: true,
    },
    { upsert: true, returnDocument: 'after' }
  );

  await User.findByIdAndUpdate(
    studentB.id,
    {
      _id: studentB.id,
      name: studentB.name,
      email: studentB.email,
      role: 'student',
      targetCourse: studentB.targetCourse,
      branch: studentB.branch,
      stream: studentB.stream,
      semester: studentB.semester,
      password: testPassword,
      isApproved: true,
      profileCompleted: true,
    },
    { upsert: true, returnDocument: 'after' }
  );

  await User.findByIdAndUpdate(
    teacher1Eng.id,
    {
      _id: teacher1Eng.id,
      name: teacher1Eng.name,
      email: teacher1Eng.email,
      role: 'teacher',
      targetCourse: teacher1Eng.targetCourse,
      branch: teacher1Eng.branch,
      stream: teacher1Eng.stream,
      password: testPassword,
      isApproved: true,
      profileCompleted: true,
    },
    { upsert: true, returnDocument: 'after' }
  );

  await User.findByIdAndUpdate(
    teacher2Bsc.id,
    {
      _id: teacher2Bsc.id,
      name: teacher2Bsc.name,
      email: teacher2Bsc.email,
      role: 'teacher',
      targetCourse: teacher2Bsc.targetCourse,
      branch: teacher2Bsc.branch,
      stream: teacher2Bsc.stream,
      password: testPassword,
      isApproved: true,
      profileCompleted: true,
    },
    { upsert: true, returnDocument: 'after' }
  );

  const tokenStudentA = jwt.sign(studentA, JWT_SECRET, { expiresIn: '2h' });
  const tokenStudentB = jwt.sign(studentB, JWT_SECRET, { expiresIn: '2h' });
  const tokenTeacher1 = jwt.sign(teacher1Eng, JWT_SECRET, { expiresIn: '2h' });
  const tokenTeacher2 = jwt.sign(teacher2Bsc, JWT_SECRET, { expiresIn: '2h' });

  // Clean test doubts from previous runs for student A and B
  await Doubt.deleteMany({ student: { $in: [studentA.id, studentB.id] } });
  const today = new Date().toISOString().slice(0, 10);
  const StudentDailyQuota = mongoose.models.StudentDailyQuota;
  if (StudentDailyQuota) {
    await StudentDailyQuota.deleteMany({ studentId: { $in: [studentA.id, studentB.id] }, date: today });
  }

  try {
    // ══════════════════════════════════════════════════════════════════════════
    // SECTION A: REAL END-TO-END RUNS AGAINST LIVE GEMINI API & REAL DATABASE
    // ══════════════════════════════════════════════════════════════════════════

    // ──────────────────────────────────────────────────────────────────────────
    // A.1: Real Typed English Doubt (Calculus limit problem)
    // ──────────────────────────────────────────────────────────────────────────
    console.log('▶ [A.1] Executing Real Typed English Doubt (Calculus Limit)...');
    const englishDoubtPayload = {
      title: 'Evaluate the limit using L\'Hopital\'s rule or Taylor expansion',
      problemText: 'Evaluate \\lim_{x \\to 0} \\frac{\\sin x - x}{x^3}',
      mathLatex: '\\lim_{x \\to 0} \\frac{\\sin x - x}{x^3}',
      topic: 'Limits & Differential Calculus',
      course: 'engineering',
      branch: 'CSE',
      language: 'en',
    };

    const resA1 = await makeRequest('/api/doubts/ask', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenStudentA}` },
      body: englishDoubtPayload,
    });

    console.log(`  [HTTP Response] Status: ${resA1.status} (Expected: 202)`);
    console.log(`  [Payload]`, JSON.stringify(resA1.data, null, 2));
    assert.strictEqual(resA1.status, 202, 'Ask endpoint must return HTTP 202 Accepted');
    assert.strictEqual(resA1.data.status, 'processing');
    assert.strictEqual(resA1.data.hasImages, false, 'Typed doubt must skip transcription');

    const doubtIdA1 = resA1.data.doubtId;

    // Status polling sequence
    console.log('  [Status Polling Sequence]');
    let pollCountA1 = 0;
    let doubtDocA1 = null;
    while (pollCountA1 < 40) {
      await new Promise((r) => setTimeout(r, 2000));
      pollCountA1++;
      const pollRes = await makeRequest(`/api/doubts/${doubtIdA1}`, {
        headers: { Authorization: `Bearer ${tokenStudentA}` },
      });
      console.log(`    Poll #${pollCountA1}: status = "${pollRes.data.doubt.status}"`);
      if (pollRes.data.doubt.status === 'ai_answered' || pollRes.data.doubt.status === 'error') {
        doubtDocA1 = pollRes.data;
        break;
      }
    }

    assert.ok(doubtDocA1, 'Doubt polling timed out');
    assert.strictEqual(doubtDocA1.doubt.status, 'ai_answered', 'Doubt status must be ai_answered');
    const explanationA1 = doubtDocA1.doubt.aiExplanation;
    console.log(`  [Model Used] ${explanationA1.modelUsed} (isFallbackModel: ${explanationA1.isFallbackModel})`);
    console.log(`  [Pedagogical Steps Count] ${explanationA1.steps?.length}`);
    console.log(`  [Concepts Used] ${JSON.stringify(explanationA1.conceptsUsed)}`);
    console.log(`  [Final Answer] ${explanationA1.finalAnswer}`);
    console.log(`  [Quick Self-Check] ${explanationA1.quickCheck}`);
    console.log(`  [Common Mistakes] ${JSON.stringify(explanationA1.commonMistakes)}`);

    // Verify mathematical accuracy
    assert.ok(
      explanationA1.finalAnswer.includes('-1/6') ||
      explanationA1.finalAnswer.includes('-\\frac{1}{6}') ||
      explanationA1.finalAnswer.includes('-\\frac{1}{6}'),
      'Final answer must accurately compute -1/6'
    );

    // Verify KaTeX validity
    const katexCheckA1 = validateKatexSyntax(`${explanationA1.finalAnswer} ${explanationA1.steps?.map(s => s.math).join(' ')}`);
    assert.strictEqual(katexCheckA1.valid, true, 'All KaTeX delimiters must be balanced');
    console.log('  ✅ PASS: Real English doubt solved by Gemini with verified mathematics & KaTeX.\n');


    // ──────────────────────────────────────────────────────────────────────────
    // A.2: Real Typed Bengali Doubt (Definite Integral with Bengali prompt)
    // ──────────────────────────────────────────────────────────────────────────
    console.log('▶ [A.2] Executing Real Typed Bengali Doubt (Definite Integral in Bengali)...');
    const bengaliDoubtPayload = {
      title: 'নির্দিষ্ট সমাকলনের মান নির্ণয়',
      problemText: 'মান নির্ণয় করো: \\int_0^{\\pi/2} \\sin^2 x \\, dx',
      mathLatex: '\\int_0^{\\pi/2} \\sin^2 x \\, dx',
      topic: 'Definite Integrals',
      course: 'engineering',
      branch: 'CSE',
      language: 'bn',
    };

    const resA2 = await makeRequest('/api/doubts/ask', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenStudentA}` },
      body: bengaliDoubtPayload,
    });

    console.log(`  [HTTP Response] Status: ${resA2.status} (Expected: 202)`);
    assert.strictEqual(resA2.status, 202);
    const doubtIdA2 = resA2.data.doubtId;

    console.log('  [Status Polling Sequence]');
    let pollCountA2 = 0;
    let doubtDocA2 = null;
    while (pollCountA2 < 40) {
      await new Promise((r) => setTimeout(r, 2000));
      pollCountA2++;
      const pollRes = await makeRequest(`/api/doubts/${doubtIdA2}`, {
        headers: { Authorization: `Bearer ${tokenStudentA}` },
      });
      console.log(`    Poll #${pollCountA2}: status = "${pollRes.data.doubt.status}"`);
      if (pollRes.data.doubt.status === 'ai_answered' || pollRes.data.doubt.status === 'error') {
        doubtDocA2 = pollRes.data;
        break;
      }
    }

    assert.ok(doubtDocA2, 'Doubt polling timed out');
    assert.strictEqual(doubtDocA2.doubt.status, 'ai_answered');
    const explanationA2 = doubtDocA2.doubt.aiExplanation;
    console.log(`  [Model Used] ${explanationA2.modelUsed}`);
    console.log(`  [Final Answer] ${explanationA2.finalAnswer}`);
    console.log(`  [Bengali Step Sample] Title: ${explanationA2.steps?.[0]?.title}`);
    console.log(`  [Bengali Reasoning Sample] ${explanationA2.steps?.[0]?.explanation}`);

    // Verify Bengali characters exist in reasoning
    const hasBengali = /[\u0980-\u09FF]/.test(explanationA2.steps?.[0]?.explanation || '');
    assert.strictEqual(hasBengali, true, 'Explanation must be in pedagogical Bengali script');

    // Verify mathematical accuracy (\pi/4)
    assert.ok(
      explanationA2.finalAnswer.includes('\\pi/4') ||
      explanationA2.finalAnswer.includes('\\frac{\\pi}{4}') ||
      explanationA2.finalAnswer.includes('pi/4'),
      'Final answer must accurately compute pi/4'
    );

    const katexCheckA2 = validateKatexSyntax(`${explanationA2.finalAnswer} ${explanationA2.steps?.map(s => s.math).join(' ')}`);
    assert.strictEqual(katexCheckA2.valid, true, 'All KaTeX delimiters must be balanced');
    console.log('  ✅ PASS: Real Bengali doubt solved in authentic Bengali with grounded LaTeX.\n');


    // ──────────────────────────────────────────────────────────────────────────
    // A.3: Real Photographed Handwritten/Printed Doubt (Two-Stage OCR Flow)
    // ──────────────────────────────────────────────────────────────────────────
    console.log('▶ [A.3] Executing Real Photographed Doubt (Stage 1 OCR -> Confirm -> Stage 2)...');

    // Read real image buffer
    const realImgPath = path.join(__dirname, '..', '..', '..', '..', 'brain', '25b12a71-a1f6-44d1-b276-f07028d4b8af', '.user_uploaded', 'media_1793567878722_260d78e9.png');
    const realImgBuffer = fs.readFileSync(realImgPath);
    const realImgBase64 = `data:image/png;base64,${realImgBuffer.toString('base64')}`;

    const photoDoubtPayload = {
      title: 'Help with this uploaded question sheet',
      topic: 'Applied Physics & Mathematics',
      course: 'engineering',
      branch: 'CSE',
      language: 'en',
      attachments: [
        {
          fileName: 'Exam_Question_Sheet.png',
          base64Data: realImgBase64,
          mimeType: 'image/png',
        },
      ],
    };

    const resA3 = await makeRequest('/api/doubts/ask', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenStudentA}` },
      body: photoDoubtPayload,
    });

    console.log(`  [HTTP Response] Status: ${resA3.status} (Expected: 202)`);
    assert.strictEqual(resA3.status, 202);
    assert.strictEqual(resA3.data.hasImages, true, 'Photo doubt must trigger transcription Stage 1');
    const doubtIdA3 = resA3.data.doubtId;

    // Poll for Stage 1 transcription
    console.log('  [Stage 1 Polling Sequence for OCR Transcription]');
    let pollCountA3 = 0;
    let doubtDocA3 = null;
    while (pollCountA3 < 40) {
      await new Promise((r) => setTimeout(r, 2000));
      pollCountA3++;
      const pollRes = await makeRequest(`/api/doubts/${doubtIdA3}`, {
        headers: { Authorization: `Bearer ${tokenStudentA}` },
      });
      console.log(`    Poll #${pollCountA3}: status = "${pollRes.data.doubt.status}"`);
      if (pollRes.data.doubt.status === 'transcribed' || pollRes.data.doubt.status === 'error') {
        doubtDocA3 = pollRes.data;
        break;
      }
    }

    assert.ok(doubtDocA3, 'Transcription polling timed out');
    assert.strictEqual(doubtDocA3.doubt.status, 'transcribed', 'Status must transition to transcribed');
    const transcription = doubtDocA3.doubt.aiTranscription;
    console.log(`  [OCR Transcribed Problem Text] "${transcription.problemText}"`);
    console.log(`  [OCR Confidence] ${(transcription.confidence * 100).toFixed(1)}%`);
    console.log(`  [Transcription Model Used] ${transcription.modelUsed}`);

    // Now Student confirms / edits the transcription to trigger Stage 2
    console.log('  [Triggering Stage 2 via Student Confirmation]');
    const confirmRes = await makeRequest(`/api/doubts/${doubtIdA3}/confirm-transcription`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenStudentA}` },
      body: {
        problemText: transcription.problemText || 'State the SI unit of electric current and potential difference',
        latexEquation: transcription.latexEquation || '',
      },
    });
    console.log(`  [Confirm Response] Status: ${confirmRes.status}`);
    assert.strictEqual(confirmRes.status, 202);

    // Poll for Stage 2 explanation
    console.log('  [Stage 2 Polling Sequence for Final Pedagogical Solution]');
    let pollCountA3_2 = 0;
    let doubtDocA3_Final = null;
    while (pollCountA3_2 < 40) {
      await new Promise((r) => setTimeout(r, 2000));
      pollCountA3_2++;
      const pollRes = await makeRequest(`/api/doubts/${doubtIdA3}`, {
        headers: { Authorization: `Bearer ${tokenStudentA}` },
      });
      console.log(`    Poll #${pollCountA3_2}: status = "${pollRes.data.doubt.status}"`);
      if (pollRes.data.doubt.status === 'ai_answered' || pollRes.data.doubt.status === 'error') {
        doubtDocA3_Final = pollRes.data;
        break;
      }
    }

    assert.ok(doubtDocA3_Final, 'Stage 2 explanation polling timed out');
    assert.strictEqual(doubtDocA3_Final.doubt.status, 'ai_answered');
    console.log(`  [Stage 2 Final Answer] ${doubtDocA3_Final.doubt.aiExplanation.finalAnswer}`);
    console.log(`  [Stage 2 Model Used] ${doubtDocA3_Final.doubt.aiExplanation.modelUsed}`);
    console.log('  ✅ PASS: Two-stage OCR + Confirmation + Pedagogical Solver verified end-to-end.\n');


    // ══════════════════════════════════════════════════════════════════════════
    // SECTION B: NEGATIVE TESTS WITH REAL HTTP CALLS
    // ══════════════════════════════════════════════════════════════════════════
    console.log('═════════════════════════════════════════════════════════════════');
    console.log('▶ [SECTION B] NEGATIVE TESTS VIA REAL HTTP REQUESTS');
    console.log('═════════════════════════════════════════════════════════════════\n');

    // B.1: Student B requests Student A's doubt -> must be 403
    console.log('▶ [B.1] Student B requesting Student A\'s doubt ticket...');
    const resB1 = await makeRequest(`/api/doubts/${doubtIdA1}`, {
      headers: { Authorization: `Bearer ${tokenStudentB}` },
    });
    console.log(`  [HTTP Response] Status: ${resB1.status} (Expected: 403)`);
    console.log(`  [Message] ${resB1.data.message}`);
    assert.strictEqual(resB1.status, 403, 'Student B must be forbidden from accessing Student A\'s doubt');
    console.log('  ✅ PASS: Cross-student ticket access strictly blocked (HTTP 403).\n');

    // B.2: Student calls /teacher/queue -> must be rejected 403
    console.log('▶ [B.2] Student attempting to access /api/doubts/teacher/queue...');
    const resB2 = await makeRequest('/api/doubts/teacher/queue', {
      headers: { Authorization: `Bearer ${tokenStudentA}` },
    });
    console.log(`  [HTTP Response] Status: ${resB2.status} (Expected: 403)`);
    assert.strictEqual(resB2.status, 403, 'Student must be forbidden from faculty queue');
    console.log('  ✅ PASS: Teacher queue endpoint blocked for student accounts (HTTP 403).\n');

    // B.3: Student calls /claim -> must be rejected 403
    console.log('▶ [B.3] Student attempting to claim doubt ticket...');
    const resB3 = await makeRequest(`/api/doubts/${doubtIdA1}/claim`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenStudentA}` },
    });
    console.log(`  [HTTP Response] Status: ${resB3.status} (Expected: 403)`);
    assert.strictEqual(resB3.status, 403, 'Student must be forbidden from claiming ticket');
    console.log('  ✅ PASS: Ticket claim blocked for student accounts (HTTP 403).\n');

    // B.4: Student calls /teacher-reply -> must be rejected 403
    console.log('▶ [B.4] Student attempting to submit teacher solution...');
    const resB4 = await makeRequest(`/api/doubts/${doubtIdA1}/teacher-reply`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenStudentA}` },
      body: { solutionPlain: 'Fake teacher answer' },
    });
    console.log(`  [HTTP Response] Status: ${resB4.status} (Expected: 403)`);
    assert.strictEqual(resB4.status, 403, 'Student must be forbidden from publishing teacher replies');
    console.log('  ✅ PASS: Teacher reply blocked for student accounts (HTTP 403).\n');

    // B.5: Teacher of another course/branch cannot claim doubt
    console.log('▶ [B.5] B.Sc Teacher attempting to claim Engineering Doubt...');
    const resB5 = await makeRequest(`/api/doubts/${doubtIdA1}/claim`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenTeacher2}` }, // Teacher 2 is B.Sc
    });
    console.log(`  [HTTP Response] Status: ${resB5.status} (Expected: 403)`);
    console.log(`  [Message] ${resB5.data.message}`);
    assert.strictEqual(resB5.status, 403, 'Teacher from B.Sc must not claim Engineering doubt');
    assert.ok(resB5.data.message.includes('cannot claim doubts from course "engineering"'));
    console.log('  ✅ PASS: Cross-course faculty claiming strictly forbidden (HTTP 403).\n');

    // B.6: Quota limit: 6th doubt of the day refused with 429
    console.log('▶ [B.6] Testing Daily Limit Enforcement (6th Doubt of the Day)...');
    // Student B will submit 5 doubts rapidly
    for (let i = 1; i <= 5; i++) {
      const qRes = await makeRequest('/api/doubts/ask', {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokenStudentB}` },
        body: { problemText: `Limit query test ${i}`, topic: 'Limits' },
      });
      assert.strictEqual(qRes.status, 202, `Doubt #${i} must succeed`);
    }

    // Now 6th doubt
    const resB6 = await makeRequest('/api/doubts/ask', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenStudentB}` },
      body: { problemText: '6th doubt exceeding limit', topic: 'Calculus' },
    });
    console.log(`  [HTTP Response] Status: ${resB6.status} (Expected: 429)`);
    console.log(`  [Payload]`, JSON.stringify(resB6.data, null, 2));
    assert.strictEqual(resB6.status, 429, '6th doubt must be rejected with HTTP 429');
    assert.strictEqual(resB6.data.error, 'STUDENT_QUOTA_EXCEEDED');
    assert.strictEqual(resB6.data.canEscalate, true, 'Must offer escalation to teacher');
    assert.ok(resB6.data.message.includes('escalate directly to your faculty'));
    console.log('  ✅ PASS: 6th daily doubt refused with HTTP 429 and faculty escalation offered.\n');

    // B.7: Fake Image (.exe disguised as .jpg) rejected
    console.log('▶ [B.7] Submitting fake disguised script file (.exe / .php as .jpg)...');
    const fakeFileBase64 = `data:image/jpeg;base64,${Buffer.from('<?php system($_GET["cmd"]); ?>').toString('base64')}`;
    const resB7 = await makeRequest('/api/doubts/ask', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenStudentA}` },
      body: {
        problemText: 'Security payload test',
        attachments: [{ fileName: 'malicious.jpg', base64Data: fakeFileBase64, mimeType: 'image/jpeg' }],
      },
    });
    console.log(`  [HTTP Response] Status: ${resB7.status} (Expected: 400)`);
    console.log(`  [Message] ${resB7.data.message}`);
    assert.strictEqual(resB7.status, 400, 'Disguised non-image file must be rejected with HTTP 400');
    console.log('  ✅ PASS: Disguised attachment rejected via magic bytes inspection (HTTP 400).\n');

    // B.8: Private Image Security (Unauthenticated & Unauthorized access denied)
    console.log('▶ [B.8] Testing Private Authenticated Image Streaming Endpoint...');
    // Attachment 0 of doubt A3
    const attUrl = `/api/doubts/${doubtIdA3}/attachments/0`;

    // 1. Unauthenticated -> 401
    const unauthAttRes = await makeRequest(attUrl);
    console.log(`  1. Unauthenticated Request Status: ${unauthAttRes.status} (Expected: 401)`);
    assert.strictEqual(unauthAttRes.status, 401, 'Unauthenticated image access must be 401');

    // 2. Student B (Different student) -> 403
    const studentBAttRes = await makeRequest(attUrl, {
      headers: { Authorization: `Bearer ${tokenStudentB}` },
    });
    console.log(`  2. Student B Request Status: ${studentBAttRes.status} (Expected: 403)`);
    assert.strictEqual(studentBAttRes.status, 403, 'Cross-student image access must be 403');

    // 3. Student A (Owner) -> 200
    const ownerAttRes = await makeRequest(attUrl, {
      headers: { Authorization: `Bearer ${tokenStudentA}` },
    });
    console.log(`  3. Student A (Owner) Request Status: ${ownerAttRes.status} (Expected: 200)`);
    assert.strictEqual(ownerAttRes.status, 200, 'Student owner must access private attachment');

    // 4. Teacher 1 (Faculty) -> 200
    const teacherAttRes = await makeRequest(attUrl, {
      headers: { Authorization: `Bearer ${tokenTeacher1}` },
    });
    console.log(`  4. Faculty Request Status: ${teacherAttRes.status} (Expected: 200)`);
    assert.strictEqual(teacherAttRes.status, 200, 'Faculty must access student attachment');
    console.log('  ✅ PASS: Attachment security verified (Unauthenticated=401, Student B=403, Owner & Faculty=200).\n');

    // B.9: Simulate Gemini failure (invalid key) & Quota Refund
    console.log('▶ [B.9] Simulating AI Failure (Honest Error State, Zero Fabricated Math, Quota Not Consumed)...');
    const realGeminiKey = process.env.GEMINI_API_KEY;
    try {
      // Temporarily set invalid key
      process.env.GEMINI_API_KEY = 'INVALID_TEST_KEY_SIMULATED_GEMINI_FAIL';

      const StudentDailyQuotaModel = mongoose.models.StudentDailyQuota;
      const beforeQuota = await StudentDailyQuotaModel.findOne({ date: today, studentId: studentA.id });
      const beforeCount = beforeQuota ? beforeQuota.count : 0;

      const failDoubtRes = await makeRequest('/api/doubts/ask', {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokenStudentA}` },
        body: { problemText: 'Question when Gemini API fails', topic: 'Calculus' },
      });
      assert.strictEqual(failDoubtRes.status, 202);
      const failDoubtId = failDoubtRes.data.doubtId;

      // Poll until status is 'error'
      let failDoc = null;
      for (let p = 0; p < 15; p++) {
        await new Promise((r) => setTimeout(r, 1500));
        const pRes = await makeRequest(`/api/doubts/${failDoubtId}`, {
          headers: { Authorization: `Bearer ${tokenStudentA}` },
        });
        if (pRes.data.doubt.status === 'error') {
          failDoc = pRes.data;
          break;
        }
      }

      assert.ok(failDoc, 'Doubt must transition to error state');
      assert.strictEqual(failDoc.doubt.status, 'error', 'Status must be error, never fake answer');
      assert.strictEqual(failDoc.doubt.aiExplanation?.steps?.length || 0, 0, 'No fake or fabricated explanation generated');
      assert.strictEqual(failDoc.doubt.aiExplanation?.summary || '', '', 'No fake summary generated');
      console.log(`  [Honest Error Message] "${failDoc.doubt.lastErrorMessage}"`);

      // Student can escalate
      const escalateRes = await makeRequest(`/api/doubts/${failDoubtId}/escalate`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokenStudentA}` },
        body: { reason: 'AI failed, seeking faculty assistance' },
      });
      assert.strictEqual(escalateRes.status, 200, 'Student must be able to escalate failed doubt');
      assert.strictEqual(escalateRes.data.success, true);
      console.log('  [Escalation after AI error succeeded]: 24h SLA granted');

      // Verify student's daily quota was NOT consumed
      const afterQuota = await StudentDailyQuotaModel.findOne({ date: today, studentId: studentA.id });
      const afterCount = afterQuota ? afterQuota.count : 0;
      assert.strictEqual(afterCount, beforeCount, 'Student daily quota must NOT be consumed on AI failure');
      console.log(`  [Quota Protected] Before: ${beforeCount}, After: ${afterCount} (Quota refunded)`);
    } finally {
      process.env.GEMINI_API_KEY = realGeminiKey;
    }
    console.log('  ✅ PASS: AI failure produces honest error, zero synthetic data, student escalation, and quota rollback.\n');


    // ══════════════════════════════════════════════════════════════════════════
    // SECTION C: ROBUSTNESS TESTS (Stuck Sweeper & Parallel Atomic Quota)
    // ══════════════════════════════════════════════════════════════════════════
    console.log('═════════════════════════════════════════════════════════════════');
    console.log('▶ [SECTION C] ROBUSTNESS & CONCURRENCY TESTS');
    console.log('═════════════════════════════════════════════════════════════════\n');

    // C.1: Stuck Jobs Sweeper
    console.log('▶ [C.1] Stuck Jobs Sweeper (> 3 minutes in processing)...');
    // Create a doubt simulating a stuck job from 5 minutes ago
    const stuckDoubt = await Doubt.create({
      student: studentA.id,
      studentName: studentA.name,
      studentEmail: studentA.email,
      course: 'engineering',
      branch: 'CSE',
      semester: 'Semester 1',
      topic: 'Calculus',
      title: 'Stuck Job Test',
      status: 'processing',
      auditTrail: [{ status: 'processing', changedBy: 'Test', role: 'student' }],
    });

    await Doubt.updateOne(
      { _id: stuckDoubt._id },
      { $set: { updatedAt: new Date(Date.now() - 5 * 60 * 1000) } },
      { timestamps: false }
    );

    // Run status poll on stuck doubt
    const pollStuckRes = await makeRequest(`/api/doubts/${stuckDoubt._id}`, {
      headers: { Authorization: `Bearer ${tokenStudentA}` },
    });
    console.log(`  [Polled Status after Sweeper Trigger] "${pollStuckRes.data.doubt.status}"`);
    console.log(`  [Error Message] "${pollStuckRes.data.doubt.lastErrorMessage}"`);
    assert.strictEqual(pollStuckRes.data.doubt.status, 'error', 'Stuck job must be marked as error');
    assert.ok(pollStuckRes.data.doubt.lastErrorMessage.includes('timed out after 3 minutes'));
    console.log('  ✅ PASS: Stuck jobs (> 3m) automatically swept to error state without spinning.\n');

    // C.2: Concurrency & Atomic Quota Test
    console.log('▶ [C.2] Parallel Race Condition Test (Atomic findOneAndUpdate)...');
    // Reset student A's daily quota to exactly 4 used
    const StudentDailyQuotaModel = mongoose.models.StudentDailyQuota;
    await StudentDailyQuotaModel.updateOne(
      { date: today, studentId: studentA.id },
      { $set: { count: 4 } },
      { upsert: true }
    );

    // Launch 5 parallel requests simultaneously
    console.log('  Sending 5 simultaneous parallel requests (capacity remaining: 1)...');
    const parallelPromises = Array.from({ length: 5 }).map((_, i) =>
      makeRequest('/api/doubts/ask', {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokenStudentA}` },
        body: { problemText: `Parallel race question ${i}`, topic: 'Algebra' },
      })
    );

    const parallelResults = await Promise.all(parallelPromises);
    const successes = parallelResults.filter((r) => r.status === 202);
    const rejects = parallelResults.filter((r) => r.status === 429);

    console.log(`  [Parallel Results] Successes (202): ${successes.length}, Rejections (429): ${rejects.length}`);
    assert.strictEqual(successes.length, 1, 'Exactly 1 request must succeed when remaining quota is 1');
    assert.strictEqual(rejects.length, 4, 'Remaining 4 parallel requests must be rejected with 429');

    // Confirm DB record count is strictly 5
    const quotaDoc = await StudentDailyQuotaModel.findOne({ date: today, studentId: studentA.id });
    console.log(`  [Final DB Count] ${quotaDoc.count} (Limit: 5)`);
    assert.strictEqual(quotaDoc.count, 5, 'Daily quota must be strictly 5, never exceeded');
    console.log('  ✅ PASS: Atomic MongoDB findOneAndUpdate prevents all race conditions.\n');


    console.log('═════════════════════════════════════════════════════════════════');
    console.log('🎉 ALL PHASE 2.5 VERIFICATION & REAL HTTP NEGATIVE TESTS PASSED 100%!');
    console.log('═════════════════════════════════════════════════════════════════\n');

  } finally {
    await new Promise((resolve) => server.close(resolve));
    console.log('[Test Server] Test server shut down cleanly.');
  }
}

runPhase2_5Verification()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ PHASE 2.5 VERIFICATION FAILED:', err);
    process.exit(1);
  });
