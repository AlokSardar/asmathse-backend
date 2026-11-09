/**
 * cleanupDuplicateDrafts.js
 * 
 * Safe CLI utility to identify and purge duplicate draft tests with zero attempts.
 * 
 * Safety Rules:
 * 1. Default is strictly DRY-RUN mode.
 * 2. Requires explicit --db=<dbname> argument.
 * 3. Aborts immediately if the active database does NOT contain "dev" or "test".
 * 4. Requires --confirm to perform actual database mutations.
 * 5. Never purges tests with existing student attempts or submissions.
 * 
 * Usage:
 *   # Dry run (safe, reports duplicates found)
 *   node backend/scripts/cleanupDuplicateDrafts.js --db=asmaths_lms_dev
 * 
 *   # Confirmed execution
 *   node backend/scripts/cleanupDuplicateDrafts.js --db=asmaths_lms_dev --confirm
 */

const mongoose = require('mongoose');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const { assertDevOrTestDatabase } = require('../utils/dbGuard');
const ClassTest = require('../models/ClassTest');
const Evaluation = require('../models/Evaluation');
const TestSubmission = require('../models/TestSubmission');
const AuditLog = require('../models/AuditLog');

// Parse CLI flags
function parseArgs() {
  const args = process.argv.slice(2);
  let dbName = null;
  let confirm = false;

  for (const arg of args) {
    if (arg.startsWith('--db=')) {
      dbName = arg.split('=')[1].trim();
    } else if (arg === '--confirm') {
      confirm = true;
    }
  }

  return { dbName, confirm };
}

async function countTestAttempts(test) {
  const testMatchIds = [String(test._id)];
  if (test.id) testMatchIds.push(String(test.id));
  if (test.testId) testMatchIds.push(String(test.testId));

  const [evalCount, subCount] = await Promise.all([
    Evaluation.countDocuments({
      $or: [
        { testId: { $in: testMatchIds } },
        { examId: { $in: testMatchIds } },
      ],
    }),
    TestSubmission.countDocuments({
      test: { $in: testMatchIds },
    }),
  ]);

  return Math.max(evalCount, subCount);
}

async function runCleanup() {
  const { dbName, confirm } = parseArgs();

  console.log('🧹 [DUPLICATE DRAFTS CLEANUP UTILITY]');
  console.log('====================================================');

  if (!dbName) {
    console.error('❌ ERROR: Missing required --db=<database_name> parameter.');
    console.error('👉 Example: node backend/scripts/cleanupDuplicateDrafts.js --db=asmaths_lms_dev [--confirm]');
    process.exit(1);
  }

  // Pre-flight name safety check
  assertDevOrTestDatabase(dbName);

  // Connect
  const rawUri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/asmaths_lms_dev';
  const targetUri = rawUri.replace(/\/([a-zA-Z0-9_\-]+)(\?|$)/, `/${dbName}$2`);

  console.log(`🔌 Connecting to database: "${dbName}"...`);
  await mongoose.connect(targetUri);

  const activeDbName = mongoose.connection.db.databaseName;
  assertDevOrTestDatabase(activeDbName);

  if (activeDbName !== dbName) {
    console.error(`❌ ERROR: Target database "${dbName}" does not match connected database "${activeDbName}".`);
    process.exit(1);
  }

  console.log(`✅ DB Safety Guard passed: Active connection verified on "${activeDbName}"\n`);

  // Query all drafts
  const drafts = await ClassTest.find({
    $or: [
      { status: 'draft' },
      { isDraft: true },
    ],
  }).sort({ createdAt: 1 }).lean();

  console.log(`📋 Found ${drafts.length} total draft test records in database.`);

  // Group by (normalized title + course + branch + semester)
  const groupMap = new Map();

  for (const d of drafts) {
    const normTitle = String(d.title || '').trim().toLowerCase();
    const course = String(d.course || '').trim().toLowerCase();
    const branch = String(d.branch || d.stream || '').trim().toLowerCase();
    const sem = String(d.semester || '').trim().toLowerCase();

    const key = `${normTitle}__${course}__${branch}__${sem}`;
    if (!groupMap.has(key)) {
      groupMap.set(key, []);
    }
    groupMap.get(key).push(d);
  }

  const duplicatesToPurge = [];
  const skippedWithAttempts = [];

  for (const [key, group] of groupMap.entries()) {
    if (group.length <= 1) continue; // Unique draft, keep

    // Keep the first (earliest created) draft
    const primary = group[0];
    const candidateDupes = group.slice(1);

    for (const cand of candidateDupes) {
      const attempts = await countTestAttempts(cand);
      if (attempts > 0) {
        skippedWithAttempts.push({
          id: cand._id,
          title: cand.title,
          attempts,
          reason: 'Has existing student evaluations/submissions',
        });
      } else {
        duplicatesToPurge.push({
          id: cand._id,
          title: cand.title,
          course: cand.course,
          branch: cand.branch,
          semester: cand.semester,
          primaryId: primary._id,
          createdAt: cand.createdAt,
        });
      }
    }
  }

  console.log(`\n🔍 Analysis Summary:`);
  console.log(`- Duplicate Groups Found: ${Array.from(groupMap.values()).filter(g => g.length > 1).length}`);
  console.log(`- Duplicate Drafts Eligible for Purge (0 attempts): ${duplicatesToPurge.length}`);
  console.log(`- Duplicate Drafts Skipped (Protected with attempts): ${skippedWithAttempts.length}`);

  if (duplicatesToPurge.length === 0) {
    console.log('\n✨ No duplicate draft tests found. Database is clean!');
    await mongoose.disconnect();
    process.exit(0);
  }

  console.log('\nSample candidates for purge:');
  duplicatesToPurge.slice(0, 5).forEach((item, idx) => {
    console.log(`  [${idx + 1}] "${item.title}" (_id: ${item.id}) -> Duplicate of primary (_id: ${item.primaryId})`);
  });
  if (duplicatesToPurge.length > 5) {
    console.log(`  ... and ${duplicatesToPurge.length - 5} more.`);
  }

  if (!confirm) {
    console.log('\n⚠️  DRY-RUN MODE ACTIVE: No records were modified.');
    console.log('👉 To permanently purge these duplicate drafts, run with --confirm:');
    console.log(`   node backend/scripts/cleanupDuplicateDrafts.js --db=${dbName} --confirm\n`);
    await mongoose.disconnect();
    process.exit(0);
  }

  // Confirmed execution
  console.log(`\n🚀 Executing confirmed deletion of ${duplicatesToPurge.length} duplicate drafts...`);
  const idsToDelete = duplicatesToPurge.map((d) => d.id);

  const result = await ClassTest.deleteMany({ _id: { $in: idsToDelete } });
  console.log(`✅ Successfully purged ${result.deletedCount} duplicate draft test(s)!`);

  try {
    await AuditLog.create({
      action: 'duplicate_drafts_purged',
      actor: { role: 'cli_admin', script: 'cleanupDuplicateDrafts.js' },
      details: {
        purgedCount: result.deletedCount,
        purgedIds: idsToDelete,
        database: dbName,
      },
    });
  } catch (_) {}

  await mongoose.disconnect();
  console.log('🔌 Disconnected from MongoDB. Clean-up complete!\n');
}

runCleanup().catch((err) => {
  console.error('❌ Script failed with error:', err);
  process.exit(1);
});
