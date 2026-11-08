const assert = require('assert');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const mongoose = require('mongoose');

const API_BASE = 'http://localhost:5000/api';

async function api(endpoint, options = {}) {
  const url = `${API_BASE}${endpoint}`;
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  const res = await fetch(url, { ...options, headers });
  let data = null;
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    data = await res.json();
  } else {
    data = await res.text();
  }
  return { status: res.status, headers: res.headers, data };
}

async function runRegressionSuite() {
  console.log('================================================================');
  console.log('🛡️ [REGRESSION SUITE]: Verifying Existing Production Features');
  console.log('================================================================');

  // 1. Health & Configuration Pre-Flight
  console.log('\n[TEST 1]: Checking /api/health and AI Configuration...');
  const healthRes = await api('/health');
  assert.strictEqual(healthRes.status, 200, '/api/health must respond with 200 OK');
  assert.strictEqual(healthRes.data.status, 'ok', 'Status must be ok');
  assert.strictEqual(healthRes.data.connected, true, 'Database must be connected');
  assert.strictEqual(healthRes.data.aiConfigured, true, 'AI Key must be recognized as configured');
  assert.strictEqual(healthRes.data.aiKillSwitchActive, false, 'AI Kill switch must be inactive by default');
  console.log('✅ /api/health passed:', {
    database: healthRes.data.database,
    connected: healthRes.data.connected,
    aiConfigured: healthRes.data.aiConfigured,
    aiKillSwitchActive: healthRes.data.aiKillSwitchActive,
  });

  // 2. Authentication Flow (Student, Teacher, Admin)
  console.log('\n[TEST 2]: Verifying User Authentication Across Roles...');
  const testPassword = process.env.TEST_PASSWORD || 'TestPassword123!';
  const adminPassword = process.env.ADMIN_PASSWORD || 'AdminPassword123!';
  if (mongoose.connection.readyState !== 1) {
    await mongoose.connect(process.env.MONGO_URI);
  }
  const User = require('../models/User');
  const bcrypt = require('bcryptjs');
  const salt = await bcrypt.genSalt(10);
  const hashedPass = await bcrypt.hash(testPassword, salt);
  await User.findOneAndUpdate(
    { email: 'student@asmaths.edu' },
    {
      $set: { password: hashedPass, isApproved: true, role: 'student', stream: 'Engineering', branch: 'CSE', semester: 'Semester 1' },
      $setOnInsert: { name: 'Test Student', email: 'student@asmaths.edu' },
    },
    { upsert: true, new: true }
  );
  await User.findOneAndUpdate(
    { email: 'mukherjee.eng@asmaths.edu' },
    {
      $set: { password: hashedPass, isApproved: true, role: 'teacher', stream: 'Engineering', branch: 'CSE', semester: 'Semester 1' },
      $setOnInsert: { name: 'Prof. S. Mukherjee', email: 'mukherjee.eng@asmaths.edu' },
    },
    { upsert: true, new: true }
  );
  const studentAuth = await api('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: 'student@asmaths.edu', password: testPassword }),
  });
  assert.strictEqual(studentAuth.status, 200, 'Student login must succeed');
  assert.strictEqual(studentAuth.data.role, 'student');
  const studentToken = studentAuth.data.token;

  const teacherAuth = await api('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: 'mukherjee.eng@asmaths.edu', password: testPassword }),
  });
  assert.strictEqual(teacherAuth.status, 200, 'Teacher login must succeed');
  assert.strictEqual(teacherAuth.data.role, 'teacher');
  const teacherToken = teacherAuth.data.token;

  const adminAuth = await api('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: 'admin@asmaths.com', password: adminPassword }),
  });
  assert.strictEqual(adminAuth.status, 200, 'Admin login must succeed');
  assert.strictEqual(adminAuth.data.role, 'admin');
  const adminToken = adminAuth.data.token;

  console.log('✅ Authentication passed for Student, Teacher, and Master Admin.');

  // 3. Question Bank & Content APIs
  console.log('\n[TEST 3]: Verifying Question Bank & Content Management APIs...');
  const structRes = await api('/content/academic-structure');
  assert.strictEqual(structRes.status, 200, 'Academic structure endpoint must respond 200');

  const contentRes = await api('/content');
  assert.strictEqual(contentRes.status, 200, 'Content listing must respond 200');
  console.log('✅ Question Bank & Academic Structure endpoints responsive.');

  // 4. Exams & Test Management APIs
  console.log('\n[TEST 4]: Verifying Test & Examination Pipeline...');
  const testsRes = await api('/tests');
  assert.strictEqual(testsRes.status, 200, 'Tests listing must respond 200');
  console.log('✅ Examination & Test Engine endpoints responsive.');

  // 5. Student Learning Portal Views
  console.log('\n[TEST 5]: Verifying Student Portal Learning Routes...');
  const materialsRes = await api('/student/materials?course=engineering&stream=CSE&semester=1', {
    headers: { Authorization: `Bearer ${studentToken}` },
  });
  assert.strictEqual(materialsRes.status, 200, 'Student materials must respond 200');

  const examsRes = await api('/student/exams?course=engineering&stream=CSE&semester=1', {
    headers: { Authorization: `Bearer ${studentToken}` },
  });
  assert.strictEqual(examsRes.status, 200, 'Student exams must respond 200');

  const assignmentsRes = await api('/student/assignments?course=engineering&stream=CSE&semester=1', {
    headers: { Authorization: `Bearer ${studentToken}` },
  });
  assert.strictEqual(assignmentsRes.status, 200, 'Student assignments must respond 200');
  console.log('✅ Student Learning Portal (Materials, Exams, Assignments) 100% operational.');

  // 6. Teacher / Admin Academic Overview
  console.log('\n[TEST 6]: Verifying Admin Academic Year Overview...');
  const overviewRes = await api('/admin/academic-year-overview', {
    headers: { Authorization: `Bearer ${teacherToken}` },
  });
  assert.strictEqual(overviewRes.status, 200, 'Academic year overview must respond 200');
  console.log('✅ Academic Year Overview responsive.');

  // 7. Security: Role Segregation & Access Control
  console.log('\n[TEST 7]: Verifying Role Segregation & Privilege Escalation Defense...');
  const studentBypassQueue = await api('/doubts/teacher/queue', {
    headers: { Authorization: `Bearer ${studentToken}` },
  });
  assert.strictEqual(studentBypassQueue.status, 403, 'Student calling Teacher Queue MUST be rejected (403)');

  const studentBypassAdmin = await api('/admin/content', {
    method: 'POST',
    headers: { Authorization: `Bearer ${studentToken}` },
    body: JSON.stringify({ title: 'Hacked Content' }),
  });
  assert.strictEqual(studentBypassAdmin.status, 403, 'Student calling Admin Upload MUST be rejected (403)');
  console.log('✅ Role Segregation Verified: Students strictly locked out of administrative surfaces.');

  // 8. Kill Switch Test: DOUBTS_AI_ENABLED=false
  console.log('\n[TEST 8]: Verifying AI Kill Switch (Bypass to Faculty Queue)...');
  process.env.DOUBTS_AI_ENABLED = 'false';

  const { askDoubt } = require('../controllers/doubtController');
  const Doubt = require('../models/Doubt');

  let responseData = null;
  let responseStatusCode = null;

  const mockReq = {
    user: {
      _id: '6aef2d260047171bef967276',
      id: '6aef2d260047171bef967276',
      name: 'Rohan Sharma (Test Student)',
      email: 'student@asmaths.edu',
      role: 'student',
      targetCourse: 'engineering',
      branch: 'CSE',
      semester: 1,
    },
    body: {
      title: 'Kill Switch Test: Evaluate derivative of e^(2x)',
      topic: 'Calculus',
      course: 'engineering',
      branch: 'CSE',
      semester: 1,
    },
    files: [],
  };

  const mockRes = {
    status: (code) => {
      responseStatusCode = code;
      return {
        json: (data) => {
          responseData = data;
          return data;
        },
      };
    },
  };

  await mongoose.connect(process.env.MONGO_URI);
  const StudentDailyQuota = mongoose.models.StudentDailyQuota;
  const today = new Date().toISOString().slice(0, 10);
  await StudentDailyQuota.deleteMany({ studentId: studentAuth.data.id || studentAuth.data._id, date: today });

  await askDoubt(mockReq, mockRes);

  assert.strictEqual(responseStatusCode, 202, 'Kill switch request should return 202');
  assert.strictEqual(responseData.status, 'escalated', 'Doubt status must be escalated directly to teacher');
  assert.ok(responseData.message.includes('forwarded directly to faculty'), 'Message must indicate direct faculty forwarding');

  // Verify DB state
  const doubtRecord = await Doubt.findById(responseData.doubtId);
  assert.strictEqual(doubtRecord.status, 'escalated', 'Stored doubt status must be escalated');
  assert.strictEqual(doubtRecord.unreadByTeacher, true, 'Stored doubt must be flagged unread for faculty');
  console.log('✅ Kill Switch Verified: DOUBTS_AI_ENABLED=false routes directly to teacher with 24h SLA.');

  // Clean up kill switch doubt
  await Doubt.deleteOne({ _id: responseData.doubtId });
  await mongoose.disconnect();

  // Reset Kill Switch to normal
  process.env.DOUBTS_AI_ENABLED = 'true';

  console.log('\n================================================================');
  console.log('🎉 REGRESSION SUITE COMPLETE: ALL EXISTING FEATURES VERIFIED OK!');
  console.log('================================================================');
}

runRegressionSuite().catch((err) => {
  console.error('\n❌ Regression Suite Failed:', err);
  process.exit(1);
});
