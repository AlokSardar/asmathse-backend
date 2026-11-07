/**
 * Safe Database Index Migration: Notifications Collection
 *
 * Requirements:
 * - Drops legacy rigid index 'id_1' (which was full unique, rejecting multiple null/omitted ids).
 * - Replaces it with a partial unique index on { id: 1 } filtering { id: { $type: "string" } }.
 * - Preserves exact index name 'id_1'.
 * - Dry-run by default.
 * - Refuses to run unless explicit --db=<targetDatabaseName> is passed.
 * - Requires --confirm to apply changes.
 *
 * Usage:
 *   node scripts/migrateNotificationIndex.js --db=test_migration_tmp
 *   node scripts/migrateNotificationIndex.js --db=test_migration_tmp --confirm
 *   node scripts/migrateNotificationIndex.js --db=asmaths_lms --confirm
 */

const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

async function run() {
  const args = process.argv.slice(2);
  const dbArg = args.find((a) => a.startsWith('--db='));
  const isConfirm = args.includes('--confirm');

  if (!dbArg) {
    console.error('❌ ERROR: Explicit database parameter is required.');
    console.error('   Please pass: --db=<targetDatabaseName>');
    console.error('   Example: node scripts/migrateNotificationIndex.js --db=asmaths_lms');
    process.exit(1);
  }

  const targetDb = dbArg.replace('--db=', '').trim();
  if (!targetDb) {
    console.error('❌ ERROR: Database name cannot be empty.');
    process.exit(1);
  }

  const baseUri = process.env.MONGO_URI;
  if (!baseUri) {
    console.error('❌ ERROR: MONGO_URI is missing from environment.');
    process.exit(1);
  }

  // Connect specifically to the target DB by replacing the database path in the connection string
  let targetUri = baseUri;
  const parsed = new URL(baseUri.startsWith('mongodb+srv://') ? baseUri.replace('mongodb+srv://', 'http://') : baseUri);
  const host = parsed.host;
  const auth = parsed.username ? `${parsed.username}:${parsed.password}@` : '';
  const search = parsed.search || '';
  if (baseUri.startsWith('mongodb+srv://')) {
    targetUri = `mongodb+srv://${auth}${host}/${targetDb}${search}`;
  } else {
    targetUri = `mongodb://${auth}${host}/${targetDb}${search}`;
  }

  console.log('='.repeat(75));
  console.log('🚀 MIGRATION: Notification Partial Unique Index on id (id_1)');
  console.log(`Target Database : ${targetDb}`);
  console.log(`Execution Mode  : ${isConfirm ? 'CONFIRM (Modifications will be applied)' : 'DRY-RUN (Audit only, no changes)'}`);
  console.log('='.repeat(75));

  await mongoose.connect(targetUri);
  const db = mongoose.connection.db;
  const collection = db.collection('notifications');

  // 1. Fetch current indexes safely
  let existingIndexes = [];
  try {
    existingIndexes = await collection.indexes();
  } catch (err) {
    if (err.code === 26 || err.message.includes('ns does not exist')) {
      existingIndexes = [];
    } else {
      throw err;
    }
  }
  console.log('\n[STEP 1]: Current Indexes on "notifications":');
  existingIndexes.forEach((idx) => {
    console.log(`  - Name: "${idx.name}" | Keys: ${JSON.stringify(idx.key)} | Unique: ${!!idx.unique} | PartialFilter: ${JSON.stringify(idx.partialFilterExpression || null)}`);
  });

  const currentIdIndex = existingIndexes.find((idx) => idx.name === 'id_1');
  const needsMigration = !currentIdIndex || !currentIdIndex.partialFilterExpression || currentIdIndex.partialFilterExpression.id?.['$type'] !== 'string';

  console.log(`\n[STEP 2]: Status Assessment:`);
  if (!currentIdIndex) {
    console.log('  ⚠️  Index "id_1" does not exist yet. Needs creation as partial unique.');
  } else if (currentIdIndex.partialFilterExpression && currentIdIndex.partialFilterExpression.id?.['$type'] === 'string') {
    console.log('  ✅ Index "id_1" is ALREADY migrated to partial unique. No changes required.');
  } else {
    console.log('  ⚠️  Index "id_1" is currently rigid/non-partial. Must be dropped and recreated.');
  }

  if (!isConfirm) {
    console.log('\n' + '='.repeat(75));
    console.log('ℹ️  DRY-RUN COMPLETE: No changes were made.');
    if (needsMigration) {
      console.log(`   To apply migration on ${targetDb}, run with --confirm:`);
      console.log(`   node scripts/migrateNotificationIndex.js --db=${targetDb} --confirm\n`);
    } else {
      console.log('   Database already matches desired state.\n');
    }
    await mongoose.disconnect();
    return;
  }

  // 2. Perform Migration
  console.log('\n[STEP 3]: Applying Migration...');
  if (currentIdIndex) {
    console.log('  Dropping existing index "id_1"...');
    await collection.dropIndex('id_1');
    console.log('  ✅ Dropped legacy index "id_1".');
  }

  console.log('  Creating partial unique index "id_1" with { partialFilterExpression: { id: { $type: "string" } } }...');
  await collection.createIndex(
    { id: 1 },
    {
      unique: true,
      partialFilterExpression: { id: { $type: 'string' } },
      name: 'id_1',
    }
  );
  console.log('  ✅ Created new partial unique index "id_1".');

  // 3. Verify
  const postIndexes = await collection.indexes();
  console.log('\n[STEP 4]: Post-Migration Indexes on "notifications":');
  postIndexes.forEach((idx) => {
    console.log(`  - Name: "${idx.name}" | Keys: ${JSON.stringify(idx.key)} | Unique: ${!!idx.unique} | PartialFilter: ${JSON.stringify(idx.partialFilterExpression || null)}`);
  });

  const verifiedIdx = postIndexes.find((idx) => idx.name === 'id_1');
  if (verifiedIdx && verifiedIdx.partialFilterExpression?.id?.['$type'] === 'string') {
    console.log('\n🎉 SUCCESS: Index "id_1" is now active as a partial unique index!');
  } else {
    console.error('\n🚨 ERROR: Verification failed. Index not matching expected configuration.');
    process.exit(1);
  }

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('❌ Migration failed:', err.message);
  process.exit(1);
});
