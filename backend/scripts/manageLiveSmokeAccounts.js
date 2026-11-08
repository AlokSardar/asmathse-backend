const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const User = require('../models/User');
const Doubt = require('../models/Doubt');
const Notification = require('../models/Notification');
const SecurityEvent = require('../models/SecurityEvent');
const EmailChangeRequest = require('../models/EmailChangeRequest');
const AuditLog = require('../models/AuditLog');

const SMOKE_TEACHER_EMAIL = 'smoketest.teacher@asmaths.edu';

function parseArgs() {
  const args = process.argv.slice(2);
  const mode = args.find((a) => a === 'create' || a === 'cleanup');
  const dryRun = args.includes('--dry-run');

  const dbArg = args.find((a) => a.startsWith('--db='));
  const explicitDb = dbArg ? dbArg.split('=')[1].trim() : null;

  return { mode, dryRun, explicitDb };
}

async function run() {
  const { mode, dryRun, explicitDb } = parseArgs();

  console.log('='.repeat(75));
  console.log('🔬 [LIVE SMOKE TEST ACCOUNT MANAGER]');
  console.log('='.repeat(75));

  if (!mode) {
    console.error('❌ Usage: node manageLiveSmokeAccounts.js [create|cleanup] --db=<database_name> [--dry-run]');
    console.error('   Example: node manageLiveSmokeAccounts.js create --db=asmaths_lms_dev --dry-run');
    console.error('   Example: node manageLiveSmokeAccounts.js cleanup --db=asmaths_lms_dev');
    process.exit(1);
  }

  // Safety Guard: Database name must be explicitly passed via --db=<name>
  if (!explicitDb) {
    console.error('❌ [SAFETY GUARD FAILED]: Database name must be explicitly provided via --db=<database_name>.');
    console.error('   Preventing accidental execution against unintended environments.');
    console.error('   Usage: node manageLiveSmokeAccounts.js ' + mode + ' --db=asmaths_lms_dev' + (dryRun ? ' --dry-run' : ''));
    process.exit(1);
  }

  const dbUri = process.env.MONGO_URI;
  if (!dbUri) {
    console.error('❌ [CONFIG ERROR]: MONGO_URI is missing from environment.');
    process.exit(1);
  }

  await mongoose.connect(dbUri);
  const connectedDb = mongoose.connection.name;

  // Verify connected database matches explicitly passed database name
  if (connectedDb !== explicitDb) {
    console.error(`❌ [SAFETY GUARD ABORT]: Target database mismatch!`);
    console.error(`   Requested Database : "${explicitDb}"`);
    console.error(`   Connected Database : "${connectedDb}"`);
    console.error(`   The explicit --db flag must match the active MongoDB connection.`);
    await mongoose.disconnect();
    process.exit(1);
  }

  console.log(`Connected Database : "${connectedDb}" (Matches explicit --db parameter)`);
  console.log(`Operation Mode     : ${mode.toUpperCase()}`);
  console.log(`Execution Type     : ${dryRun ? '🔍 DRY RUN (Simulated, zero database writes)' : '⚡ LIVE RUN (Executing database mutations)'}`);
  console.log('-'.repeat(75));

  if (mode === 'create') {
    // Generate secure 16+ char random password with mixed cases, numbers, and symbols
    const randomHex = crypto.randomBytes(14).toString('base64url');
    const generatedPassword = `Smk!${randomHex}9Aa#`;

    const defaultPreferences = {
      language: 'en',
      theme: 'light',
      defaultCourse: 'Engineering',
      defaultBranch: 'CSE',
      defaultSemester: 'Semester 1',
      notifications: {
        doubts: true,
        reEvaluations: true,
        slaBreaches: true,
      },
    };

    const teacherPayload = {
      name: '[SMOKE TEST] Prof. S. Mukherjee',
      email: SMOKE_TEACHER_EMAIL,
      role: 'teacher',
      stream: 'Engineering',
      targetCourse: 'engineering',
      course: 'Engineering',
      branch: 'CSE',
      semester: 1,
      isApproved: true,
      tokenVersion: 0,
      mustChangePassword: false,
      designation: 'Assistant Professor (Mathematics)',
      bio: 'Dedicated automated smoke test faculty account for production health verifications.',
      preferences: defaultPreferences,
    };

    if (dryRun) {
      console.log('🔍 [DRY RUN CREATE PLAN]:');
      console.log(`- Target Account     : ${SMOKE_TEACHER_EMAIL}`);
      console.log(`- Role               : ${teacherPayload.role}`);
      console.log(`- Course / Branch    : ${teacherPayload.course} / ${teacherPayload.branch}`);
      console.log(`- isApproved         : ${teacherPayload.isApproved}`);
      console.log(`- tokenVersion       : ${teacherPayload.tokenVersion}`);
      console.log(`- mustChangePassword : ${teacherPayload.mustChangePassword}`);
      console.log(`- Default Preferences:`, JSON.stringify(teacherPayload.preferences));
      console.log(`- Generated Password : ${generatedPassword}`);
      console.log('\n[DRY RUN]: Zero records written to database. Run without --dry-run to commit.');
    } else {
      const salt = await bcrypt.genSalt(10);
      const hashedPassword = await bcrypt.hash(generatedPassword, salt);
      teacherPayload.password = hashedPassword;

      const user = await User.findOneAndUpdate(
        { email: SMOKE_TEACHER_EMAIL },
        { $set: teacherPayload },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );

      console.log('✅ [LIVE RUN]: Dedicated Smoke Test Teacher account created / refreshed successfully:');
      console.log(`- Account ID     : ${user._id}`);
      console.log(`- Email Address  : ${SMOKE_TEACHER_EMAIL}`);
      console.log(`- Role           : ${user.role}`);
      console.log(`- Scope          : ${user.stream} / ${user.branch}`);
      console.log(`- isApproved     : ${user.isApproved}`);
      console.log(`- tokenVersion   : ${user.tokenVersion}`);
      console.log(`- mustChangePass : ${user.mustChangePassword}`);
      console.log('\n' + '='.repeat(75));
      console.log('🔑 [ONE-TIME LIVE SMOKE TEST TEACHER CREDENTIALS]');
      console.log('='.repeat(75));
      console.log(` Portal URL  : /login (Faculty / Teacher Tab)`);
      console.log(` Login Email : ${SMOKE_TEACHER_EMAIL}`);
      console.log(` Password    : ${generatedPassword}`);
      console.log(' NOTE        : This password is ONLY displayed here and is NOT saved in the repo.');
      console.log('='.repeat(75) + '\n');
    }
  } else if (mode === 'cleanup') {
    // 1. Locate the smoke teacher account
    const smokeTeacher = await User.findOne({ email: SMOKE_TEACHER_EMAIL });
    const teacherId = smokeTeacher ? smokeTeacher._id : null;

    // 2. Count matching documents across collections
    const userQuery = { email: SMOKE_TEACHER_EMAIL };
    const secEventQuery = teacherId
      ? { $or: [{ userId: teacherId }, { userEmail: SMOKE_TEACHER_EMAIL }] }
      : { userEmail: SMOKE_TEACHER_EMAIL };
    const emailReqQuery = teacherId
      ? { $or: [{ userId: teacherId }, { currentEmail: SMOKE_TEACHER_EMAIL }, { requestedEmail: SMOKE_TEACHER_EMAIL }] }
      : { $or: [{ currentEmail: SMOKE_TEACHER_EMAIL }, { requestedEmail: SMOKE_TEACHER_EMAIL }] };
    const notifQuery = teacherId
      ? { $or: [{ userId: teacherId }, { readBy: SMOKE_TEACHER_EMAIL }] }
      : { readBy: SMOKE_TEACHER_EMAIL };
    const auditQuery = teacherId
      ? { $or: [{ actorId: String(teacherId) }, { actorEmail: SMOKE_TEACHER_EMAIL }, { targetId: String(teacherId) }] }
      : { actorEmail: SMOKE_TEACHER_EMAIL };
    const doubtQuery = teacherId
      ? { $or: [{ 'assignedTeacher.id': teacherId }, { 'assignedTeacher.email': SMOKE_TEACHER_EMAIL }] }
      : { 'assignedTeacher.email': SMOKE_TEACHER_EMAIL };

    const [userCount, secCount, emailReqCount, notifCount, auditCount, doubtCount] = await Promise.all([
      User.countDocuments(userQuery),
      SecurityEvent.countDocuments(secEventQuery),
      EmailChangeRequest.countDocuments(emailReqQuery),
      Notification.countDocuments(notifQuery),
      AuditLog.countDocuments(auditQuery),
      Doubt.countDocuments(doubtQuery),
    ]);

    if (dryRun) {
      console.log('🔍 [DRY RUN CLEANUP AUDIT SUMMARY]:');
      console.log(`- Target Account           : ${SMOKE_TEACHER_EMAIL}`);
      console.log(`- User Records to Delete   : ${userCount}`);
      console.log(`- SecurityEvents to Delete : ${secCount}`);
      console.log(`- EmailRequests to Delete  : ${emailReqCount}`);
      console.log(`- Notifications to Clean   : ${notifCount}`);
      console.log(`- AuditLogs to Delete      : ${auditCount}`);
      console.log(`- Assigned Doubts to Clean : ${doubtCount}`);
      console.log('\n[DRY RUN]: Zero records deleted. Run without --dry-run to execute.');
    } else {
      const [delUser, delSec, delEmail, delNotif, delAudit, delDoubt] = await Promise.all([
        User.deleteMany(userQuery),
        SecurityEvent.deleteMany(secEventQuery),
        EmailChangeRequest.deleteMany(emailReqQuery),
        Notification.deleteMany(notifQuery),
        AuditLog.deleteMany(auditQuery),
        Doubt.deleteMany(doubtQuery),
      ]);

      console.log('🧹 [LIVE RUN CLEANUP AUDIT SUMMARY]:');
      console.log(`- Target Account        : ${SMOKE_TEACHER_EMAIL}`);
      console.log(`- User Records Deleted   : ${delUser.deletedCount}`);
      console.log(`- SecurityEvents Deleted : ${delSec.deletedCount}`);
      console.log(`- EmailRequests Deleted  : ${delEmail.deletedCount}`);
      console.log(`- Notifications Deleted  : ${delNotif.deletedCount}`);
      console.log(`- AuditLogs Deleted      : ${delAudit.deletedCount}`);
      console.log(`- Assigned Doubts Deleted: ${delDoubt.deletedCount}`);
      console.log('='.repeat(75));
      console.log('✅ Smoke teacher account and all related audit/security entries removed cleanly.');
    }
  }

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('❌ Error executing smoke accounts script:', err.message);
  process.exit(1);
});
