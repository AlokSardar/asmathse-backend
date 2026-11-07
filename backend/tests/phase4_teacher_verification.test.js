/**
 * Phase 4 Comprehensive Automated Verification Test
 * Real HTTP calls against live server: http://localhost:5000
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config();

const BASE_URL = 'http://localhost:5000/api';

async function login(email, password) {
  const res = await fetch(`${BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json();
  if (!res.ok || !data.token) {
    throw new Error(`Login failed for ${email}: ${data.message || res.status}`);
  }
  return { token: data.token, user: data.user || data };
}

async function api(endpoint, options = {}, token = null) {
  const headers = { ...(options.headers || {}) };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (!headers['Content-Type'] && !(options.body instanceof FormData) && typeof options.body === 'object') {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(options.body);
  }

  const res = await fetch(`${BASE_URL}${endpoint}`, {
    ...options,
    headers,
  });

  let data = null;
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    data = await res.json();
  } else {
    data = await res.text();
  }

  return { status: res.status, ok: res.ok, data };
}

async function runAllVerificationTests() {
  console.log('================================================================');
  console.log('🚀 STARTING PHASE 4 TEACHER WORKSPACE & SECURITY VERIFICATION');
  console.log('================================================================\n');

  // 1. Authenticate All Personas
  console.log('1. Authenticating test personas with live credentials...');
  const studentA = await login('student@asmaths.edu', 'TestPassword123!');
  const studentB = await login('student2@asmaths.edu', 'TestPassword123!');
  const teacherEng = await login('mukherjee.eng@asmaths.edu', 'TestPassword123!');
  const teacherEng2 = await login('ghosh.eng@asmaths.edu', 'TestPassword123!');
  const teacherBsc = await login('banerjee.bsc@asmaths.edu', 'TestPassword123!');
  const admin = await login('admin@asmaths.com', 'AdminPassword123!');

  console.log('   ✓ Student A (Engineering): Authenticated');
  console.log('   ✓ Student B (Engineering): Authenticated');
  console.log('   ✓ Teacher 1 (Engineering / CSE): Authenticated');
  console.log('   ✓ Teacher 1B (Engineering / CSE): Authenticated');
  console.log('   ✓ Teacher 2 (B.Sc / Maths): Authenticated');
  console.log('   ✓ Master Admin: Authenticated\n');

  // Reset student quota for reproducible testing
  if (process.env.MONGO_URI) {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGO_URI);
    }
    const studentIdStr = String(studentA.user?.id || studentA.user?._id || '');
    await mongoose.connection.collection('studentdailyquotas').deleteMany({ studentId: studentIdStr });
    console.log(`   ✓ Reset test student daily quota for student ${studentIdStr}.\n`);
  }

  // ── TEST SUITE A: POSITIVE FULL ESCALATION LIFECYCLE ───────────────────────
  console.log('── SUITE A: FULL ESCALATION & RESOLUTION LIFECYCLE ──');

  // A1. Student A creates an Engineering doubt
  console.log('A1. Student A submits typed calculus doubt...');
  const createRes = await api(
    '/doubts/ask',
    {
      method: 'POST',
      body: {
        title: 'Evaluate the definite integral of x*e^(2x) from 0 to 1',
        topic: 'Integration by Parts',
        subject: 'Mathematics',
        language: 'en',
      },
    },
    studentA.token
  );
  assert.strictEqual(createRes.status, 202, `Submission should return HTTP 202 Accepted. Got ${createRes.status}: ${JSON.stringify(createRes.data)}`);
  const doubtId = createRes.data.doubtId || createRes.data.doubt?._id;
  const doubtCode = createRes.data.doubtCode || createRes.data.doubt?.doubtCode;
  console.log(`   ✓ Created doubt ticket: ${doubtCode} (ID: ${doubtId})`);

  // A2. Escalate directly to faculty queue
  console.log('A2. Student A escalates doubt to Faculty Queue...');
  const escRes = await api(
    `/doubts/${doubtId}/escalate`,
    {
      method: 'POST',
      body: { reason: 'Need senior faculty explanation for integration by parts vs substitution.' },
    },
    studentA.token
  );
  assert.strictEqual(escRes.status, 200, 'Escalation should return HTTP 200 OK');
  assert.ok(escRes.data.slaDeadline, 'Must return 24-hour SLA deadline');
  console.log(`   ✓ Ticket escalated with 24h SLA. Deadline: ${new Date(escRes.data.slaDeadline).toISOString()}`);

  // A3. Teacher 1 (Engineering) checks queue
  console.log('A3. Teacher 1 (Engineering) inspects review queue...');
  const queueRes = await api('/doubts/teacher/queue', { method: 'GET' }, teacherEng.token);
  assert.strictEqual(queueRes.status, 200);
  const foundInQueue = queueRes.data.queue.find((d) => d._id === doubtId);
  assert.ok(foundInQueue, 'Escalated doubt must be present in Engineering faculty queue');
  assert.strictEqual(foundInQueue.status, 'escalated');
  assert.ok(foundInQueue.slaRemainingMs > 0, 'SLA remaining ms must be computed from real timestamp');
  console.log(`   ✓ Doubt verified in queue. Counters: Total=${queueRes.data.counters.total}, Unassigned=${queueRes.data.counters.unassigned}`);

  // A4. Teacher 1 claims doubt
  console.log('A4. Teacher 1 claims doubt ticket...');
  const claimRes = await api(`/doubts/${doubtId}/claim`, { method: 'POST' }, teacherEng.token);
  assert.strictEqual(claimRes.status, 200);
  assert.strictEqual(claimRes.data.doubt.status, 'teacher_assigned');
  assert.strictEqual(claimRes.data.doubt.assignedTeacher.email, 'mukherjee.eng@asmaths.edu');
  console.log(`   ✓ Ticket successfully claimed by ${claimRes.data.doubt.assignedTeacher.name}`);

  // A5. Verify Student A receives notification of claim
  console.log('A5. Student A checks notifications for claim alert...');
  const notifRes = await api('/doubts/notifications', { method: 'GET' }, studentA.token);
  assert.strictEqual(notifRes.status, 200);
  const claimNotif = notifRes.data.notifications.find((n) => n.doubtId === doubtId && n.type === 'doubt_claimed');
  assert.ok(claimNotif, 'Student must receive doubt_claimed notification');
  console.log(`   ✓ Student received notification: "${claimNotif.title}" - ${claimNotif.message}`);

  // A6. Teacher 1 publishes verified LaTeX solution
  console.log('A6. Teacher 1 publishes verified LaTeX solution...');
  const replyRes = await api(
    `/doubts/${doubtId}/teacher-reply`,
    {
      method: 'POST',
      body: {
        solutionPlain: 'We apply Integration by Parts: \\int u \\, dv = uv - \\int v \\, du. Let u = x and dv = e^{2x}dx. Then du = dx and v = \\frac{1}{2}e^{2x}.',
        solutionLatex: '\\int_{0}^{1} x e^{2x} dx = \\left[ \\frac{1}{2} x e^{2x} \\right]_{0}^{1} - \\int_{0}^{1} \\frac{1}{2} e^{2x} dx = \\frac{1}{2} e^2 - \\left[ \\frac{1}{4} e^{2x} \\right]_{0}^{1} = \\frac{1}{4}(e^2 + 1)',
        markResolved: true,
      },
    },
    teacherEng.token
  );
  assert.strictEqual(replyRes.status, 200);
  assert.strictEqual(replyRes.data.doubt.status, 'resolved');
  assert.strictEqual(replyRes.data.doubt.resolvedBy, 'teacher');
  console.log('   ✓ Verified LaTeX solution published and stamped as resolved by teacher');

  // A7. Student A receives teacher reply notification
  console.log('A7. Student A verifies reply notification...');
  const studentNotifRes = await api('/doubts/notifications', { method: 'GET' }, studentA.token);
  const replyNotif = studentNotifRes.data.notifications.find((n) => n.doubtId === doubtId && n.type === 'doubt_reply');
  assert.ok(replyNotif, 'Student must receive doubt_reply notification');
  console.log(`   ✓ Student received notification: "${replyNotif.title}"`);

  // A8. Student A reopens once
  console.log('A8. Student A reopens resolved ticket (allowed max 1 time)...');
  const reopenRes = await api(
    `/doubts/${doubtId}/reopen`,
    {
      method: 'POST',
      body: { message: 'Can you clarify the boundary substitution at x = 0?' },
    },
    studentA.token
  );
  assert.strictEqual(reopenRes.status, 200);
  assert.strictEqual(reopenRes.data.doubt.status, 'reopened');
  assert.strictEqual(reopenRes.data.doubt.reopenCount, 1);
  console.log('   ✓ Doubt successfully reopened once. Status: reopened');

  // A9. Student A tries to reopen a SECOND time -> Must be rejected with HTTP 400
  console.log('A9. Student A attempts second reopen (must be rejected)...');
  const reopen2Res = await api(
    `/doubts/${doubtId}/reopen`,
    {
      method: 'POST',
      body: { message: 'Another reopen attempt.' },
    },
    studentA.token
  );
  assert.strictEqual(reopen2Res.status, 400, 'Second reopen must return HTTP 400 Bad Request');
  console.log(`   ✓ Second reopen rejected as expected: "${reopen2Res.data.message}"\n`);


  // ── TEST SUITE B: NEGATIVE SECURITY & ACADEMIC ISOLATION ───────────────────
  console.log('── SUITE B: NEGATIVE SECURITY & ACADEMIC ISOLATION ──');

  // B1. Teacher 2 (B.Sc) tries to claim Student A's Engineering doubt -> HTTP 403
  console.log('B1. Teacher 2 (B.Sc) attempts to claim Engineering doubt...');
  const bscClaimRes = await api(`/doubts/${doubtId}/claim`, { method: 'POST' }, teacherBsc.token);
  assert.strictEqual(bscClaimRes.status, 403, 'Cross-course claim must be blocked with HTTP 403');
  console.log(`   ✓ Blocked with HTTP 403: "${bscClaimRes.data.message}"`);

  // B2. Teacher 2 (B.Sc) checks queue -> Engineering doubt must NOT appear
  console.log('B2. Teacher 2 (B.Sc) inspects queue for course leakage...');
  const bscQueueRes = await api('/doubts/teacher/queue', { method: 'GET' }, teacherBsc.token);
  assert.strictEqual(bscQueueRes.status, 200);
  const leakedInBsc = bscQueueRes.data.queue.find((d) => d._id === doubtId);
  assert.strictEqual(leakedInBsc, undefined, 'Engineering doubt must NOT leak into B.Sc queue');
  console.log('   ✓ Zero leakage: Engineering doubt is strictly hidden from B.Sc faculty');

  // B3. Student calls teacher endpoints -> Must be HTTP 403
  console.log('B3. Student attempts to invoke faculty endpoints...');
  const studentQueue = await api('/doubts/teacher/queue', { method: 'GET' }, studentA.token);
  assert.strictEqual(studentQueue.status, 403, 'Student cannot view teacher queue');
  const studentClaim = await api(`/doubts/${doubtId}/claim`, { method: 'POST' }, studentA.token);
  assert.strictEqual(studentClaim.status, 403, 'Student cannot claim doubts');
  const studentReply = await api(
    `/doubts/${doubtId}/teacher-reply`,
    { method: 'POST', body: { solutionPlain: 'Fake' } },
    studentA.token
  );
  assert.strictEqual(studentReply.status, 403, 'Student cannot post teacher replies');
  const studentClarify = await api(
    `/doubts/${doubtId}/request-clarification`,
    { method: 'POST', body: { prompt: 'Fake' } },
    studentA.token
  );
  assert.strictEqual(studentClarify.status, 403, 'Student cannot request teacher clarifications');
  console.log('   ✓ All faculty mutations blocked for students with HTTP 403');

  // B4. Student B tries to read Student A's private doubt thread -> HTTP 403
  console.log('B4. Student B attempts to read Student A\'s private doubt...');
  const privacyRes = await api(`/doubts/${doubtId}`, { method: 'GET' }, studentB.token);
  assert.strictEqual(privacyRes.status, 403, 'Cross-student inspection must return HTTP 403');
  console.log(`   ✓ Privacy enforced: Student B blocked with HTTP 403: "${privacyRes.data.message}"`);

  // B5. Teacher 1B tries to answer Teacher 1's claimed doubt -> HTTP 403
  console.log('B5. Teacher 1B attempts to publish on Teacher 1\'s claimed doubt...');
  // Claim doubt by Teacher 1
  await api(`/doubts/${doubtId}/claim`, { method: 'POST' }, teacherEng.token);
  const stealAnswerRes = await api(
    `/doubts/${doubtId}/teacher-reply`,
    {
      method: 'POST',
      body: { solutionPlain: 'Attempt to hijack ticket answer by another teacher.' },
    },
    teacherEng2.token
  );
  assert.strictEqual(stealAnswerRes.status, 403, 'Faculty cannot answer another faculty\'s claimed ticket');
  console.log(`   ✓ Protected: Blocked with HTTP 403: "${stealAnswerRes.data.message}"\n`);


  // ── TEST SUITE C: PARALLEL ATOMIC CLAIM RACE CONDITION ─────────────────────
  console.log('── SUITE C: PARALLEL ATOMIC CLAIM RACE CONDITION ──');
  // Reset student quota so race doubt can be created
  if (process.env.MONGO_URI) {
    const studentIdStr = String(studentA.user?.id || studentA.user?._id || '');
    await mongoose.connection.collection('studentdailyquotas').deleteMany({ studentId: studentIdStr });
  }

  // Create a brand new unclaimed doubt
  const raceDoubtRes = await api(
    '/doubts/ask',
    {
      method: 'POST',
      body: {
        title: 'Concurrent Race Test: State the Cauchy-Schwarz Inequality',
        topic: 'Linear Algebra',
        subject: 'Mathematics',
        language: 'en',
      },
    },
    studentA.token
  );
  assert.strictEqual(raceDoubtRes.status, 202, `Race doubt creation failed: ${JSON.stringify(raceDoubtRes.data)}`);
  const raceDoubtId = raceDoubtRes.data.doubtId || raceDoubtRes.data.doubt?._id;
  const raceDoubtCode = raceDoubtRes.data.doubtCode || raceDoubtRes.data.doubt?.doubtCode;
  await api(
    `/doubts/${raceDoubtId}/escalate`,
    { method: 'POST', body: { reason: 'Race condition test' } },
    studentA.token
  );

  console.log(`C1. Dispatching 2 simultaneous atomic claims on unclaimed ticket ${raceDoubtCode}...`);
  const [claimResponse1, claimResponse2] = await Promise.all([
    api(`/doubts/${raceDoubtId}/claim`, { method: 'POST' }, teacherEng.token),
    api(`/doubts/${raceDoubtId}/claim`, { method: 'POST' }, teacherEng2.token),
  ]);

  const statuses = [claimResponse1.status, claimResponse2.status].sort();
  console.log(`   Claim Result 1: HTTP ${claimResponse1.status} - ${claimResponse1.data.message}`);
  console.log(`   Claim Result 2: HTTP ${claimResponse2.status} - ${claimResponse2.data.message}`);

  assert.deepStrictEqual(
    statuses,
    [200, 409],
    'Atomic claim race condition must result in exactly one 200 OK and one 409 Conflict'
  );
  console.log('   ✓ Atomic race-condition protection verified: Exactly one winner (200), one conflict (409)!\n');


  // ── TEST SUITE D: TEMPLATE CRUD & CLARIFICATION LOOP ───────────────────────
  console.log('── SUITE D: TEMPLATE CRUD & CLARIFICATION WORKFLOW ──');

  // D1. Create Template
  console.log('D1. Teacher 1 creates a saved solution template...');
  const tplCreateRes = await api(
    '/doubts/templates',
    {
      method: 'POST',
      body: {
        title: 'Standard Cauchy-Schwarz Template',
        category: 'Linear Algebra',
        contentPlain: 'Recall that for any vectors u and v in an inner product space:',
        contentLatex: '|\\langle u, v \\rangle|^2 \\le \\langle u, u \\rangle \\cdot \\langle v, v \\rangle',
      },
    },
    teacherEng.token
  );
  assert.strictEqual(tplCreateRes.status, 200);
  const templateId = tplCreateRes.data.template._id;
  console.log(`   ✓ Template created: "${tplCreateRes.data.template.title}" (ID: ${templateId})`);

  // D2. List Templates
  console.log('D2. Teacher 1 lists personal templates...');
  const tplListRes = await api('/doubts/templates', { method: 'GET' }, teacherEng.token);
  assert.strictEqual(tplListRes.status, 200);
  const foundTpl = tplListRes.data.templates.find((t) => t._id === templateId);
  assert.ok(foundTpl, 'Template must be found in teacher\'s personal library');
  console.log(`   ✓ Template library verified (${tplListRes.data.templates.length} saved templates)`);

  // D3. Delete Template
  console.log('D3. Teacher 1 deletes template...');
  const tplDelRes = await api(`/doubts/templates/${templateId}`, { method: 'DELETE' }, teacherEng.token);
  assert.strictEqual(tplDelRes.status, 200);
  console.log('   ✓ Template deleted successfully');

  // D4. Clarification Request Flow
  console.log('D4. Teacher 1 requests clarification from student...');
  const clarifyReq = await api(
    `/doubts/${raceDoubtId}/request-clarification`,
    {
      method: 'POST',
      body: { prompt: 'Are you working over real vector space R^n or complex space C^n?' },
    },
    teacherEng.token
  );
  assert.strictEqual(clarifyReq.status, 200);
  assert.strictEqual(clarifyReq.data.doubt.status, 'clarification_requested');
  console.log(`   ✓ Clarification requested. Status: clarification_requested`);

  // D5. Student responds to clarification
  console.log('D5. Student responds to clarification prompt...');
  const clarifyResp = await api(
    `/doubts/${raceDoubtId}/respond-clarification`,
    {
      method: 'POST',
      body: { message: 'We are working over R^n with standard Euclidean inner product.' },
    },
    studentA.token
  );
  assert.strictEqual(clarifyResp.status, 200);
  assert.strictEqual(clarifyResp.data.doubt.status, 'teacher_assigned');
  console.log(`   ✓ Student responded. Ticket returned to assigned teacher`);

  // D6. Unclaim & Return to Pool
  console.log('D6. Teacher 1 unclaims ticket...');
  const unclaimRes = await api(`/doubts/${raceDoubtId}/unclaim`, { method: 'POST' }, teacherEng.token);
  assert.strictEqual(unclaimRes.status, 200);
  assert.strictEqual(unclaimRes.data.doubt.status, 'escalated');
  assert.strictEqual(unclaimRes.data.doubt.assignedTeacher, null);
  console.log(`   ✓ Ticket unclaimed and returned to faculty pool\n`);

  console.log('================================================================');
  console.log('🎉 ALL PHASE 4 TEACHER WORKSPACE & SECURITY TESTS PASSED (100%)');
  console.log('================================================================');
}

runAllVerificationTests().catch((err) => {
  console.error('\n❌ VERIFICATION TEST FAILED:', err);
  process.exit(1);
});
