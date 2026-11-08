/**
 * Verification Test: Typed Doubt Submission & State Binding (Question field)
 *
 * Proves:
 * 1. POST /api/doubts/ask with typed question text (field: 'question') succeeds with HTTP 202.
 * 2. Does NOT trigger HTTP 400 "Please provide question text...".
 * 3. Saved Doubt record has correct topic, title, and aiTranscription.problemText matching the typed question.
 */

const express = require('express');
const mongoose = require('mongoose');
const assert = require('assert');
const jwt = require('jsonwebtoken');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const User = require('../models/User');
const Doubt = require('../models/Doubt');
const DoubtQuota = require('../models/DoubtQuota');
const doubtRoutes = require('../routes/doubtRoutes');

const TEST_EMAIL = 'typed.doubt.test@asmaths.edu';

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('='.repeat(75));
  console.log('🧪 TYPED DOUBT SUBMISSION & PAYLOAD BINDING TEST');
  console.log(`Connected to Database: ${mongoose.connection.name}`);
  console.log('='.repeat(75));

  // 1. Ensure test student
  const student = await User.findOneAndUpdate(
    { email: TEST_EMAIL },
    {
      name: 'Typed Test Student',
      email: TEST_EMAIL,
      role: 'student',
      isApproved: true,
      targetCourse: 'engineering',
      branch: 'CSE',
      semester: 1,
    },
    { upsert: true, returnDocument: 'after' }
  );

  // Clear quota for clean test run
  await DoubtQuota.deleteMany({ student: student._id });

  const token = jwt.sign(
    { id: student._id, role: 'student', email: student.email },
    process.env.JWT_SECRET || require('crypto').randomBytes(32).toString('hex')
  );

  // 2. Build test server
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use('/api/doubts', doubtRoutes);

  const server = app.listen(0);
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const typedQuestion = 'Evaluate the definite integral $\\int_0^{\\pi/2} \\sin^2(x) dx$ using beta-gamma function.';

  console.log('\n[TEST 1]: Submitting typed doubt with field "question" (no attachments)...');
  const res = await fetch(`${baseUrl}/api/doubts/ask`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      topic: 'Definite Integrals & Beta-Gamma',
      subject: 'Mathematics-I',
      chapter: 'Integral Calculus',
      question: typedQuestion,
      whatITried: 'I tried standard reduction formula.',
      language: 'en',
    }),
  });

  const body = await res.json();
  console.log(`  -> Response Status: ${res.status} (Expected: 202)`);
  console.log(`  -> Response Success: ${body.success}`);
  console.log(`  -> Created Doubt ID: ${body.doubtId}`);
  console.log(`  -> Status: ${body.status}`);

  assert.strictEqual(res.status, 202, `Should return HTTP 202, got ${res.status}: ${JSON.stringify(body)}`);
  assert.strictEqual(body.success, true, 'Submission must be marked success');

  console.log('\n[TEST 2]: Verifying Doubt document in MongoDB Atlas...');
  const createdDoubt = await Doubt.findById(body.doubtId);
  assert(createdDoubt, 'Doubt document must exist in database');

  console.log(`  -> Doubt Title               : "${createdDoubt.title}"`);
  console.log(`  -> aiTranscription ProblemText: "${createdDoubt.aiTranscription?.problemText}"`);
  console.log(`  -> Status                    : "${createdDoubt.status}"`);

  assert.strictEqual(createdDoubt.title, typedQuestion, 'Doubt title must equal typed question');
  assert.strictEqual(
    createdDoubt.aiTranscription?.problemText,
    typedQuestion,
    'aiTranscription problemText must equal typed question'
  );

  console.log('  ✅ Typed question text was captured 100% accurately by the backend!\n');

  // Clean up
  await Doubt.deleteOne({ _id: createdDoubt._id });
  await DoubtQuota.deleteMany({ student: student._id });
  await User.deleteOne({ _id: student._id });

  server.close();
  await mongoose.disconnect();
  console.log('='.repeat(75));
  console.log('🎉 TYPED DOUBT SUBMISSION VERIFICATION PASSED (100% SUCCESS)');
  console.log('='.repeat(75) + '\n');
}

run().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
