#!/usr/bin/env node
/**
 * CLI Migration Script: Backfill Legacy Tests with startAt, endAt, and scheduleEstimated
 * Usage:
 *   node backend/scripts/migrateLegacyTestsSchedule.js --db=asmaths_lms_dev [--confirm]
 */

const dotenv = require('dotenv');
const path = require('path');
const mongoose = require('mongoose');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const { assertDevOrTestDatabase } = require('../utils/dbGuard');
const { resolveTestTimestamps } = require('../utils/scheduleTime');
const ClassTest = require('../models/ClassTest');

async function main() {
  const args = process.argv.slice(2);
  const dbArg = args.find((a) => a.startsWith('--db='));
  const isConfirm = args.includes('--confirm');

  if (!dbArg) {
    console.error('❌ [ERROR]: Mandatory flag --db=<database_name> is required.');
    console.error('Example: node backend/scripts/migrateLegacyTestsSchedule.js --db=asmaths_lms_dev [--confirm]');
    process.exit(1);
  }

  const targetDb = dbArg.split('=')[1].trim();

  // Strict Database Safety Check
  try {
    assertDevOrTestDatabase(targetDb);
  } catch (guardErr) {
    console.error(guardErr.message);
    process.exit(1);
  }

  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) {
    console.error('❌ [ERROR]: MONGO_URI missing from environment.');
    process.exit(1);
  }

  // Connect to target database
  console.log(`🔌 Connecting to MongoDB Atlas: database "${targetDb}"...`);
  await mongoose.connect(mongoUri, { dbName: targetDb });

  const activeDb = mongoose.connection.name;
  assertDevOrTestDatabase(activeDb);
  console.log(`✅ Connected to verified dev/test database: "${activeDb}"`);

  // Query tests missing startAt
  const legacyTests = await ClassTest.find({
    $or: [
      { startAt: { $exists: false } },
      { startAt: null },
    ]
  }).lean();

  console.log(`\n📋 Found ${legacyTests.length} legacy tests without explicit "startAt".`);

  if (legacyTests.length === 0) {
    console.log('✨ All tests already possess explicit startAt/endAt timestamps. Nothing to migrate.');
    await mongoose.disconnect();
    return;
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
  console.log(`- Ready to populate startAt/endAt: ${migrationPlan.filter(p => p.action === 'UPDATE').length}`);
  console.log(`- Skipping due to missing date: ${noDateCount}`);

  console.log('\nSample derivations:');
  migrationPlan.slice(0, 5).forEach((p, idx) => {
    if (p.action === 'UPDATE') {
      console.log(`  [${idx + 1}] "${p.title}" -> startAt: ${p.startAt.toISOString()} | endAt: ${p.endAt.toISOString()} | estimated: ${p.scheduleEstimated}`);
    } else {
      console.log(`  [${idx + 1}] "${p.title}" -> SKIPPED (${p.reason})`);
    }
  });

  if (!isConfirm) {
    console.log('\n⚠️  DRY-RUN MODE ONLY. No records were modified.');
    console.log('👉 To apply these changes to the DEV database, re-run with --confirm:');
    console.log(`   node backend/scripts/migrateLegacyTestsSchedule.js --db=${targetDb} --confirm\n`);
    await mongoose.disconnect();
    return;
  }

  console.log('\n⚡ Applying migration updates to DEV database...');
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
        }
      }
    );
    updatedCount++;
  }

  console.log(`🎉 Migration successfully applied! Updated ${updatedCount} tests in "${targetDb}".\n`);
  await mongoose.disconnect();
}

if (require.main === module) {
  main().catch((err) => {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
  });
}

module.exports = { main };
