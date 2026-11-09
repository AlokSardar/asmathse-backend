#!/usr/bin/env node
/**
 * Manual Index Creation Fallback Script for Tests & Schedule Workspace
 * Ensures compound and single-field indexes are built cleanly on MongoDB Atlas.
 * Usage:
 *   node backend/scripts/createTestsScheduleIndexes.js --db=asmaths_lms_dev
 */

const dotenv = require('dotenv');
const path = require('path');
const mongoose = require('mongoose');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const { assertDevOrTestDatabase } = require('../utils/dbGuard');
const ClassTest = require('../models/ClassTest');

async function main() {
  const args = process.argv.slice(2);
  const dbArg = args.find((a) => a.startsWith('--db='));

  const targetDb = dbArg ? dbArg.split('=')[1].trim() : 'asmaths_lms_dev';
  assertDevOrTestDatabase(targetDb);

  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) {
    console.error('❌ MONGO_URI missing from environment.');
    process.exit(1);
  }

  console.log(`🔌 Connecting to MongoDB Atlas: database "${targetDb}"...`);
  await mongoose.connect(mongoUri, { dbName: targetDb });
  assertDevOrTestDatabase(mongoose.connection.name);
  console.log(`✅ Connected to verified dev/test database: "${mongoose.connection.name}"`);

  console.log('\n📊 Auditing and creating indexes on ClassTest collection...');
  const beforeIndexes = await ClassTest.collection.indexes();
  console.log('Existing indexes before:', beforeIndexes.map((idx) => idx.name));

  await ClassTest.createIndexes();

  const afterIndexes = await ClassTest.collection.indexes();
  console.log('\n✅ Active indexes after build:');
  afterIndexes.forEach((idx) => {
    console.log(`  • ${idx.name}: ${JSON.stringify(idx.key)}`);
  });

  await mongoose.disconnect();
  console.log('\n✨ Database index audit complete.');
}

if (require.main === module) {
  main().catch((err) => {
    console.error('❌ Index creation failed:', err.message);
    process.exit(1);
  });
}

module.exports = { main };
