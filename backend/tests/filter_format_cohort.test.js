const assert = require('assert');
const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const { assertDevOrTestDatabase } = require('../utils/dbGuard');
const ClassTest = require('../models/ClassTest');
const testsScheduleController = require('../controllers/testsScheduleController');

function createMockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

async function runFilterFormatTests() {
  console.log('🧪 Starting Filter Format & Flexible Cohort Resolution Tests...\n');

  const rawUri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/asmaths_lms_dev';
  const devUri = rawUri.replace(/\/asmaths_lms(\?|$)/, '/asmaths_lms_dev$1');

  if (mongoose.connection.readyState !== 1) {
    await mongoose.connect(devUri);
  }
  assertDevOrTestDatabase(mongoose.connection.db.databaseName);
  console.log(`✅ DB Safety Guard passed: Operating on ${mongoose.connection.db.databaseName}\n`);

  const now = new Date();
  const testTitles = [
    'Test Sem String Semester 1',
    'Test Sem Number 1',
    'Test Sem Digit String 1',
    'Test Common Engineering Foundation',
    'Test Common All Branches Foundation',
  ];

  await ClassTest.deleteMany({ title: { $in: testTitles } });

  // 1. Semester as String "Semester 1"
  const t1 = await ClassTest.create({
    title: 'Test Sem String Semester 1',
    course: 'Engineering',
    branch: 'CSE',
    semester: 'Semester 1',
    startAt: new Date(now.getTime() + 3600000),
    durationMinutes: 60,
    status: 'upcoming',
    isDraft: false,
    published: true,
  });

  // 2. Semester as Number 1
  const t2 = await ClassTest.create({
    title: 'Test Sem Number 1',
    course: 'Engineering',
    branch: 'CSE',
    semester: 1,
    startAt: new Date(now.getTime() + 7200000),
    durationMinutes: 60,
    status: 'upcoming',
    isDraft: false,
    published: true,
  });

  // 3. Semester as String digit "1"
  const t3 = await ClassTest.create({
    title: 'Test Sem Digit String 1',
    course: 'Engineering',
    branch: 'CSE',
    semester: '1',
    startAt: new Date(now.getTime() + 10800000),
    durationMinutes: 60,
    status: 'upcoming',
    isDraft: false,
    published: true,
  });

  // 4. Test with isCommon: true (branch: 'Common')
  const t4 = await ClassTest.create({
    title: 'Test Common Engineering Foundation',
    course: 'Engineering',
    branch: 'Common',
    isCommon: true,
    semester: 'Semester 1',
    startAt: new Date(now.getTime() + 14400000),
    durationMinutes: 60,
    status: 'upcoming',
    isDraft: false,
    published: true,
  });

  // 5. Test with branch: 'All'
  const t5 = await ClassTest.create({
    title: 'Test Common All Branches Foundation',
    course: 'Engineering',
    branch: 'All',
    semester: 1,
    startAt: new Date(now.getTime() + 18000000),
    durationMinutes: 60,
    status: 'upcoming',
    isDraft: false,
    published: true,
  });

  console.log('✅ Created 5 fixture tests covering mixed semester types and isCommon/All branch.\n');

  const adminUser = { id: 'admin_filter_test', role: 'admin' };

  // Case A: Query with semester="Semester 1" and branch="CSE"
  console.log('▶ Case A: Query with semester="Semester 1" and branch="CSE"');
  const reqA = {
    user: adminUser,
    query: { course: 'Engineering', branch: 'CSE', semester: 'Semester 1' },
  };
  const resA = createMockRes();
  await testsScheduleController.getTestsList(reqA, resA);
  assert.strictEqual(resA.statusCode, 200);
  const titlesA = resA.body.data.map((t) => t.title);

  assert.ok(titlesA.includes('Test Sem String Semester 1'), 'Matches semester "Semester 1"');
  assert.ok(titlesA.includes('Test Sem Number 1'), 'Matches semester numeric 1 when querying "Semester 1"');
  assert.ok(titlesA.includes('Test Sem Digit String 1'), 'Matches semester string "1" when querying "Semester 1"');
  assert.ok(titlesA.includes('Test Common Engineering Foundation'), 'Matches isCommon: true across branch "CSE"');
  assert.ok(titlesA.includes('Test Common All Branches Foundation'), 'Matches branch: "All" across branch "CSE"');
  console.log('  ✔ All 5 tests matched flexibly for semester="Semester 1" and branch="CSE"!\n');

  // Case B: Query with semester="1" (digit string)
  console.log('▶ Case B: Query with semester="1" (digit string)');
  const reqB = {
    user: adminUser,
    query: { course: 'Engineering', branch: 'CSE', semester: '1' },
  };
  const resB = createMockRes();
  await testsScheduleController.getTestsList(reqB, resB);
  assert.strictEqual(resB.statusCode, 200);
  const titlesB = resB.body.data.map((t) => t.title);
  assert.ok(titlesB.includes('Test Sem String Semester 1'), 'Querying "1" matches "Semester 1"');
  assert.ok(titlesB.includes('Test Sem Number 1'), 'Querying "1" matches numeric 1');
  assert.ok(titlesB.includes('Test Sem Digit String 1'), 'Querying "1" matches string "1"');
  console.log('  ✔ Mixed semester representations match when querying semester="1"!\n');

  // Case C: Overview API uses same flexible filtering
  console.log('▶ Case C: Overview endpoint flex matching');
  const reqC = {
    user: adminUser,
    query: { course: 'Engineering', branch: 'CSE', semester: 'Semester 1' },
  };
  const resC = createMockRes();
  await testsScheduleController.getOverview(reqC, resC);
  assert.strictEqual(resC.statusCode, 200);
  assert.ok(resC.body.kpis.totalTests >= 5, 'Overview totalTests includes all flex-matched cohort tests');
  console.log(`  ✔ Overview KPI totalTests correctly resolved: ${resC.body.kpis.totalTests}\n`);

  // Teardown
  await ClassTest.deleteMany({ title: { $in: testTitles } });
  await mongoose.disconnect();
  console.log('════════════════════════════════════════════════════════════════');
  console.log('🎉 ALL FILTER FORMAT & COHORT FLEXIBILITY TESTS PASSED 100%!');
  console.log('════════════════════════════════════════════════════════════════\n');
}

runFilterFormatTests().catch((err) => {
  console.error('❌ Test failed:', err);
  mongoose.disconnect().finally(() => process.exit(1));
});
