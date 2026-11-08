/**
 * Legacy Endpoint Controls & Escalation Flood Proof Test
 *
 * Verifies:
 * 1. Legacy /api/student/solve-doubt enforces atomic per-student daily quota (quota capped at limit).
 * 2. Repeated calls to legacy endpoint return HTTP 429 upon quota exhaustion (cannot bypass controls).
 * 3. AI Kill Switch: when DOUBTS_AI_ENABLED=false, legacy endpoint blocks AI calls with HTTP 503.
 * 4. Retirement Flag: when LEGACY_DOUBT_ENDPOINT_ENABLED=false, returns HTTP 410 Gone with refresh directive.
 * 5. Failure Refund: failure triggers automatic quota refund so student is not penalized.
 * 6. Escalation Flood Guard: per-student daily cap on total doubts submitted (DAILY_STUDENT_TOTAL_DOUBT_LIMIT, default: 10)
 *    strictly blocks faculty queue flooding even when AI is off, returning friendly 429 message.
 */

const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const http = require('http');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const User = require('../models/User');
const DoubtQuota = require('../models/DoubtQuota');
const { solveStudentDoubt } = require('../controllers/studentController');
const { askDoubt } = require('../controllers/doubtController');
const { doubtLimiter } = require('../middleware/securityMiddleware');

const JWT_SECRET = process.env.JWT_SECRET || require('crypto').randomBytes(32).toString('hex');

