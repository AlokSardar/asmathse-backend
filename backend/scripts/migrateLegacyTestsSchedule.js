#!/usr/bin/env node
/**
 * CLI Migration Script & Automated Hook: Backfill Legacy Tests with startAt, endAt, and scheduleEstimated
 * Usage:
 *   node backend/scripts/migrateLegacyTestsSchedule.js --db=asmaths_lms_dev [--confirm]
 *   node backend/scripts/migrateLegacyTestsSchedule.js --db=asmaths_lms --confirm  (Requires ALLOW_PROD_MIGRATION=true)
 */

const dotenv = require('dotenv');
const path = require('path');
const mongoose = require('mongoose');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const { assertDevOrTestDatabase } = require('../utils/dbGuard');
const { resolveTestTimestamps } = require('../utils/scheduleTime');
const ClassTest = require('../models/ClassTest');

/**
 * Core migration executor callable both via CLI and automated server startup hook
 */
async function runLegacyScheduleMigration({
  dbName,
  confirm = false,
  allowProd = false,
  isExistingConnection = false,
} = {}) {
  let targetDb = dbName;
  if (!targetDb) {
    if (mongoose.connection && mongoose.connection.name) {
      targetDb = mongoose.connection.name;
    } else if (process.env.MONGO_URI) {
      try {
        targetDb = process.env.MONGO_URI.split('/').pop().split('?')[0];
      } catch (_) {}
    }
  }

  targetDb = String(targetDb || 'asmaths_lms_dev').trim();

  // Validate via Database Safety Guard
  assertDevOrTestDatabase(targetDb, { allowProd });

  const mongoUri = process.env.MONGO_URI;
  if (!isExistingConnection && mongoose.connection.readyState !== 1) {
    if (!mongoUri) {
      throw new Error('❌ [ERROR]: MONGO_URI missing from environment.');
    }
    console.log(`🔌 Connecting to MongoDB Atlas: database "${targetDb}"...`);
    await mongoose.connect(mongoUri, { dbName: targetDb });
  }

  const activeDb = mongoose.connection.name || targetDb;
  assertDevOrTestDatabase(activeDb, { allowProd });
  console.log(`✅ Operating on authorized database: "${activeDb}"`);

  // Query tests missing startAt
  const legacyTests = await ClassTest.find({
    $or: [
      { startAt: { $exists: false } },
      { startAt: null },
    ],
  }).lean();

  console.log(`\n📋 Found ${legacyTests.length} legacy tests without explicit "startAt".`);

  if (legacyTests.length === 0) {
    console.log('✨ All tests already possess explicit startAt/endAt timestamps. Nothing to migrate.');
    if (!isExistingConnection) await mongoose.disconnect();
    return { totalFound: 0, updatedCount: 0, skippedCount: 0, migrationPlan: [] };
  }

  const migrationPlan = [];
  let noDateCount = 0;

  for (const t of legacyTests) {
    const { startAt, endAt, scheduleEstimated, durationMinutes } = resolveTestTimestamps(t);

    if (!startAt) {
      noDateCount++;
      migrationPlan.push({
        id: t._id,
        title: t.title,
        action: 'SKIP_NO_DATE',
        reason: 'Missing examDate or unparseable date format',
      });
      continue;
    }

    migrationPlan.push({
      id: t._id,
      title: t.title,
      action: 'UPDATE',
      startAt,
      endAt,
      scheduleEstimated,
      durationMinutes,
      examDate: t.examDate,
    });
  }

  console.log('\n🔍 Migration Plan Summary:');
  console.log(`- Ready to populate startAt/endAt: ${migrationPlan.filter((p) => p.action === 'UPDATE').length}`);
  console.log(`- Skipping due to missing date: ${noDateCount}`);

  if (!confirm) {
    console.log('\n⚠️  DRY-RUN MODE ONLY. No records were modified.');
    console.log('👉 To apply these changes, re-run with --confirm:');
    console.log(`   node backend/scripts/migrateLegacyTestsSchedule.js --db=${targetDb} --confirm\n`);
    if (!isExistingConnection) await mongoose.disconnect();
    return {
      totalFound: legacyTests.length,
      updatedCount: 0,
      skippedCount: noDateCount,
      migrationPlan,
    };
  }

  console.log(`\n⚡ Applying migration updates to "${activeDb}"...`);
  let updatedCount = 0;

  for (const item of migrationPlan) {
    if (item.action !== 'UPDATE') continue;

    await ClassTest.updateOne(
      { _id: item.id, $or: [{ startAt: { $exists: false } }, { startAt: null }] },
      {
        $set: {
          startAt: item.startAt,
          endAt: item.endAt,
          scheduleEstimated: item.scheduleEstimated,
          durationMinutes: item.durationMinutes,
        },
      }
    );
    updatedCount++;
  }

  console.log(`🎉 Migration successfully applied! Updated ${updatedCount} tests in "${activeDb}".\n`);
  if (!isExistingConnection) await mongoose.disconnect();

  return {
    totalFound: legacyTests.length,
    updatedCount,
    skippedCount: noDateCount,
    migrationPlan,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const dbArg = args.find((a) => a.startsWith('--db='));
  const isConfirm = args.includes('--confirm');
  const allowProd = process.env.ALLOW_PROD_MIGRATION === 'true';

  let targetDb;
  if (dbArg) {
    targetDb = dbArg.split('=')[1].trim();
  }

  if (!targetDb) {
    if (process.env.MONGO_URI) {
      try {
        targetDb = process.env.MONGO_URI.split('/').pop().split('?')[0];
      } catch (_) {}
    }
  }

  if (!targetDb) {
    console.error('❌ [ERROR]: Mandatory flag --db=<database_name> is required.');
    console.error('Example: node backend/scripts/migrateLegacyTestsSchedule.js --db=asmaths_lms_dev [--confirm]');
    process.exit(1);
  }

  await runLegacyScheduleMigration({
    dbName: targetDb,
    confirm: isConfirm,
    allowProd,
    isExistingConnection: false,
  });
}

if (require.main === module) {
  main().catch((err) => {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
  });
}

module.exports = { main, runLegacyScheduleMigration };
