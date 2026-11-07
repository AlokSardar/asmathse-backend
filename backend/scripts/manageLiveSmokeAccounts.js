const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const User = require('../models/User');
const Doubt = require('../models/Doubt');
const DoubtMessage = require('../models/DoubtMessage');
const Notification = require('../models/Notification');

const SMOKE_STUDENT_EMAIL = 'smoke.student.2026@asmaths.edu';
const SMOKE_TEACHER_EMAIL = 'smoke.teacher.2026@asmaths.edu';
const DEFAULT_PASSWORD = 'SmokeTest2026!';

async function run() {
  const mode = process.argv[2]; // 'create' | 'cleanup'
  if (!['create', 'cleanup'].includes(mode)) {
    console.log('Usage: node manageLiveSmokeAccounts.js [create|cleanup]');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);
  console.log(`Connected to MongoDB Atlas (${mongoose.connection.name}). Mode: ${mode.toUpperCase()}`);

  if (mode === 'create') {
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(DEFAULT_PASSWORD, salt);

    // 1. Create Dedicated Test Student
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
      console.log(`✅ Created Smoke Student: ${SMOKE_STUDENT_EMAIL} (Password: ${DEFAULT_PASSWORD})`);
    } else {
      console.log(`ℹ️ Smoke Student already exists: ${SMOKE_STUDENT_EMAIL}`);
    }

    // 2. Create Dedicated Test Teacher
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
      console.log(`✅ Created Smoke Faculty: ${SMOKE_TEACHER_EMAIL} (Password: ${DEFAULT_PASSWORD})`);
    } else {
      console.log(`ℹ️ Smoke Faculty already exists: ${SMOKE_TEACHER_EMAIL}`);
    }
  } else if (mode === 'cleanup') {
    // 1. Find smoke users
    const smokeUsers = await User.find({
      email: { $in: [SMOKE_STUDENT_EMAIL, SMOKE_TEACHER_EMAIL] },
    });
    const smokeUserIds = smokeUsers.map((u) => u._id);

    // 2. Delete doubts and messages created by or assigned to smoke users
    const deletedDoubts = await Doubt.deleteMany({
      $or: [{ student: { $in: smokeUserIds } }, { 'assignedTeacher.id': { $in: smokeUserIds } }],
    });
    console.log(`🧹 Cleaned up ${deletedDoubts.deletedCount} smoke test doubts.`);

    await DoubtMessage.deleteMany({
      authorId: { $in: smokeUserIds.map(String) },
    });

    await Notification.deleteMany({
      userId: { $in: smokeUserIds },
    });

    // 3. Delete smoke users
    const deletedUsers = await User.deleteMany({
      email: { $in: [SMOKE_STUDENT_EMAIL, SMOKE_TEACHER_EMAIL] },
    });
    console.log(`🧹 Removed ${deletedUsers.deletedCount} dedicated smoke test accounts.`);
  }

  await mongoose.disconnect();
  console.log('✅ Operation complete.');
}

run().catch((err) => {
  console.error('Error managing smoke accounts:', err.message);
  process.exit(1);
});
