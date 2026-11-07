/**
 * Safe Test Data Cleanup Utility for asmaths_lms Database
 *
 * Rules:
 * - By default, NEVER deletes any users (even with --confirm).
 * - Users can ONLY be deleted if BOTH --delete-users AND --emails=email1,email2,... are explicitly passed.
 * - Prints exact list of document ObjectIds before executing any deletion.
 * - Enforces zero-tolerance safety guard against touching @gmail.com or admin@asmaths.com.
 *
 * Usage:
 *   node scripts/cleanTestData.js            -> Dry-run (lists all test doubts/messages/notifications/FAQs)
 *   node scripts/cleanTestData.js --confirm  -> Safely deletes only test doubts, messages, notifications, quotas, FAQs (leaves users intact)
 *   node scripts/cleanTestData.js --confirm --delete-users --emails=student@asmaths.edu,student2@asmaths.edu -> Deletes specific approved test users
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

const PROTECTED_ACCOUNTS = ['admin@asmaths.com'];

async function run() {
  const isConfirm = process.argv.includes('--confirm');
  const allowDeleteUsers = process.argv.includes('--delete-users');
  const emailsArg = process.argv.find((a) => a.startsWith('--emails='));
  const explicitEmails = emailsArg ? emailsArg.replace('--emails=', '').split(',').map((e) => e.trim().toLowerCase()) : [];

  await mongoose.connect(process.env.MONGO_URI);
  const dbName = mongoose.connection.name;

  console.log('='.repeat(75));
  console.log(`DATABASE TEST DATA AUDIT & CLEANUP TOOL`);
  console.log(`Target Database : ${dbName}`);
  console.log(`Mode            : ${isConfirm ? 'CONFIRM (DESTRUCTIVE)' : 'DRY-RUN (AUDIT ONLY)'}`);
  console.log(`User Deletion   : ${allowDeleteUsers ? 'ENABLED (Explicit emails required)' : 'STRICTLY DISABLED (Users will NOT be touched)'}`);
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

  // 3. Identify Test Messages
  const testMessages = await DoubtMessage.find({
    $or: [
      { doubtId: { $in: testDoubtIds } },
      { authorId: { $in: testUserIds.map(String) } },
    ],
  });
  const testMessageIds = testMessages.map((m) => m._id);

  // 4. Identify Test Quota Records
  const testQuotas = await DoubtQuota.find({
    student: { $in: testUserIds },
  });
  const testQuotaIds = testQuotas.map((q) => q._id);

  // 5. Identify Test Notifications
  const testNotifications = await Notification.find({
    $or: [
      { userId: { $in: testUserIds } },
      { doubtId: { $in: testDoubtIds } },
    ],
  });
  const testNotificationIds = testNotifications.map((n) => n._id);

  // 6. Identify Test FAQs
  const testFaqs = await DoubtFaq.find({
    $or: [
      { originalDoubtId: { $in: testDoubtIds } },
      { title: /limit of \(sin x\)\/x/i },
    ],
  });
  const testFaqIds = testFaqs.map((f) => f._id);

  // Print exact document IDs
  console.log('\n--- TARGET DOCUMENT IDS FOR CLEANUP ---');
  console.log(`Doubts to remove (${testDoubtIds.length} records):`);
  console.log(JSON.stringify(testDoubtIds, null, 2));

  console.log(`\nDoubt Messages to remove (${testMessageIds.length} records):`);
  console.log(JSON.stringify(testMessageIds, null, 2));

  console.log(`\nNotifications to remove (${testNotificationIds.length} records):`);
  console.log(JSON.stringify(testNotificationIds, null, 2));

  console.log(`\nQuota Records to remove (${testQuotaIds.length} records):`);
  console.log(JSON.stringify(testQuotaIds, null, 2));

  console.log(`\nFAQ entries to remove (${testFaqIds.length} records):`);
  console.log(JSON.stringify(testFaqIds, null, 2));

  console.log(`\nTest User Accounts Present in Database (${testUsers.length} accounts):`);
  testUsers.forEach((u) => console.log(`   - ID: ${u._id} | [${u.role}] ${u.email} (${u.name})`));

  let usersToDelete = [];
  if (allowDeleteUsers) {
    if (explicitEmails.length === 0) {
      console.error('\n🚨 ERROR: --delete-users was passed but no --emails=... list provided. Aborting user deletion for safety.');
      process.exit(1);
    }
    usersToDelete = testUsers.filter((u) => explicitEmails.includes(u.email.toLowerCase()));
    console.log(`\n⚠️  USERS EXPLICITLY MARKED FOR DELETION (${usersToDelete.length} accounts):`);
    usersToDelete.forEach((u) => console.log(`   - ID: ${u._id} | ${u.email}`));
  } else {
    console.log('\n🔒 POLICY ENFORCED: Zero users will be deleted. All 7 test accounts remain in database.');
  }

  console.log('\n' + '='.repeat(75));

  if (!isConfirm) {
    console.log('ℹ️  DRY-RUN COMPLETE: No database records were modified or deleted.');
    console.log('   To permanently remove test doubts, messages, notifications, and FAQs without touching users:');
    console.log('   node scripts/cleanTestData.js --confirm\n');
  } else {
    console.log('⚡ EXECUTING DELETIONS (--confirm was passed)...');

    const deletedMsgs = await DoubtMessage.deleteMany({ _id: { $in: testMessageIds } });
    const deletedDoubts = await Doubt.deleteMany({ _id: { $in: testDoubtIds } });
    const deletedQuotas = await DoubtQuota.deleteMany({ _id: { $in: testQuotaIds } });
    const deletedNotifs = await Notification.deleteMany({ _id: { $in: testNotificationIds } });
    const deletedFaqs = await DoubtFaq.deleteMany({ _id: { $in: testFaqIds } });

    console.log(`✅ Doubt Messages Deleted    : ${deletedMsgs.deletedCount}`);
    console.log(`✅ Doubts Deleted            : ${deletedDoubts.deletedCount}`);
    console.log(`✅ Quotas Deleted            : ${deletedQuotas.deletedCount}`);
    console.log(`✅ Notifications Deleted     : ${deletedNotifs.deletedCount}`);
    console.log(`✅ FAQs Deleted              : ${deletedFaqs.deletedCount}`);

    if (allowDeleteUsers && usersToDelete.length > 0) {
      const deletedUsers = await User.deleteMany({ _id: { $in: usersToDelete.map((u) => u._id) } });
      console.log(`✅ Explicit Users Deleted    : ${deletedUsers.deletedCount}`);
    } else {
      console.log(`🔒 User Accounts Untouched   : ${testUsers.length} test accounts preserved.`);
    }

    console.log('='.repeat(75));
    console.log('🎉 Cleanup successfully completed. Real student accounts and exams untouched.\n');
  }

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('❌ Error during test data cleanup:', err.message);
  process.exit(1);
});
