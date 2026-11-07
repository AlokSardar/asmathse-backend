const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const Doubt = require('../models/Doubt');

async function benchmarkIndexes() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected to MongoDB Atlas for index benchmarking.');

  // Ensure indexes are built
  await Doubt.syncIndexes();
  const indexes = await Doubt.collection.indexes();
  console.log('Active Indexes on Doubt collection:');
  indexes.forEach(idx => console.log(' - ', JSON.stringify(idx.key)));

  // Test 1: Status + Course + Branch + CreatedAt (Queue query)
  console.log('\n--- Test 1: Queue Query { status: "escalated", course: "Engineering", branch: "CSE" } ---');
  const t1Start = Date.now();
  const exp1 = await Doubt.find({ status: 'escalated', course: 'Engineering', branch: 'CSE' })
    .sort({ createdAt: 1 })
    .explain('executionStats');
  const t1Duration = Date.now() - t1Start;
  const stage1 = exp1.executionStats.executionStages.stage || exp1.executionStats.executionStages.inputStage?.stage;
  console.log(`Execution time: ${t1Duration}ms (MongoDB executionTimeMillis: ${exp1.executionStats.executionTimeMillis}ms)`);
  console.log(`Stage: ${stage1}, docsExamined: ${exp1.executionStats.totalDocsExamined}, keysExamined: ${exp1.executionStats.totalKeysExamined}`);

  // Test 2: Student My Doubts Query { student: ID } sort { createdAt: -1 }
  console.log('\n--- Test 2: My Doubts Query { student: "650000000000000000000001" } sort { createdAt: -1 } ---');
  const fakeId = new mongoose.Types.ObjectId();
  const t2Start = Date.now();
  const exp2 = await Doubt.find({ student: fakeId })
    .sort({ createdAt: -1 })
    .explain('executionStats');
  const t2Duration = Date.now() - t2Start;
  const stage2 = exp2.executionStats.executionStages.stage || exp2.executionStats.executionStages.inputStage?.stage;
  console.log(`Execution time: ${t2Duration}ms (MongoDB executionTimeMillis: ${exp2.executionStats.executionTimeMillis}ms)`);
  console.log(`Stage: ${stage2}, docsExamined: ${exp2.executionStats.totalDocsExamined}, keysExamined: ${exp2.executionStats.totalKeysExamined}`);

  // Test 3: SLA Deadline Query { slaDeadline: { $lt: now }, status: "escalated" }
  console.log('\n--- Test 3: SLA Deadline Query { slaDeadline: { $lt: now }, status: "escalated" } ---');
  const t3Start = Date.now();
  const exp3 = await Doubt.find({ slaDeadline: { $lt: new Date() }, status: 'escalated' })
    .explain('executionStats');
  const t3Duration = Date.now() - t3Start;
  const stage3 = exp3.executionStats.executionStages.stage || exp3.executionStats.executionStages.inputStage?.stage;
  console.log(`Execution time: ${t3Duration}ms (MongoDB executionTimeMillis: ${exp3.executionStats.executionTimeMillis}ms)`);
  console.log(`Stage: ${stage3}, docsExamined: ${exp3.executionStats.totalDocsExamined}, keysExamined: ${exp3.executionStats.totalKeysExamined}`);

  await mongoose.disconnect();
  console.log('\n✅ All index benchmarks completed successfully.');
}

benchmarkIndexes().catch(err => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
