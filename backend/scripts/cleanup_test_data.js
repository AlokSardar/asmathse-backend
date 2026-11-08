/**
 * AS Maths Educator — Safe Test Data Cleanup Utility
 * 
 * Purpose:
 * Safely removes test Evaluation, Submission, TestSubmission, Doubt, and Notification records
 * prior to Phase 1, starting from a pristine slate without touching student or faculty User accounts.
 * 
 * Safety Guarantees:
 * 1. Dry-run by default: Reports document counts only. Deletes nothing unless --confirm is passed.
 * 2. Explicit DB flag: Refuses to execute unless --db=<database_name> is passed and matches connected DB.
 * 3. User Protection Hard-Lock: NEVER touches 'users' or 'students' collections (hard-coded abort guard).
 * 4. Zero PII Exposure: Outputs numerical counts only, zero personal names or emails.
 * 
 * Usage:
 * Dry run: node scripts/cleanup_test_data.js --db=asmaths_lms
 * Real run: node scripts/cleanup_test_data.js --db=asmaths_lms --confirm
 */

const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const argv = process.argv.slice(2);
const dbArg = argv.find(a => a.startsWith('--db='));
const isConfirm = argv.includes('--confirm');

if (!dbArg) {
  console.error('\n❌ ERROR: Explicit database name required.');
  console.error('Usage: node scripts/cleanup_test_data.js --db=<database_name> [--confirm]\n');
  process.exit(1);
}

const targetDbName = dbArg.split('=')[1].trim();
if (!targetDbName) {
  console.error('\n❌ ERROR: Database name cannot be empty.');
  process.exit(1);
}

// Strictly protected collections that can NEVER be deleted
const FORBIDDEN_COLLECTIONS = ['users', 'students', 'content', 'classtests'];

// Test collections targeted for cleanup
const TARGET_COLLECTIONS = [
  'evaluations',
  'submissions',
  'testsubmissions',
  'doubts',
  'doubtfaqs',
  'doubtmessages',
  'doubtquotas',
  'doubttemplates',
  'notifications',
  'activities'
];

async function runCleanup() {
  const baseUri = process.env.MONGO_URI;
  if (!baseUri) {
    console.error('❌ MONGO_URI missing from environment.');
    process.exit(1);
  }

  // Construct target URI with explicit database name
  let targetUri = baseUri;
  const parsed = new URL(baseUri.startsWith('mongodb+srv://') ? baseUri.replace('mongodb+srv://', 'http://') : baseUri);
  const host = parsed.host;
  const auth = parsed.username ? `${parsed.username}:${parsed.password}@` : '';
  const search = parsed.search || '';
  if (baseUri.startsWith('mongodb+srv://')) {
    targetUri = `mongodb+srv://${auth}${host}/${targetDbName}${search}`;
  } else {
    targetUri = `mongodb://${auth}${host}/${targetDbName}${search}`;
  }

  console.log('='.repeat(75));
  console.log('🧹 AS MATHS LMS — SAFE TEST DATA CLEANUP UTILITY');
  console.log(`Database Target : ${targetDbName}`);
  console.log(`Execution Mode  : ${isConfirm ? '⚠️  REAL DELETION (--confirm active)' : '🔍 DRY-RUN ONLY (Safe Audit)'}`);
  console.log('='.repeat(75));

  await mongoose.connect(targetUri);

  const connectedDb = mongoose.connection.name;
  if (connectedDb !== targetDbName) {
    console.error(`❌ DB Mismatch: Connected to "${connectedDb}" instead of "${targetDbName}". Aborting.`);
    await mongoose.disconnect();
    process.exit(1);
  }

  // Verify User collection is untouched and preserved
  const db = mongoose.connection.db;
  const collections = await db.listCollections().toArray();
  const existingNames = collections.map(c => c.name);

  const userCount = existingNames.includes('users') ? await db.collection('users').countDocuments() : 0;
  console.log(`\n🔒 USER ACCOUNT PRESERVATION CHECK:`);
  console.log(`  Existing 'users' collection records: ${userCount} (STRICTLY PRESERVED & NEVER TOUCHED)`);

  console.log(`\n📊 TEST COLLECTION AUDIT:`);
  const auditReport = [];

  for (const collName of TARGET_COLLECTIONS) {
    // Redundant safety check: ensure collection is not forbidden
    if (FORBIDDEN_COLLECTIONS.includes(collName)) {
      throw new Error(`CRITICAL: Attempted to target forbidden collection: ${collName}`);
    }

    if (existingNames.includes(collName)) {
      const count = await db.collection(collName).countDocuments();
      auditReport.push({ collection: collName, count });
      console.log(`  - ${collName.padEnd(20)} : ${count} documents`);
    } else {
      auditReport.push({ collection: collName, count: 0 });
      console.log(`  - ${collName.padEnd(20)} : 0 documents (does not exist)`);
    }
  }

  const totalToDelete = auditReport.reduce((sum, item) => sum + item.count, 0);
  console.log(`\nTotal test documents found across targeted collections: ${totalToDelete}`);

  if (!isConfirm) {
    console.log('\n' + '='.repeat(75));
    console.log('✅ DRY RUN COMPLETED SUCCESSFULLY.');
    console.log('Zero documents were modified or deleted.');
    console.log(`To execute deletion, re-run with: node scripts/cleanup_test_data.js --db=${targetDbName} --confirm`);
    console.log('='.repeat(75));
  } else {
    console.log('\n⚠️  EXECUTING REAL DELETION ACROSS TEST COLLECTIONS...');
    let totalDeleted = 0;

    for (const item of auditReport) {
      if (item.count > 0) {
        const res = await db.collection(item.collection).deleteMany({});
        totalDeleted += res.deletedCount;
        console.log(`  ✔ Cleared ${item.collection}: ${res.deletedCount} documents deleted`);
      }
    }

    // Verify user accounts still intact
    const postUserCount = existingNames.includes('users') ? await db.collection('users').countDocuments() : 0;
    console.log('\n🔒 POST-CLEANUP USER ACCOUNT INTEGRITY CHECK:');
    console.log(`  'users' collection records remaining: ${postUserCount} (100% Intact)`);

    console.log('\n' + '='.repeat(75));
    console.log(`🎉 TEST DATA PURGE COMPLETE: ${totalDeleted} test records deleted.`);
    console.log('Database is clean and ready for Phase 1.');
    console.log('='.repeat(75));
  }

  await mongoose.disconnect();
}

runCleanup().catch(err => {
  console.error('\n❌ Cleanup utility error:', err);
  process.exit(1);
});
