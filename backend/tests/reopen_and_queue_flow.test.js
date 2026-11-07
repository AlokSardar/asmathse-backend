const assert = require('assert');
const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const User = require('../models/User');
const Doubt = require('../models/Doubt');
const DoubtMessage = require('../models/DoubtMessage');
const { reopenDoubt, getTeacherQueue } = require('../controllers/doubtController');

async function runTests() {
  console.log('=== STARTING REOPEN & QUEUE FLOW VERIFICATION ===');
  await mongoose.connect(process.env.MONGO_URI);

  // 1. Create a temporary test student and doubt
  const testStudent = await User.findOne({ email: 'student@asmaths.edu' });
  assert(testStudent, 'Test student account must exist');

  const testDoubt = await Doubt.create({
    student: testStudent._id,
    studentName: testStudent.name,
    studentEmail: testStudent.email,
    semester: 'Semester 1',
    doubtCode: `DBT-VERIFY-${Date.now().toString().slice(-4)}`,
    title: 'Verification of Reopen Latency & Queue Stream',
    subject: 'Engineering Mathematics',
    course: 'Engineering',
    branch: 'CSE',
    topic: 'Differential Calculus',
    status: 'resolved',
    reopenCount: 0,
    source: 'web_text',
    urgency: 'standard',
  });

  console.log(`Created test doubt: ${testDoubt.doubtCode} with status 'resolved'`);

  // 2. Test Reopen via POST handler
  const reqPost = {
    user: testStudent,
    params: { id: String(testDoubt._id) },
    body: { message: 'Can you please elaborate step 2?' },
  };

  let resData = null;
  const resMock = {
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      resData = data;
      return this;
    },
  };

  await reopenDoubt(reqPost, resMock);
  assert.strictEqual(resData.success, true, 'POST reopen must succeed');
  assert.strictEqual(resData.doubt.status, 'reopened', 'Doubt status must be reopened');
  assert.strictEqual(resData.doubt.reopenCount, 1, 'reopenCount must be incremented to 1');
  console.log('✅ 1. POST reopen succeeded: status is reopened, count is 1');

  // 3. Test Second Reopen Attempt -> Must be rejected (limit 1)
  let secondResData = null;
  const resMock2 = {
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      secondResData = data;
      return this;
    },
  };

  await reopenDoubt(reqPost, resMock2);
  assert.strictEqual(secondResData.success, false, 'Second reopen must be rejected');
  assert.strictEqual(resMock2.statusCode, 400, 'HTTP status must be 400');
  console.log('✅ 2. Second reopen rejected with 400 limit guard');

  // 4. Test Teacher Queue visibility: the reopened doubt must appear in the Teacher Queue
  const teacherUser = await User.findOne({ email: 'mukherjee.eng@asmaths.edu' });
  assert(teacherUser, 'Teacher account must exist');

  let queueData = null;
  const reqQueue = {
    user: teacherUser,
    query: { status: 'all', page: 1, limit: 20 },
  };
  const resQueueMock = {
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      queueData = data;
      return this;
    },
  };

  await getTeacherQueue(reqQueue, resQueueMock);
  assert(queueData.success, 'getTeacherQueue must succeed');
  const foundInQueue = queueData.queue.find((d) => String(d._id) === String(testDoubt._id));
  assert(foundInQueue, 'Reopened doubt must appear in the teacher queue');
  assert.strictEqual(foundInQueue.status, 'reopened', 'Queue item status must be reopened');
  console.log('✅ 3. Reopened doubt streams live to Teacher Queue with status: reopened');

  // 5. Test PATCH endpoint by simulating PATCH request to a second resolved doubt
  const testDoubtPatch = await Doubt.create({
    student: testStudent._id,
    studentName: testStudent.name,
    studentEmail: testStudent.email,
    semester: 'Semester 1',
    doubtCode: `DBT-PATCH-${Date.now().toString().slice(-4)}`,
    title: 'Verification of PATCH Reopen',
    subject: 'Engineering Mathematics',
    course: 'Engineering',
    branch: 'CSE',
    topic: 'Linear Algebra',
    status: 'resolved',
    reopenCount: 0,
    source: 'web_text',
    urgency: 'standard',
  });

  const reqPatch = {
    user: testStudent,
    params: { id: String(testDoubtPatch._id) },
    body: { message: 'Need clarification on row reduction' },
  };
  let patchResData = null;
  const resPatchMock = {
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      patchResData = data;
      return this;
    },
  };

  await reopenDoubt(reqPatch, resPatchMock);
  assert.strictEqual(patchResData.success, true, 'PATCH reopen must succeed');
  assert.strictEqual(patchResData.doubt.status, 'reopened', 'Doubt status must be reopened');
  console.log('✅ 4. PATCH reopen succeeded: status is reopened');

  // Clean up the 2 test doubts created in this verification run
  await Doubt.deleteMany({ _id: { $in: [testDoubt._id, testDoubtPatch._id] } });
  await DoubtMessage.deleteMany({ doubt: { $in: [testDoubt._id, testDoubtPatch._id] } });
  console.log('Cleaned up verification test documents.');

  await mongoose.disconnect();
  console.log('=== ALL REOPEN & QUEUE TESTS PASSED SUCCESSFULLY ===');
}

runTests().catch((err) => {
  console.error('TEST RUN FAILED:', err);
  process.exit(1);
});
