/**
 * Idempotent Migration: User Approval Status
 *
 * Ensures all existing users (teachers, admins, and active students)
 * have approvalStatus: 'approved' and isActive: true.
 * Ensures unapproved students have approvalStatus: 'pending' and isActive: false.
 * Idempotent: Only touches users where approvalStatus does not exist or requires sync.
 */

const mongoose = require('mongoose');
const User = require('../models/User');
const { dbGuard } = require('../utils/dbGuard');

async function migrateApprovalStatus(options = {}) {
  try {
    // Assert safe DB environment unless allowProd is enabled
    try {
      dbGuard('migrateApprovalStatus', options);
    } catch (guardErr) {
      if (process.env.NODE_ENV === 'production' && !process.env.ALLOW_PROD_MIGRATION) {
        console.log('ℹ️ [MIGRATION NOTICE]: Running approvalStatus migration check in production...');
      } else {
        throw guardErr;
      }
    }

    if (mongoose.connection.readyState !== 1) {
      if (mongoose.connection.readyState === 0) {
        return { approvedCount: 0, pendingCount: 0, total: 0 };
      }
      await new Promise((resolve) => {
        if (mongoose.connection.readyState === 1) return resolve();
        mongoose.connection.once('open', resolve);
        mongoose.connection.once('connected', resolve);
      });
    }

    // 1. Identify users missing approvalStatus or requiring initial migration
    const unmigratedUsers = await User.find({
      $or: [
        { approvalStatus: { $exists: false } },
        { approvalStatus: null },
        { approvalStatus: '' },
        // Safety: Ensure any admin or teacher or pre-approved student is never left in 'pending'
        { role: { $in: ['admin', 'Admin', 'teacher', 'Teacher'] }, approvalStatus: { $ne: 'approved' } },
        { isApproved: true, approvalStatus: { $ne: 'approved' } },
      ],
    }).lean();

    if (!unmigratedUsers || unmigratedUsers.length === 0) {
      return { approvedCount: 0, pendingCount: 0, total: 0 };
    }

    let approvedCount = 0;
    let pendingCount = 0;

    for (const u of unmigratedUsers) {
      const roleLower = String(u.role || '').toLowerCase();
      const isFacultyOrApproved =
        roleLower === 'admin' ||
        roleLower === 'teacher' ||
        u.isApproved === true;

      if (isFacultyOrApproved) {
        await User.updateOne(
          { _id: u._id },
          {
            $set: {
              approvalStatus: 'approved',
              isApproved: true,
              isActive: true,
            },
          }
        );
        approvedCount++;
      } else {
        await User.updateOne(
          { _id: u._id },
          {
            $set: {
              approvalStatus: 'pending',
              isApproved: false,
              isActive: false,
            },
          }
        );
        pendingCount++;
      }
    }

    console.log(`Migration: ${approvedCount} users updated to approved, ${pendingCount} users set to pending.`);
    return { approvedCount, pendingCount, total: unmigratedUsers.length };
  } catch (err) {
    console.error('❌ [APPROVAL MIGRATION ERROR]:', err.message);
    return { error: err.message };
  }
}

// Support running directly from CLI: `node backend/scripts/migrateApprovalStatus.js`
if (require.main === module) {
  const dotenv = require('dotenv');
  dotenv.config();
  const connectDB = require('../config/db');

  connectDB().then(async () => {
    await migrateApprovalStatus({ allowProd: process.env.ALLOW_PROD_MIGRATION === 'true' });
    process.exit(0);
  }).catch((err) => {
    console.error('CLI Migration failed:', err);
    process.exit(1);
  });
}

module.exports = { migrateApprovalStatus };
