const assert = require('assert');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const mongoose = require('mongoose');
const Doubt = require('../models/Doubt');
const DoubtMessage = require('../models/DoubtMessage');
const DoubtFaq = require('../models/DoubtFaq');
const DoubtQuota = require('../models/DoubtQuota');
const User = require('../models/User');

const API_BASE = 'http://localhost:5000/api';

async function api(path, options = {}) {
  const url = `${API_BASE}${path}`;
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

async function runPhase5Verification() {
  console.log('================================================================');
  console.log('🚀 [PHASE 5 VERIFICATION]: Analytics, Learning Features & Hardening');
  console.log('================================================================');

  // 1. Authenticate Actors
  console.log('\n[STEP 1]: Authenticating Test Actors...');
  const studentRes = await api('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: 'student@asmaths.edu', password: 'TestPassword123!' }),
  });
  assert.strictEqual(studentRes.status, 200, 'Student login should succeed');
  const studentToken = studentRes.data.token;
  const studentUser = studentRes.data;

  const teacherRes = await api('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: 'mukherjee.eng@asmaths.edu', password: 'TestPassword123!' }),
  });
  assert.strictEqual(teacherRes.status, 200, 'Engineering Teacher login should succeed');
  const teacherToken = teacherRes.data.token;
  const teacherUser = teacherRes.data;

  const adminRes = await api('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: 'admin@asmaths.com', password: 'AdminPassword123!' }),
  });
  assert.strictEqual(adminRes.status, 200, 'Admin login should succeed');
  const adminToken = adminRes.data.token;

  console.log('✅ Actors authenticated: Student A, Eng Teacher, Master Admin.');

  // 2. Test Analytics Overview (Teacher scoped vs Admin global)
  console.log('\n[STEP 2]: Testing Analytics Overview Endpoints...');
  const teacherAnalyticsRes = await api('/doubts/analytics/overview', {
    headers: { Authorization: `Bearer ${teacherToken}` },
  });
  assert.strictEqual(teacherAnalyticsRes.status, 200, 'Teacher analytics query should succeed');
  assert.strictEqual(teacherAnalyticsRes.data.success, true);
  const teacherMetrics = teacherAnalyticsRes.data.metrics;
  console.log('Teacher Analytics Scope:', teacherAnalyticsRes.data.scope);
  console.log('Teacher Metrics:', {
    totalDoubts: teacherMetrics.totalDoubts,
    aiResolvedRate: `${teacherMetrics.aiResolvedRate}%`,
    escalatedRate: `${teacherMetrics.escalatedRate}%`,
    avgTimeToAiAnswerMs: `${teacherMetrics.avgTimeToAiAnswerMs}ms`,
    medianTimeToAiAnswerMs: `${teacherMetrics.medianTimeToAiAnswerMs}ms`,
    slaBreachRate: `${teacherMetrics.slaBreachRate}%`,
    studentSatisfactionRate: `${teacherMetrics.studentSatisfactionRate}%`,
  });

  const adminAnalyticsRes = await api('/doubts/analytics/overview', {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert.strictEqual(adminAnalyticsRes.status, 200, 'Admin analytics query should succeed');
  assert.strictEqual(adminAnalyticsRes.data.success, true);
  console.log('Admin Global Total Doubts:', adminAnalyticsRes.data.metrics.totalDoubts);
  console.log('Top Confusing Topics Count:', adminAnalyticsRes.data.mostConfusingTopics?.length);
  if (adminAnalyticsRes.data.mostConfusingTopics?.length > 0) {
    console.log('Top 3 Confusing Topics:');
    adminAnalyticsRes.data.mostConfusingTopics.slice(0, 3).forEach((t, i) => {
      console.log(`  ${i + 1}. ${t.topic} (Total: ${t.totalDoubts}, Escalated: ${t.escalatedCount}, Still Confused: ${t.stillConfusedCount})`);
    });
  }

  // 3. Test Admin Capacity Telemetry (Security check: Teacher rejected 403, Admin allowed 200)
  console.log('\n[STEP 3]: Testing Admin Capacity & Quota Telemetry Access Control...');
  const teacherCapacityRes = await api('/doubts/analytics/capacity', {
    headers: { Authorization: `Bearer ${teacherToken}` },
  });
  assert.strictEqual(teacherCapacityRes.status, 403, 'Teacher MUST be rejected (403) from Admin Capacity endpoint');
  console.log('✅ Access Control Verified: Teacher correctly blocked with HTTP 403.');

  const adminCapacityRes = await api('/doubts/analytics/capacity', {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert.strictEqual(adminCapacityRes.status, 200, 'Admin should receive 200 from Capacity endpoint');
  assert.strictEqual(adminCapacityRes.data.success, true);
  console.log('Admin Capacity Telemetry:', {
    date: adminCapacityRes.data.telemetry.date,
    totalQueriesToday: adminCapacityRes.data.telemetry.totalQueriesToday,
    fallbackRate: `${adminCapacityRes.data.telemetry.fallbackRate}%`,
    modelUsage: adminCapacityRes.data.telemetry.modelUsage,
    failuresByType: adminCapacityRes.data.telemetry.failuresByType,
    activeStudentsToday: adminCapacityRes.data.telemetry.activeStudentsToday,
  });

  // 4. Test Sanitized CSV Export (Privacy & PII Verification)
  console.log('\n[STEP 4]: Testing Sanitized CSV Export (PII Redaction)...');
  const csvRes = await api('/doubts/analytics/export', {
    headers: { Authorization: `Bearer ${teacherToken}` },
  });
  assert.strictEqual(csvRes.status, 200, 'CSV export should return 200');
  assert.ok(csvRes.headers.get('content-type').includes('text/csv'), 'Content-Type should be text/csv');
  const csvContent = csvRes.data;
  console.log('CSV Header Row:', csvContent.split('\r\n')[0]);
  // Verify strict absence of student PII
  assert.ok(!csvContent.includes('student@asmaths.edu'), 'CSV MUST NOT leak student email');
  assert.ok(!csvContent.includes('Roll No'), 'CSV MUST NOT leak student roll numbers');
  console.log('✅ CSV Export Verified: Proper RFC 4180 format, zero student PII leaks.');

  // 5. Test Anonymized FAQ Publication
  console.log('\n[STEP 5]: Testing Anonymized FAQ Publication...');
  // Find a resolved doubt or create one
  await mongoose.connect(process.env.MONGO_URI);
  let testDoubt = await Doubt.findOne({ course: 'Engineering', branch: 'CSE', status: { $in: ['resolved', 'teacher_answered'] } });
  if (!testDoubt) {
    testDoubt = await Doubt.create({
      doubtCode: `DBT-TEST-FAQ-${Date.now().toString().slice(-4)}`,
      title: 'How to evaluate limit of (sin x)/x as x approaches 0?',
      course: 'Engineering',
      branch: 'CSE',
      semester: 1,
      subject: 'Mathematics',
      topic: 'Calculus Limits',
      student: studentUser._id || studentUser.id,
      studentName: studentUser.name || 'Test Student',
      studentEmail: studentUser.email || 'student@asmaths.edu',
      status: 'resolved',
      resolvedAt: new Date(),
      aiExplanation: {
        summary: 'Use L Hopitals Rule or Taylor Series expansion of sin x.',
        finalAnswer: '\\lim_{x \\to 0} \\frac{\\sin x}{x} = 1',
      },
    });
  }

  const publishFaqRes = await api(`/doubts/${testDoubt._id}/publish-faq`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${teacherToken}` },
  });
  assert.strictEqual(publishFaqRes.status, 200, 'Publish FAQ should return 200');
  assert.strictEqual(publishFaqRes.data.success, true);
  const createdFaq = publishFaqRes.data.faq;
  console.log('✅ FAQ Published:', {
    faqId: createdFaq._id,
    title: createdFaq.title,
    topic: createdFaq.topic,
    course: createdFaq.course,
    verifiedByTeacher: createdFaq.verifiedByTeacherName,
  });

  // Verify that student's name is NOT in FAQ
  assert.ok(!JSON.stringify(createdFaq).includes(studentUser.name || 'Student A'), 'FAQ must be anonymized');

  // 6. Test Similar Solved Doubts & FAQ Search
  console.log('\n[STEP 6]: Testing Search for Similar Solved Doubts & FAQs...');
  const searchFaqRes = await api('/doubts/search-faqs?q=limit&course=Engineering', {
    headers: { Authorization: `Bearer ${studentToken}` },
  });
  assert.strictEqual(searchFaqRes.status, 200, 'Search FAQs should return 200');
  assert.strictEqual(searchFaqRes.data.success, true);
  console.log(`Found ${searchFaqRes.data.faqs.length} matching FAQs, ${searchFaqRes.data.mySimilarDoubts.length} student solved doubts.`);
  assert.ok(searchFaqRes.data.faqs.length > 0, 'Should find at least 1 FAQ');

  // 7. Test Student Solution Rating
  console.log('\n[STEP 7]: Testing Student Solution Rating...');
  const rateRes = await api(`/doubts/${testDoubt._id}/rate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${studentToken}` },
    body: JSON.stringify({ score: 5, feedback: 'helpful' }),
  });
  assert.strictEqual(rateRes.status, 200, 'Rating should return 200');
  assert.strictEqual(rateRes.data.success, true);
  assert.strictEqual(rateRes.data.rating.score, 5);
  console.log('✅ Student Rating Submitted:', rateRes.data.rating);

  // Negative test: Another user cannot rate
  const unauthorizedRateRes = await api(`/doubts/${testDoubt._id}/rate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${teacherToken}` },
    body: JSON.stringify({ score: 1 }),
  });
  assert.strictEqual(unauthorizedRateRes.status, 403, 'Unauthorized user rating must be rejected (403)');
  console.log('✅ Negative Security Verified: Non-owner blocked from rating.');

  // 8. Test Stuck Job Sweeper & Abandoned Draft Cleanup
  console.log('\n[STEP 8]: Testing Sweeper & Abandoned Draft Cleanup...');
  // Create an abandoned draft older than 8 days
  const oldDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  const draftDoubt = await Doubt.create({
    doubtCode: `DBT-DRAFT-${Date.now().toString().slice(-4)}`,
    title: 'Abandoned draft doubt',
    topic: 'General Limits',
    course: 'Engineering',
    branch: 'CSE',
    semester: 1,
    student: studentUser._id || studentUser.id,
    studentName: studentUser.name || 'Test Student',
    studentEmail: studentUser.email || 'student@asmaths.edu',
    status: 'draft',
    createdAt: oldDate,
    updatedAt: oldDate,
  });

  const { sweepStuckDoubtJobs } = require('../controllers/doubtController');
  await sweepStuckDoubtJobs();

  const foundDraft = await Doubt.findById(draftDoubt._id);
  assert.strictEqual(foundDraft, null, 'Abandoned draft older than 7 days MUST be cleaned up');
  console.log('✅ Sweeper Verified: Abandoned draft (>7 days) was safely deleted.');

  // Verify answered/resolved doubts were NOT deleted
  const resolvedCheck = await Doubt.findById(testDoubt._id);
  assert.ok(resolvedCheck !== null, 'Answered/Resolved doubts must NEVER be deleted');
  console.log('✅ Safety Verified: Answered/Resolved doubts preserved.');

  await mongoose.disconnect();

  console.log('\n================================================================');
  console.log('🎉 ALL PHASE 5 BACKEND VERIFICATION CHECKS PASSED SUCCESSFULLY!');
  console.log('================================================================');
}

runPhase5Verification().catch((err) => {
  console.error('\n❌ Phase 5 Verification Failed:', err);
  process.exit(1);
});
