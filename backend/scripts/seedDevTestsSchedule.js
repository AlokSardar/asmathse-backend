/**
 * AS Maths LMS — Phase 2 DEV Data Seeder for Tests & Schedule Workspace
 *
 * Mandate:
 * - Requires explicit `--db <dbname>` argument.
 * - Enforces DB safety guard: database name MUST contain 'dev' or 'test'.
 * - Aborts immediately if targeting production ('asmaths_lms').
 * - Idempotent: cleans previous seed identifiers before recreating.
 * - Seeds ~8 tests for Engineering / CSE / Semester 1 across all states:
 *   (ongoing with live IST window, upcoming, completed, draft, archived, date_not_set, legacy, common)
 * - Seeds 5 fake students and realistic auto-graded/published evaluations.
 */

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const { assertDevOrTestDatabase } = require('../utils/dbGuard');
const ClassTest = require('../models/ClassTest');
const User = require('../models/User');
const Evaluation = require('../models/Evaluation');

function parseDbArg() {
  const args = process.argv.slice(2);
  let explicitDb = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--db' && args[i + 1]) {
      explicitDb = args[i + 1];
      break;
    }
    if (args[i].startsWith('--db=')) {
      explicitDb = args[i].split('=')[1];
      break;
    }
  }
  return explicitDb;
}

