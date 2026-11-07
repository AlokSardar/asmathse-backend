const mongoose = require('mongoose');

// Sub-schema for atomic per-student daily limits
const studentDailyQuotaSchema = new mongoose.Schema(
  {
    date: {
      type: String, // YYYY-MM-DD
      required: true,
      index: true,
    },
    studentId: {
      type: String,
      required: true,
      index: true,
    },
    count: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  { timestamps: true }
);

studentDailyQuotaSchema.index({ date: 1, studentId: 1 }, { unique: true });

const StudentDailyQuota = mongoose.models.StudentDailyQuota || mongoose.model('StudentDailyQuota', studentDailyQuotaSchema);

// Schema for platform-wide telemetry & admin capacity monitoring
const doubtQuotaSchema = new mongoose.Schema(
  {
    date: {
      type: String, // YYYY-MM-DD
      required: true,
      unique: true,
      index: true,
    },
    totalQueries: {
      type: Number,
      default: 0,
    },
    modelCounts: {
      type: Map,
      of: Number,
      default: () => new Map(),
    },
  },
  { timestamps: true }
);

/**
 * Atomic reservation of student daily quota:
 * Uses findOneAndUpdate with condition { count: { $lt: limit } } and $inc: { count: 1 }.
 * Prevents race conditions during parallel submissions so student cannot exceed limit.
 */
doubtQuotaSchema.statics.reserveStudentQuota = async function (studentId, limit = 5) {
  const today = new Date().toISOString().slice(0, 10);
  const studentKey = String(studentId);

  // Ensure document exists
  await StudentDailyQuota.updateOne(
    { date: today, studentId: studentKey },
    { $setOnInsert: { count: 0 } },
    { upsert: true }
  );

  // Atomic conditional increment: only matches if count is strictly less than limit
  const updated = await StudentDailyQuota.findOneAndUpdate(
    { date: today, studentId: studentKey, count: { $lt: limit } },
    { $inc: { count: 1 } },
    { new: true }
  );

  if (!updated) {
    const existing = await StudentDailyQuota.findOne({ date: today, studentId: studentKey });
    const current = existing ? existing.count : limit;
    return {
      allowed: false,
      current,
      limit,
      remaining: 0,
    };
  }

  return {
    allowed: true,
    current: updated.count,
    limit,
    remaining: Math.max(0, limit - updated.count),
  };
};

/**
 * Rollback student daily quota if AI processing fails or is rejected:
 * Ensures student is never penalized for API failures, network dropouts, or content errors.
 */
doubtQuotaSchema.statics.rollbackStudentQuota = async function (studentId) {
  const today = new Date().toISOString().slice(0, 10);
  const studentKey = String(studentId);

  await StudentDailyQuota.updateOne(
    { date: today, studentId: studentKey, count: { $gt: 0 } },
    { $inc: { count: -1 } }
  );
};

/**
 * Read-only status check of student daily quota (without consuming)
 */
doubtQuotaSchema.statics.getStudentQuotaStatus = async function (studentId, limit = 5) {
  const today = new Date().toISOString().slice(0, 10);
  const studentKey = String(studentId);
  const existing = await StudentDailyQuota.findOne({ date: today, studentId: studentKey });
  const current = existing ? existing.count : 0;
  return {
    allowed: current < limit,
    current,
    limit,
    remaining: Math.max(0, limit - current),
  };
};

/**
 * Record a successful AI query in platform telemetry (strictly for admin monitoring, never hard-blocking)
 */
doubtQuotaSchema.statics.recordSuccessfulQuery = async function (modelName = 'gemini-3.8-flash') {
  const today = new Date().toISOString().slice(0, 10);
  const safeModelKey = String(modelName).replace(/\./g, '_');

  await this.updateOne(
    { date: today },
    {
      $inc: {
        totalQueries: 1,
        [`modelCounts.${safeModelKey}`]: 1,
      },
    },
    { upsert: true }
  );
};

// Backward compatibility methods
doubtQuotaSchema.statics.canStudentQuery = async function (studentId, limit = 5) {
  return this.getStudentQuotaStatus(studentId, limit);
};

doubtQuotaSchema.statics.getTodayRecord = async function () {
  const today = new Date().toISOString().slice(0, 10);
  let record = await this.findOne({ date: today });
  if (!record) {
    record = await this.create({
      date: today,
      totalQueries: 0,
      modelCounts: new Map(),
    });
  }
  return record;
};

module.exports = mongoose.model('DoubtQuota', doubtQuotaSchema);
