const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const User = require('../models/User');
const Doubt = require('../models/Doubt');
const DoubtMessage = require('../models/DoubtMessage');
const DoubtQuota = require('../models/DoubtQuota');
const Notification = require('../models/Notification');

const SMOKE_STUDENT_EMAIL = 'smoke.student.2026@asmaths.edu';
const SMOKE_TEACHER_EMAIL = 'smoke.teacher.2026@asmaths.edu';

async function run() {
  const mode = process.argv[2]; // 'create' | 'cleanup'
  if (!['create', 'cleanup'].includes(mode)) {
    console.log('Usage: node manageLiveSmokeAccounts.js [create|cleanup]');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);
  console.log(`Connected to MongoDB Atlas (${mongoose.connection.name}). Mode: ${mode.toUpperCase()}`);

  if (mode === 'create') {
    // Dynamically generate a cryptographically strong random password for this smoke test run
    const generatedPassword = crypto.randomBytes(16).toString('base64url') + '!X9';
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(generatedPassword, salt);

    // 1. Create or Update Dedicated Test Student
    let student = await User.findOne({ email: SMOKE_STUDENT_EMAIL });
    if (!student) {
      student = await User.create({
        name: '[SMOKE TEST] Rohan Student',
        email: SMOKE_STUDENT_EMAIL,
        password: hashedPassword,
        role: 'student',
        targetCourse: 'engineering',
        branch: 'CSE',
        semester: 1,
        isApproved: true,
      });
      console.log(`✅ Created Smoke Student: ${SMOKE_STUDENT_EMAIL}`);
    } else {
      student.password = hashedPassword;
      student.name = '[SMOKE TEST] Rohan Student';
      student.targetCourse = 'engineering';
      student.branch = 'CSE';
      student.isApproved = true;
      await student.save();
      console.log(`🔄 Updated existing Smoke Student credentials: ${SMOKE_STUDENT_EMAIL}`);
    }

    // 2. Create or Update Dedicated Test Teacher
    let teacher = await User.findOne({ email: SMOKE_TEACHER_EMAIL });
    if (!teacher) {
      teacher = await User.create({
        name: '[SMOKE TEST] Prof. S. Mukherjee',
        email: SMOKE_TEACHER_EMAIL,
        password: hashedPassword,
        role: 'teacher',
        targetCourse: 'engineering',
        branch: 'CSE',
        isApproved: true,
      });
      console.log(`✅ Created Smoke Faculty: ${SMOKE_TEACHER_EMAIL}`);
    } else {
      teacher.password = hashedPassword;
      teacher.name = '[SMOKE TEST] Prof. S. Mukherjee';
      teacher.targetCourse = 'engineering';
      teacher.branch = 'CSE';
      teacher.isApproved = true;
      await teacher.save();
      console.log(`🔄 Updated existing Smoke Faculty credentials: ${SMOKE_TEACHER_EMAIL}`);
    }

    console.log('\n' + '='.repeat(70));
    console.log('🔑 [ONE-TIME LIVE SMOKE TEST CREDENTIALS]');
    console.log('='.repeat(70));
    console.log(` Student Email  : ${SMOKE_STUDENT_EMAIL}`);
    console.log(` Teacher Email  : ${SMOKE_TEACHER_EMAIL}`);
    console.log(` Password       : ${generatedPassword}`);
    console.log(' Course / Scope : Engineering / CSE');
    console.log(' NOTE: This password is ONLY displayed here and is NOT stored in repo.');
    console.log('='.repeat(70) + '\n');
  } else if (mode === 'cleanup') {
    // 1. Find smoke users by exact dedicated email
    const smokeUsers = await User.find({
      email: { $in: [SMOKE_STUDENT_EMAIL, SMOKE_TEACHER_EMAIL] },
    });
    const smokeUserIds = smokeUsers.map((u) => u._id);

    // 2. Find doubts belonging to or assigned to smoke users
    const smokeDoubts = await Doubt.find({
      $or: [{ student: { $in: smokeUserIds } }, { 'assignedTeacher.id': { $in: smokeUserIds } }],
    });
    const smokeDoubtIds = smokeDoubts.map((d) => d._id);

    // 3. Delete DoubtMessages
    const deletedMessages = await DoubtMessage.deleteMany({
      $or: [
        { doubtId: { $in: smokeDoubtIds } },
        { authorId: { $in: smokeUserIds.map(String) } },
      ],
    });

    // 4. Delete Doubts
    const deletedDoubts = await Doubt.deleteMany({
      _id: { $in: smokeDoubtIds },
    });

    // 5. Delete Quota records
    const deletedQuotas = await DoubtQuota.deleteMany({
      student: { $in: smokeUserIds },
    });

    // 6. Delete Notifications
    const deletedNotifications = await Notification.deleteMany({
      userId: { $in: smokeUserIds },
    });

    // 7. Delete Users
    const deletedUsers = await User.deleteMany({
      _id: { $in: smokeUserIds },
    });

    console.log('\n' + '='.repeat(70));
    console.log('🧹 [SMOKE TEST CLEANUP AUDIT SUMMARY]');
    console.log('='.repeat(70));
    console.log(`- Smoke Users Target: [${SMOKE_STUDENT_EMAIL}, ${SMOKE_TEACHER_EMAIL}]`);
    console.log(`- Users Deleted         : ${deletedUsers.deletedCount}`);
    console.log(`- Doubts Deleted        : ${deletedDoubts.deletedCount}`);
    console.log(`- Doubt Messages Deleted: ${deletedMessages.deletedCount}`);
    console.log(`- Quota Records Deleted : ${deletedQuotas.deletedCount}`);
    console.log(`- Notifications Deleted : ${deletedNotifications.deletedCount}`);
    console.log('='.repeat(70));
    console.log('✅ Smoke test data cleanup completed safely. Zero production accounts touched.\n');
  }

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('❌ Error managing smoke accounts:', err.message);
  process.exit(1);
});
