/**
 * cleanupTrashCron.js
 * 
 * Scheduled cleanup background utility for purging soft-deleted tests older than 30 days.
 * 
 * Safety Rules:
 * 1. Default is DRY-RUN mode unless --confirm is explicitly passed.
 * 2. Requires --db=<dbname> argument.
 * 3. Aborts immediately if database name does NOT contain "dev" or "test".
 * 4. Only targets records with isDeleted === true AND deletedAt older than 30 days.
 * 
 * Usage:
 *   node backend/scripts/cleanupTrashCron.js --db=asmaths_lms_dev [--confirm]
 */

const mongoose = require('mongoose');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const { assertDevOrTestDatabase } = require('../utils/dbGuard');
const ClassTest = require('../models/ClassTest');
const AuditLog = require('../models/AuditLog');

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

async function runTrashCleanup() {
  const { dbName, confirm } = parseArgs();

  console.log('🗑️  [30-DAY TRASH CLEANUP UTILITY]');
  console.log('====================================================');

  if (!dbName) {
    console.error('❌ ERROR: Missing required --db=<database_name> parameter.');
    process.exit(1);
  }

  assertDevOrTestDatabase(dbName);

  const rawUri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/asmaths_lms_dev';
  const targetUri = rawUri.replace(/\/([a-zA-Z0-9_\-]+)(\?|$)/, `/${dbName}$2`);

  console.log(`🔌 Connecting to database: "${dbName}"...`);
  await mongoose.connect(targetUri);

  const activeDbName = mongoose.connection.db.databaseName;
  assertDevOrTestDatabase(activeDbName);

  console.log(`✅ DB Safety Guard passed: Operating on "${activeDbName}"\n`);

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const expiredTrashTests = await ClassTest.find({
    isDeleted: true,
    deletedAt: { $lt: thirtyDaysAgo },
  }).lean();

  console.log(`📋 Found ${expiredTrashTests.length} soft-deleted test(s) older than 30 days.`);

  if (expiredTrashTests.length === 0) {
    console.log('✨ No expired trash items to purge.');
    await mongoose.disconnect();
    process.exit(0);
  }

  if (!confirm) {
    console.log('\n⚠️  DRY-RUN MODE ACTIVE: No records were modified.');
    console.log('👉 To permanently purge expired trash tests, run with --confirm:');
    console.log(`   node backend/scripts/cleanupTrashCron.js --db=${dbName} --confirm\n`);
    await mongoose.disconnect();
    process.exit(0);
  }

  const ids = expiredTrashTests.map((t) => t._id);
  const result = await ClassTest.deleteMany({ _id: { $in: ids } });

  console.log(`✅ Successfully permanently purged ${result.deletedCount} expired trash test(s)!`);

  try {
    await AuditLog.create({
      action: 'expired_trash_purged',
      actor: { role: 'cron_scheduler', script: 'cleanupTrashCron.js' },
      details: { purgedCount: result.deletedCount, purgedIds: ids },
    });
  } catch (_) {}

  await mongoose.disconnect();
  console.log('🔌 Disconnected from MongoDB. Trash cleanup complete!\n');
}

runTrashCleanup().catch((err) => {
  console.error('❌ Script failed with error:', err);
  process.exit(1);
});