async function seed() {
  const explicitDb = parseDbArg();

  if (!explicitDb) {
    console.error('❌ FATAL: Explicit --db argument is required.');
    console.error('   Usage: node backend/scripts/seedDevTestsSchedule.js --db asmaths_lms_dev');
    process.exit(1);
  }

  assertDevOrTestDatabase(explicitDb);

  const rawUri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/asmaths_lms_dev';
  // Replace DB name in URI with explicitDb
  const targetUri = rawUri.replace(/\/([^/?]+)(\?|$)/, `/${explicitDb}$2`);

  console.log(`Connecting to database: ${explicitDb}...`);
  await mongoose.connect(targetUri);
  assertDevOrTestDatabase(mongoose.connection.db.databaseName);
  console.log(`✅ DB Safety Verified: Connected to ${mongoose.connection.db.databaseName}\n`);

  // Identifiers for idempotency
  const SEED_PREFIX = 'TST-SEED-DEV-';
  const testIds = [
    `${SEED_PREFIX}01-ONGOING`,
    `${SEED_PREFIX}02-UPCOMING`,
    `${SEED_PREFIX}03-COMPLETED`,
    `${SEED_PREFIX}04-DRAFT`,
    `${SEED_PREFIX}05-ARCHIVED`,
    `${SEED_PREFIX}06-NODATE`,
    `${SEED_PREFIX}07-LEGACY`,
    `${SEED_PREFIX}08-COMMON`,
  ];

  const studentEmails = [
    'dev.cohort.student1@asmaths.edu',
    'dev.cohort.student2@asmaths.edu',
    'dev.cohort.student3@asmaths.edu',
    'dev.cohort.student4@asmaths.edu',
    'dev.cohort.student5@asmaths.edu',
  ];

  console.log('🧹 Purging prior seed records for idempotency...');
  await ClassTest.deleteMany({ id: { $in: testIds } });
  await User.deleteMany({ email: { $in: studentEmails } });
  await Evaluation.deleteMany({ testId: { $in: testIds } });

  // 1. Seed 5 Fake Students
  console.log('👤 Seeding 5 fake students in Engineering / CSE / Semester 1...');
  const studentHash = await bcrypt.hash('StudentPass123!', 10);
  const studentNames = [
    'Rahul Sharma (Dev Student)',
    'Priya Patel (Dev Student)',
    'Amit Kumar (Dev Student)',
    'Sneha Sen (Dev Student)',
    'Vikram Das (Dev Student)',
  ];

  const createdStudents = [];
  for (let i = 0; i < studentEmails.length; i++) {
    const s = await User.create({
      name: studentNames[i],
      email: studentEmails[i],
      password: studentHash,
      role: 'student',
      course: 'Engineering',
      branch: 'CSE',
      semester: 'Semester 1',
      isApproved: true,
      tokenVersion: 0,
      mustChangePassword: false,
    });
    createdStudents.push(s);
  }

  // 2. Seed Tests
  const now = new Date();

  // Test 1: Ongoing Test (Live window right now in IST)
  // Started 25 mins ago, ends in 65 mins (Total 90m)
  const ongoingStart = new Date(now.getTime() - 25 * 60 * 1000);
  const ongoingEnd = new Date(ongoingStart.getTime() + 90 * 60 * 1000);
  const tOngoing = await ClassTest.create({
    id: testIds[0],
    testId: testIds[0],
    title: 'Advanced Engineering Calculus & Differential Equations',
    course: 'Engineering',
    branch: 'CSE',
    semester: 'Semester 1',
    status: 'ongoing',
    isDraft: false,
    published: true,
    startAt: ongoingStart,
    endAt: ongoingEnd,
    scheduledTime: '11:00',
    examDate: ongoingStart,
    durationMinutes: 90,
    totalMarks: 50,
    attemptsAllowed: 1,
    scheduleEstimated: false,
    testMode: 'Written Paper',
    questions: [
      { questionText: 'Solve d²y/dx² + 4y = e^(2x) using variation of parameters.', marks: 25 },
      { questionText: 'Evaluate double integral of (x + y) over region bounded by y = x² and y = x.', marks: 25 },
    ],
  });

  // Test 2: Upcoming Test (Tomorrow 10:00 AM IST)
  const tomorrowStart = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const tomorrowEnd = new Date(tomorrowStart.getTime() + 60 * 60 * 1000);
  const tUpcoming = await ClassTest.create({
    id: testIds[1],
    testId: testIds[1],
    title: 'Linear Algebra: Matrix Factorizations & Orthogonality',
    course: 'Engineering',
    branch: 'CSE',
    semester: 'Semester 1',
    status: 'scheduled',
    isDraft: false,
    published: true,
    startAt: tomorrowStart,
    endAt: tomorrowEnd,
    scheduledTime: '10:00',
    examDate: tomorrowStart,
    durationMinutes: 60,
    totalMarks: 40,
    attemptsAllowed: 1,
    scheduleEstimated: false,
    testMode: 'Online MCQ',
    isOnlineTest: true,
    questions: [
      { questionText: 'Determine the QR factorization of matrix A.', marks: 20, type: 'mcq' },
      { questionText: 'Compute orthogonal projection onto the subspace W.', marks: 20, type: 'mcq' },
    ],
  });

  // Test 3: Completed Test (2 Days Ago)
  const completedStart = new Date(now.getTime() - 48 * 60 * 60 * 1000);
  const completedEnd = new Date(completedStart.getTime() + 60 * 60 * 1000);
  const tCompleted = await ClassTest.create({
    id: testIds[2],
    testId: testIds[2],
    title: 'Discrete Mathematical Structures: Logic & Set Theory',
    course: 'Engineering',
    branch: 'CSE',
    semester: 'Semester 1',
    status: 'completed',
    isDraft: false,
    published: true,
    startAt: completedStart,
    endAt: completedEnd,
    scheduledTime: '14:00',
    examDate: completedStart,
    durationMinutes: 60,
    totalMarks: 50,
    attemptsAllowed: 1,
    scheduleEstimated: false,
    testMode: 'Written Paper',
    questions: [
      { questionText: 'Prove equivalence of proposition using truth table.', marks: 25 },
      { questionText: 'Verify partial order relation on power set.', marks: 25 },
    ],
  });

  // Test 4: Draft Test (No startAt, isDraft: true)
  const tDraft = await ClassTest.create({
    id: testIds[3],
    testId: testIds[3],
    title: 'Probability Distributions & Random Variables (Faculty Draft)',
    course: 'Engineering',
    branch: 'CSE',
    semester: 'Semester 1',
    status: 'draft',
    isDraft: true,
    published: false,
    startAt: null,
    endAt: null,
    scheduledTime: '',
    durationMinutes: 45,
    totalMarks: 30,
    attemptsAllowed: 1,
    scheduleEstimated: false,
    testMode: 'Online MCQ',
    isOnlineTest: true,
  });

  // Test 5: Archived Test (isArchived: true)
  const archivedStart = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const tArchived = await ClassTest.create({
    id: testIds[4],
    testId: testIds[4],
    title: 'Engineering Mathematics Baseline Diagnostic 2025',
    course: 'Engineering',
    branch: 'CSE',
    semester: 'Semester 1',
    status: 'completed',
    isDraft: false,
    published: true,
    isArchived: true,
    archivedAt: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000),
    startAt: archivedStart,
    endAt: new Date(archivedStart.getTime() + 60 * 60 * 1000),
    durationMinutes: 60,
    totalMarks: 50,
    attemptsAllowed: 1,
  });

  // Test 6: Without Date Test (date_not_set)
  const tNoDate = await ClassTest.create({
    id: testIds[5],
    testId: testIds[5],
    title: 'Numerical Analysis & Interpolation Methods (Unscheduled)',
    course: 'Engineering',
    branch: 'CSE',
    semester: 'Semester 1',
    status: 'date_not_set',
    isDraft: false,
    published: true,
    startAt: null,
    endAt: null,
    examDate: null,
    scheduledTime: '',
    durationMinutes: 60,
    totalMarks: 40,
    attemptsAllowed: 1,
  });

  // Test 7: Legacy Test (Missing startAt, has examDate only)
  const legacyExamDate = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
  const tLegacy = await ClassTest.create({
    id: testIds[6],
    testId: testIds[6],
    title: 'Legacy Vector Calculus Mid-Term Assessment',
    course: 'Engineering',
    branch: 'CSE',
    semester: 'Semester 1',
    status: 'scheduled',
    isDraft: false,
    published: true,
    startAt: null,
    endAt: null,
    examDate: legacyExamDate,
    durationMinutes: 60,
    totalMarks: 50,
    scheduleEstimated: true,
    attemptsAllowed: 1,
  });

  // Test 8: Common Foundation Test (isCommon: true, branch: 'Common', semester: 1 numeric)
  const commonStart = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000);
  const tCommon = await ClassTest.create({
    id: testIds[7],
    testId: testIds[7],
    title: 'Engineering Mechanics & Vector Dynamics (Common Foundation)',
    course: 'Engineering',
    branch: 'Common',
    isCommon: true,
    semester: 1,
    status: 'scheduled',
    isDraft: false,
    published: true,
    startAt: commonStart,
    endAt: new Date(commonStart.getTime() + 90 * 60 * 1000),
    scheduledTime: '11:00',
    examDate: commonStart,
    durationMinutes: 90,
    totalMarks: 50,
    attemptsAllowed: 1,
  });

  console.log('📝 Seeded 8 representative tests in all states.');

  // 3. Seed Realistic Evaluations on Completed and Ongoing Tests
  console.log('📊 Seeding evaluations and participation data...');
  // 4 evaluated student submissions on Completed Test
  await Evaluation.create({
    id: `EVAL-${testIds[2]}-ST1`,
    testId: testIds[2],
    examId: testIds[2],
    studentId: String(createdStudents[0]._id),
    studentEmail: createdStudents[0].email,
    studentName: createdStudents[0].name,
    course: 'Engineering',
    branch: 'CSE',
    semester: 'Semester 1',
    totalMarks: 50,
    marksObtained: 44,
    percentage: 88,
    grade: 'A',
    status: 'Evaluated',
    evaluationStatus: 'published',
    published: true,
    autoGraded: false,
    submittedAt: new Date(completedEnd.getTime() - 10 * 60 * 1000),
    publishedAt: new Date(completedEnd.getTime() + 2 * 60 * 60 * 1000),
  });

  await Evaluation.create({
    id: `EVAL-${testIds[2]}-ST2`,
    testId: testIds[2],
    examId: testIds[2],
    studentId: String(createdStudents[1]._id),
    studentEmail: createdStudents[1].email,
    studentName: createdStudents[1].name,
    course: 'Engineering',
    branch: 'CSE',
    semester: 'Semester 1',
    totalMarks: 50,
    marksObtained: 48,
    percentage: 96,
    grade: 'A+',
    status: 'Evaluated',
    evaluationStatus: 'published',
    published: true,
    autoGraded: false,
    submittedAt: new Date(completedEnd.getTime() - 5 * 60 * 1000),
    publishedAt: new Date(completedEnd.getTime() + 2 * 60 * 60 * 1000),
  });

  await Evaluation.create({
    id: `EVAL-${testIds[2]}-ST3`,
    testId: testIds[2],
    examId: testIds[2],
    studentId: String(createdStudents[2]._id),
    studentEmail: createdStudents[2].email,
    studentName: createdStudents[2].name,
    course: 'Engineering',
    branch: 'CSE',
    semester: 'Semester 1',
    totalMarks: 50,
    marksObtained: 38,
    percentage: 76,
    grade: 'B+',
    status: 'Evaluated',
    evaluationStatus: 'published',
    published: true,
    autoGraded: false,
    submittedAt: new Date(completedEnd.getTime() - 15 * 60 * 1000),
    publishedAt: new Date(completedEnd.getTime() + 2 * 60 * 60 * 1000),
  });

  await Evaluation.create({
    id: `EVAL-${testIds[2]}-ST4`,
    testId: testIds[2],
    examId: testIds[2],
    studentId: String(createdStudents[3]._id),
    studentEmail: createdStudents[3].email,
    studentName: createdStudents[3].name,
    course: 'Engineering',
    branch: 'CSE',
    semester: 'Semester 1',
    totalMarks: 50,
    marksObtained: 42,
    percentage: 84,
    grade: 'A',
    status: 'Evaluated',
    evaluationStatus: 'published',
    published: true,
    autoGraded: false,
    submittedAt: new Date(completedEnd.getTime() - 8 * 60 * 1000),
    publishedAt: new Date(completedEnd.getTime() + 2 * 60 * 60 * 1000),
  });

  // 1 auto-graded evaluation on Ongoing Test
  await Evaluation.create({
    id: `EVAL-${testIds[0]}-ST5`,
    testId: testIds[0],
    examId: testIds[0],
    studentId: String(createdStudents[4]._id),
    studentEmail: createdStudents[4].email,
    studentName: createdStudents[4].name,
    course: 'Engineering',
    branch: 'CSE',
    semester: 'Semester 1',
    totalMarks: 50,
    marksObtained: 35,
    percentage: 70,
    grade: 'B+',
    status: 'Evaluated',
    evaluationStatus: 'evaluated',
    published: false,
    autoGraded: true,
    submittedAt: new Date(),
  });

  console.log('\n════════════════════════════════════════════════════════════════');
  console.log('✅ DEV SEED SCRIPT COMPLETED SUCCESSFULLY!');
  console.log('════════════════════════════════════════════════════════════════');
  console.log(`Database : ${mongoose.connection.db.databaseName}`);
  console.log(`Cohort   : Engineering / CSE / Semester 1`);
  console.log(`Tests    : 8 (Ongoing, Upcoming, Completed, Draft, Archived, NoDate, Legacy, Common)`);
  console.log(`Students : 5 (Passwords: StudentPass123!)`);
  console.log(`Evals    : 5 (4 published + 1 autoGraded)`);
  console.log('════════════════════════════════════════════════════════════════\n');

  await mongoose.disconnect();
}

seed().catch((err) => {
  console.error('❌ Seed execution failed:', err);
  mongoose.disconnect().finally(() => process.exit(1));
});