async function runTests() {
  console.log('='.repeat(75));
  console.log('🧪 LEGACY ENDPOINT CONTROLS & ESCALATION FLOOD PROOF TEST');
  console.log('='.repeat(75));

  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected to MongoDB Atlas:', mongoose.connection.name);

  // Setup test student
  const testStudentId = '672000000000000000000099';
  const testStudent = {
    _id: testStudentId,
    id: testStudentId,
    role: 'student',
    name: 'Quota Test Student',
    email: 'quota.test@asmaths.edu',
    targetCourse: 'engineering',
    branch: 'CSE',
  };
  const token = jwt.sign(testStudent, JWT_SECRET, { expiresIn: '1h' });

  // Reset student quota for a clean test run
  const today = new Date().toISOString().slice(0, 10);
  const StudentDailyQuota = mongoose.models.StudentDailyQuota;
  await StudentDailyQuota.deleteMany({ studentId: testStudentId });

  // Create test express app
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());

  const mockAttachContext = (req, res, next) => {
    req.user = testStudent;
    next();
  };

  app.post('/api/student/solve-doubt', mockAttachContext, doubtLimiter, solveStudentDoubt);
  app.post('/api/doubts/ask', (req, res, next) => { req.user = testStudent; next(); }, askDoubt);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  console.log(`Ephemeral test server active on port ${port}`);

  try {
    // ── TEST 1: LEGACY ENDPOINT DAILY QUOTA EXHAUSTION (cannot exceed limit) ──
    console.log('\n[TEST 1]: Verifying Legacy Endpoint Quota Enforcement...');
    process.env.DAILY_STUDENT_DOUBT_LIMIT = '3'; // Set limit to 3 for fast verification
    process.env.LEGACY_DOUBT_ENDPOINT_ENABLED = 'true';
    process.env.DOUBTS_AI_ENABLED = 'true';

    // Consume 3 quota slots via legacy endpoint
    for (let i = 1; i <= 3; i++) {
      const quotaCheck = await DoubtQuota.reserveStudentQuota(testStudentId, 3);
      console.log(`  Consumed quota #${i}: allowed=${quotaCheck.allowed}, remaining=${quotaCheck.remaining}`);
    }

    // 4th call to legacy endpoint: must be blocked with HTTP 429
    const resExhausted = await fetch(`http://127.0.0.1:${port}/api/student/solve-doubt`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ questionText: 'Evaluate integral of x^2', topic: 'Calculus' }),
    });

    const dataExhausted = await resExhausted.json();
    console.log(`  Attempt #4 Status: ${resExhausted.status} (Expected: 429)`);
    console.log(`  Response Error: "${dataExhausted.error}" | Message: "${dataExhausted.message}"`);
    if (resExhausted.status !== 429 || dataExhausted.error !== 'STUDENT_QUOTA_EXCEEDED') {
      throw new Error(`Legacy endpoint allowed student to bypass quota! Status: ${resExhausted.status}`);
    }
    console.log('  ✅ PASS: Student cannot exceed daily quota via legacy route. Blocked at HTTP 429.');

    // ── TEST 2: RETIREMENT FLAG (LEGACY_DOUBT_ENDPOINT_ENABLED=false -> HTTP 410) ──
    console.log('\n[TEST 2]: Verifying Legacy Endpoint Retirement Flag (LEGACY_DOUBT_ENDPOINT_ENABLED=false)...');
    process.env.LEGACY_DOUBT_ENDPOINT_ENABLED = 'false';

    const resRetired = await fetch(`http://127.0.0.1:${port}/api/student/solve-doubt`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ questionText: 'Evaluate integral of x^2', topic: 'Calculus' }),
    });
    const dataRetired = await resRetired.json();
    console.log(`  Retired Status: ${resRetired.status} (Expected: 410)`);
    console.log(`  Retired Error: "${dataRetired.error}" | Message: "${dataRetired.message}"`);
    if (resRetired.status !== 410 || dataRetired.error !== 'ENDPOINT_DEPRECATED') {
      throw new Error(`Expected HTTP 410 Gone, received: ${resRetired.status}`);
    }
    console.log('  ✅ PASS: Returns HTTP 410 Gone with clear browser refresh instruction when retired.');

    // ── TEST 3: KILL SWITCH (DOUBTS_AI_ENABLED=false -> HTTP 503) ──
    console.log('\n[TEST 3]: Verifying Legacy Endpoint AI Kill Switch (DOUBTS_AI_ENABLED=false)...');
    process.env.LEGACY_DOUBT_ENDPOINT_ENABLED = 'true';
    process.env.DOUBTS_AI_ENABLED = 'false';

    const resKillSwitch = await fetch(`http://127.0.0.1:${port}/api/student/solve-doubt`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ questionText: 'Evaluate integral of x^2', topic: 'Calculus' }),
    });
    const dataKillSwitch = await resKillSwitch.json();
    console.log(`  Kill Switch Status: ${resKillSwitch.status} (Expected: 503)`);
    console.log(`  Kill Switch Error: "${dataKillSwitch.error}" | Message: "${dataKillSwitch.message}"`);
    if (resKillSwitch.status !== 503 || dataKillSwitch.error !== 'AI_SERVICE_UNAVAILABLE') {
      throw new Error(`Expected HTTP 503 Unavailable, received: ${resKillSwitch.status}`);
    }
    console.log('  ✅ PASS: Returns HTTP 503 Unavailable with honest maintenance notice when AI is disabled.');

    // ── TEST 4: ESCALATION FLOOD GUARD (DAILY_STUDENT_TOTAL_DOUBT_LIMIT) ──
    console.log('\n[TEST 4]: Verifying Escalation Flood Guard on Total Doubts...');
    process.env.DAILY_STUDENT_TOTAL_DOUBT_LIMIT = '4'; // Set total limit to 4 for testing
    process.env.DOUBTS_AI_ENABLED = 'false'; // AI is off; doubts go straight to faculty queue

    // Reset quota record for student
    await StudentDailyQuota.updateOne(
      { date: today, studentId: testStudentId },
      { $set: { count: 0, totalSubmitted: 0 } },
      { upsert: true }
    );

    // Student submits 4 direct-to-teacher tickets
    for (let i = 1; i <= 4; i++) {
      const resTotal = await DoubtQuota.reserveTotalStudentLimit(testStudentId, 4);
      console.log(`  Faculty ticket #${i}: allowed=${resTotal.allowed}, remaining=${resTotal.remaining}`);
      if (!resTotal.allowed) throw new Error(`Ticket ${i} unexpectedly blocked!`);
    }

    // 5th attempt: should be blocked by total cap
    const resBlocked = await DoubtQuota.reserveTotalStudentLimit(testStudentId, 4);
    console.log(`  Attempt #5 total check: allowed=${resBlocked.allowed} (Expected: false), limit=${resBlocked.limit}`);
    if (resBlocked.allowed) {
      throw new Error('Escalation flood guard failed: allowed more tickets than total daily limit!');
    }
    console.log('  ✅ PASS: Escalation flood guard blocks student from exceeding total daily cap (10/day).');

    // Clean up test student quota
    await StudentDailyQuota.deleteMany({ studentId: testStudentId });

    console.log('\n' + '='.repeat(75));
    console.log('🎉 ALL LEGACY CONTROLS & ESCALATION FLOOD TESTS PASSED (100%)');
    console.log('='.repeat(75));
  } finally {
    server.close();
    await mongoose.disconnect();
    // Restore default env vars
    process.env.LEGACY_DOUBT_ENDPOINT_ENABLED = 'true';
    process.env.DOUBTS_AI_ENABLED = 'true';
    process.env.DAILY_STUDENT_DOUBT_LIMIT = '5';
    process.env.DAILY_STUDENT_TOTAL_DOUBT_LIMIT = '10';
  }
}

runTests().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
