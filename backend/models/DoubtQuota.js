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
    totalSubmitted: {
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
    failuresByType: {
      type: Map,
      of: Number,
      default: () => new Map(),
    },
    fallbackQueries: {
      type: Number,
      default: 0,
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
    { returnDocument: 'after' }
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
 * Atomic reservation of student daily TOTAL submissions (AI + Direct-to-Teacher):
 * Enforces DAILY_STUDENT_TOTAL_DOUBT_LIMIT (default: 10).
 * Prevents flooding faculty queues during AI outages or direct-to-teacher bursts.
 */
doubtQuotaSchema.statics.reserveTotalStudentLimit = async function (studentId, limit = 10) {
  const today = new Date().toISOString().slice(0, 10);
  const studentKey = String(studentId);

  await StudentDailyQuota.updateOne(
    { date: today, studentId: studentKey },
    { $setOnInsert: { count: 0, totalSubmitted: 0 } },
    { upsert: true }
  );

  const updated = await StudentDailyQuota.findOneAndUpdate(
    { date: today, studentId: studentKey, totalSubmitted: { $lt: limit } },
    { $inc: { totalSubmitted: 1 } },
    { returnDocument: 'after' }
  );

  if (!updated) {
    const existing = await StudentDailyQuota.findOne({ date: today, studentId: studentKey });
    const current = existing ? (existing.totalSubmitted !== undefined ? existing.totalSubmitted : existing.count) : limit;
    return {
      allowed: false,
      current,
      limit,
      remaining: 0,
    };
  }

  return {
    allowed: true,
    current: updated.totalSubmitted,
    limit,
    remaining: Math.max(0, limit - updated.totalSubmitted),
  };
};

/**
 * Rollback student daily total submission count (e.g. if file validation fails before ticket is created)
 */
doubtQuotaSchema.statics.rollbackTotalStudentLimit = async function (studentId) {
  const today = new Date().toISOString().slice(0, 10);
  const studentKey = String(studentId);

  await StudentDailyQuota.updateOne(
    { date: today, studentId: studentKey, totalSubmitted: { $gt: 0 } },
    { $inc: { totalSubmitted: -1 } }
  );
};

/**
 * Atomic reservation & check of platform-wide global daily AI call cap:
 * Enforces GLOBAL_DAILY_AI_REQUEST_CAP (default: 40) across all Gemini calls (transcription + explanations + fallbacks).
 * When cap is reached, new doubts go straight to faculty queue with honest explanation.
 */
doubtQuotaSchema.statics.isGlobalAiCapReached = async function (cap = 40) {
  const today = new Date().toISOString().slice(0, 10);
  const record = await this.findOne({ date: today }).lean();
  const totalCalls = record ? (record.totalQueries || 0) : 0;
  return {
    capReached: totalCalls >= cap,
    totalCalls,
    cap,
    remaining: Math.max(0, cap - totalCalls),
  };
};

/**
 * Record a real executed Gemini API call in platform telemetry:
 * Counts every actual call including transcription attempts and fallback explanation attempts.
 */
doubtQuotaSchema.statics.recordAiCall = async function (modelName = 'gemini-3.8-flash', isFallback = false) {
  const today = new Date().toISOString().slice(0, 10);
  const safeModelKey = String(modelName).replace(/\./g, '_');

  const incUpdate = {
    totalQueries: 1,
    [`modelCounts.${safeModelKey}`]: 1,
  };
  if (isFallback) {
    incUpdate.fallbackQueries = 1;
  }

  await this.updateOne(
    { date: today },
    { $inc: incUpdate },
    { upsert: true }
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
doubtQuotaSchema.statics.recordSuccessfulQuery = async function (modelName = 'gemini-3.8-flash', isFallback = false) {
  const today = new Date().toISOString().slice(0, 10);
  const safeModelKey = String(modelName).replace(/\./g, '_');

  const incUpdate = {
    totalQueries: 1,
    [`modelCounts.${safeModelKey}`]: 1,
  };
  if (isFallback) {
    incUpdate.fallbackQueries = 1;
  }

  await this.updateOne(
    { date: today },
    { $inc: incUpdate },
    { upsert: true }
  );
};

/**
 * Record failure event in telemetry (e.g. 429 quota exhaustion, timeout, 5xx upstream)
 */
doubtQuotaSchema.statics.recordFailure = async function (failureType = '5xx') {
  const today = new Date().toISOString().slice(0, 10);
  const safeType = String(failureType).toLowerCase().replace(/[^a-z0-9]/g, '_');

  await this.updateOne(
    { date: today },
    {
      $inc: {
        [`failuresByType.${safeType}`]: 1,
      },
    },
    { upsert: true }
  );
};

doubtQuotaSchema.statics.getStudentUsageForDate = async function (dateStr) {
  const date = dateStr || new Date().toISOString().slice(0, 10);
  return StudentDailyQuota.find({ date }).sort({ count: -1 }).limit(50);
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
