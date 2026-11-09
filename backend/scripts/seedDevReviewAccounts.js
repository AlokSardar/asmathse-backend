const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { assertDevOrTestDatabase } = require('../utils/dbGuard');
const User = require('../models/User');

async function seedDevReviewAccounts() {
  await mongoose.connect(process.env.MONGO_URI);
  assertDevOrTestDatabase(mongoose.connection.db.databaseName);
  console.log('[SAFETY CHECK] Connected to DEV DB:', mongoose.connection.db.databaseName);

  const teacherHash = await bcrypt.hash('FacultyDev123!', 10);
  const studentHash = await bcrypt.hash('StudentDev123!', 10);

  const teacher = await User.findOneAndUpdate(
    { email: 'faculty.dev@asmaths.edu' },
    {
      $set: {
        name: 'Dr. Dev Teacher (Faculty)',
        password: teacherHash,
        role: 'teacher',
        course: 'Engineering',
        branch: 'CSE',
        semester: 'Semester 1',
        isApproved: true,
        tokenVersion: 0,
        mustChangePassword: false,
      },
    },
    { upsert: true, returnDocument: 'after' }
  );

  const student = await User.findOneAndUpdate(
    { email: 'student.dev@asmaths.edu' },
    {
      $set: {
        name: 'Dev Student (Test Cohort)',
        password: studentHash,
        role: 'student',
        course: 'Engineering',
        branch: 'CSE',
        semester: 'Semester 1',
        isApproved: true,
        tokenVersion: 0,
        mustChangePassword: false,
      },
    },
    { upsert: true, returnDocument: 'after' }
  );

  console.log('✅ Teacher Account Ready:', teacher.email, '(Password: FacultyDev123!)');
  console.log('✅ Student Account Ready:', student.email, '(Password: StudentDev123!)');
  await mongoose.disconnect();
}

seedDevReviewAccounts().catch((err) => {
  console.error('Seed error:', err);
  mongoose.disconnect().finally(() => process.exit(1));
});
