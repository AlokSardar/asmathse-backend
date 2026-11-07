/**
 * Safe Test Data Cleanup Utility for asmaths_lms Database
 *
 * Usage:
 *   node cleanTestData.js            -> Dry-run mode (Default: lists all test records, deletes nothing)
 *   node cleanTestData.js --dry-run  -> Explicit dry-run mode
 *   node cleanTestData.js --confirm  -> Executes deletion with strict safety assertions
 */

const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const User = require('../models/User');
const Doubt = require('../models/Doubt');
const DoubtMessage = require('../models/DoubtMessage');
const DoubtQuota = require('../models/DoubtQuota');
const Notification = require('../models/Notification');
const DoubtFaq = require('../models/DoubtFaq');

// Strict whitelist of known test emails generated during development/tests
const KNOWN_TEST_EMAILS = [
  'student@asmaths.edu',
  'student2@asmaths.edu',
  'rohan.cse@asmaths.edu',
  'sneha.cse@asmaths.edu',
  'mukherjee.eng@asmaths.edu',
  'banerjee.bsc@asmaths.edu',
  'ghosh.eng@asmaths.edu',
  'smoke.student.2026@asmaths.edu',
  'smoke.teacher.2026@asmaths.edu',
];

// Production accounts that MUST NEVER be touched
const PROTECTED_ACCOUNTS = ['admin@asmaths.com'];

async function run() {
  const isConfirm = process.argv.includes('--confirm');
  const mode = isConfirm ? 'CONFIRM (DESTRUCTIVE)' : 'DRY-RUN (AUDIT ONLY)';

  await mongoose.connect(process.env.MONGO_URI);
  const dbName = mongoose.connection.name;

  console.log('='.repeat(75));
  console.log(`DATABASE TEST DATA AUDIT & CLEANUP TOOL`);
  console.log(`Target Database : ${dbName}`);
  console.log(`Execution Mode  : ${mode}`);
  console.log('='.repeat(75));

  // 1. Identify Test Users
  const testUsers = await User.find({ email: { $in: KNOWN_TEST_EMAILS } });
  const testUserIds = testUsers.map((u) => u._id);

  // Safety Assertion
  for (const u of testUsers) {
    if (PROTECTED_ACCOUNTS.includes(u.email) || u.email.endsWith('@gmail.com')) {
      console.error(`🚨 FATAL SAFETY VIOLATION: Protected account detected in test list: ${u.email}`);
      process.exit(1);
    }
  }

  // 2. Identify Test Doubts
  const testDoubts = await Doubt.find({
    $or: [
      { student: { $in: testUserIds } },
      { doubtCode: { $regex: /^(DBT-26-00|DBT-TEST-)/ } },
    ],
  });
  const testDoubtIds = testDoubts.map((d) => d._id);

  // 3. Identify Test Doubt Messages
  const testMessages = await DoubtMessage.find({
    $or: [
      { doubtId: { $in: testDoubtIds } },
      { authorId: { $in: testUserIds.map(String) } },
    ],
  });

  // 4. Identify Test Quota Records
  const testQuotas = await DoubtQuota.find({
    student: { $in: testUserIds },
  });

  // 5. Identify Test Notifications
  const testNotifications = await Notification.find({
    userId: { $in: testUserIds },
  });

  // 6. Identify Test FAQs (created from test doubts)
  const testFaqs = await DoubtFaq.find({
    $or: [
      { originalDoubtId: { $in: testDoubtIds } },
      { title: /limit of \(sin x\)\/x/i },
    ],
  });

  console.log('\n--- AUDIT FINDINGS ---');
  console.log(`1. Test Users Identified        : ${testUsers.length}`);
  testUsers.forEach((u) => console.log(`   - [${u.role}] ${u.email} (${u.name})`));

  console.log(`\n2. Test Doubts Identified       : ${testDoubts.length}`);
  testDoubts.forEach((d) => console.log(`   - ${d.doubtCode} | Status: ${d.status} | Title: "${d.title}"`));

  console.log(`\n3. Test Messages Identified     : ${testMessages.length}`);
  console.log(`4. Test Quota Records Identified: ${testQuotas.length}`);
  console.log(`5. Test Notifications Identified: ${testNotifications.length}`);
  console.log(`6. Test FAQs Identified         : ${testFaqs.length}`);
  testFaqs.forEach((f) => console.log(`   - FAQ: "${f.title}" (${f.subject})`));

  console.log('\n' + '='.repeat(75));

  if (!isConfirm) {
    console.log('ℹ️  DRY-RUN COMPLETE: No data was modified or deleted.');
    console.log('   To permanently remove these test records, rerun with:');
    console.log('   node scripts/cleanTestData.js --confirm\n');
  } else {
    console.log('⚡ EXECUTING DELETIONS (--confirm was passed)...');

    const deletedMsgs = await DoubtMessage.deleteMany({ _id: { $in: testMessages.map((m) => m._id) } });
    const deletedDoubts = await Doubt.deleteMany({ _id: { $in: testDoubtIds } });
    const deletedQuotas = await DoubtQuota.deleteMany({ _id: { $in: testQuotas.map((q) => q._id) } });
    const deletedNotifs = await Notification.deleteMany({ _id: { $in: testNotifications.map((n) => n._id) } });
    const deletedFaqs = await DoubtFaq.deleteMany({ _id: { $in: testFaqs.map((f) => f._id) } });
    const deletedUsers = await User.deleteMany({ _id: { $in: testUserIds } });

    console.log(`✅ Test Messages Deleted    : ${deletedMsgs.deletedCount}`);
    console.log(`✅ Test Doubts Deleted      : ${deletedDoubts.deletedCount}`);
    console.log(`✅ Test Quotas Deleted      : ${deletedQuotas.deletedCount}`);
    console.log(`✅ Test Notifications Deleted: ${deletedNotifs.deletedCount}`);
    console.log(`✅ Test FAQs Deleted        : ${deletedFaqs.deletedCount}`);
    console.log(`✅ Test Users Deleted       : ${deletedUsers.deletedCount}`);
    console.log('='.repeat(75));
    console.log('🎉 Cleanup successfully completed. Real student accounts and exams untouched.\n');
  }

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('❌ Error during test data cleanup:', err.message);
  process.exit(1);
});
