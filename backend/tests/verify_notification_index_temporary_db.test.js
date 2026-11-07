/**
 * Temporary Database Verification for Notification Partial Unique Index Migration
 *
 * Strictly operates on a standalone TEMPORARY database: 'test_notification_index_tmp'
 * Never touches 'asmaths_lms' (asserts this at startup).
 */

const mongoose = require('mongoose');
const assert = require('assert');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const TEMP_DB_NAME = 'test_notification_index_tmp';

async function runTest() {
  const baseUri = process.env.MONGO_URI;
  assert(baseUri, 'MONGO_URI must be provided');

  // Safety Assertion: ensure we NEVER connect to asmaths_lms for this test
  let targetUri = baseUri;
  const parsed = new URL(baseUri.startsWith('mongodb+srv://') ? baseUri.replace('mongodb+srv://', 'http://') : baseUri);
  const host = parsed.host;
  const auth = parsed.username ? `${parsed.username}:${parsed.password}@` : '';
  const search = parsed.search || '';
  if (baseUri.startsWith('mongodb+srv://')) {
    targetUri = `mongodb+srv://${auth}${host}/${TEMP_DB_NAME}${search}`;
  } else {
    targetUri = `mongodb://${auth}${host}/${TEMP_DB_NAME}${search}`;
  }

  console.log('='.repeat(75));
  console.log('🧪 NOTIFICATION PARTIAL UNIQUE INDEX VERIFICATION SUITE');
  console.log(`Database under test : ${TEMP_DB_NAME} (Strictly isolated temporary DB)`);
  console.log('='.repeat(75));

  await mongoose.connect(targetUri);
  assert.strictEqual(mongoose.connection.name, TEMP_DB_NAME, 'Must be connected to temp DB');
  const collection = mongoose.connection.db.collection('notifications');

  // Reset temp collection
  await collection.drop().catch(() => {});

  // ── PART A: Demonstrate Failure under Legacy Unique Index ─────────────────
  console.log('\n[STEP 1]: Creating legacy rigid unique index { id: 1 } (full unique)...');
  await collection.createIndex({ id: 1 }, { unique: true, name: 'id_1' });

  console.log('  Inserting first notification without id...');
  await collection.insertOne({
    title: 'Notification A (no id)',
    message: 'Testing legacy behavior',
    type: 'general',
  });
  console.log('  ✅ First notification without id inserted.');

  console.log('  Attempting second notification without id under legacy index...');
  let legacyFailed = false;
  try {
    await collection.insertOne({
      title: 'Notification B (no id)',
      message: 'Testing legacy behavior duplicate',
      type: 'general',
    });
  } catch (err) {
    legacyFailed = true;
    console.log(`  💥 EXPECTED FAILURE under legacy index: ${err.message} (code: ${err.code})`);
  }
  assert.strictEqual(legacyFailed, true, 'Legacy rigid unique index must fail on 2nd doc without id');

  // ── PART B: Apply Migration to Partial Unique Index ───────────────────────
  console.log('\n[STEP 2]: Dropping legacy index and recreating partial unique index...');
  await collection.dropIndex('id_1');
  await collection.createIndex(
    { id: 1 },
    {
      unique: true,
      partialFilterExpression: { id: { $type: 'string' } },
      name: 'id_1',
    }
  );
  console.log('  ✅ Partial unique index id_1 created.');

  // Clean collection before testing new index behavior
  await collection.deleteMany({});

  // ── PART C: Verify 2 Notifications Without ID Succeed ─────────────────────
  console.log('\n[STEP 3]: Testing insertion of multiple notifications WITHOUT id...');
  const doc1 = await collection.insertOne({
    title: 'Assignment Released: Chapter 4 Calculus',
    message: 'New assignment posted for Semester 1',
    type: 'assignment',
    course: 'engineering',
    branch: 'CSE',
  });
  const doc2 = await collection.insertOne({
    title: 'Exam Schedule Announced',
    message: 'Mid-term exams starting next week',
    type: 'announcement',
    course: 'engineering',
    branch: 'CSE',
  });
  console.log(`  ✅ Doc 1 inserted: _id=${doc1.insertedId}`);
  console.log(`  ✅ Doc 2 inserted: _id=${doc2.insertedId}`);

  const countWithoutId = await collection.countDocuments({ id: { $exists: false } });
  console.log(`  Count of docs without id: ${countWithoutId} (Expected: 2)`);
  assert.strictEqual(countWithoutId, 2, 'Both notifications without id must be present in DB');

  // ── PART D: Verify 2 Notifications With SAME String ID Are Rejected ───────
  console.log('\n[STEP 4]: Testing duplicate string id rejection...');
  const customId = 'notif_doubt_sync_99999';
  await collection.insertOne({
    id: customId,
    title: 'Doubt Resolved: DBT-26-0042',
    message: 'Faculty mentor replied to your doubt.',
    type: 'doubt_answered',
    doubtId: new mongoose.Types.ObjectId(),
  });
  console.log(`  ✅ Inserted first notification with string id: "${customId}"`);

  let dupFailed = false;
  try {
    await collection.insertOne({
      id: customId,
      title: 'Duplicate Doubt Notification Attempt',
      message: 'This should be blocked by unique index.',
      type: 'doubt_answered',
    });
  } catch (err) {
    dupFailed = true;
    console.log(`  💥 EXPECTED DUPLICATE REJECTION: ${err.message} (code: ${err.code})`);
  }
  assert.strictEqual(dupFailed, true, 'Duplicate string id must trigger MongoDB E11000 duplicate key error');

  // ── PART E: Verify Old Notification Types Still Work ─────────────────────
  console.log('\n[STEP 5]: Verifying backward compatibility with all legacy notification types...');
  const legacyTypes = [
    { type: 'test', title: 'New Test Uploaded: Calculus Quiz 1' },
    { type: 'classtest', title: 'Class Test Scheduled' },
    { type: 'material', title: 'New Study Material: Differential Equations PDF' },
    { type: 'general', title: 'System Maintenance Notice' },
    { type: 'doubt_escalated', title: 'Doubt Escalated to Faculty', id: `notif_${Date.now()}_abc` },
  ];

  for (const item of legacyTypes) {
    const res = await collection.insertOne(item);
    console.log(`  ✅ Inserted notification type: "${item.type}" (_id=${res.insertedId})`);
  }

  const allDocs = await collection.find({}).toArray();
  console.log(`\n  Total documents successfully stored: ${allDocs.length}`);
  assert.strictEqual(allDocs.length, 8, 'All 8 test notifications must be stored');

  // Drop temporary test database
  console.log('\n[STEP 6]: Cleaning up temporary test database...');
  await mongoose.connection.db.dropDatabase();
  console.log(`  ✅ Dropped temporary database "${TEMP_DB_NAME}".`);

  await mongoose.disconnect();
  console.log('\n' + '='.repeat(75));
  console.log('🎉 ALL NOTIFICATION INDEX TESTS PASSED (100% SUCCESS)');
  console.log('='.repeat(75) + '\n');
}

runTest().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
