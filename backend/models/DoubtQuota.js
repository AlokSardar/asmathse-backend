const mongoose = require('mongoose');

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
    studentCounts: {
      type: Map,
      of: Number,
      default: () => new Map(),
    },
  },
  { timestamps: true }
);

// Get or initialize today's record
doubtQuotaSchema.statics.getTodayRecord = async function () {
  const today = new Date().toISOString().slice(0, 10);
  let record = await this.findOne({ date: today });
  if (!record) {
    record = await this.create({
      date: today,
      totalQueries: 0,
      modelCounts: new Map(),
      studentCounts: new Map(),
    });
  }
  return record;
};

// Check if student has remaining quota
doubtQuotaSchema.statics.canStudentQuery = async function (studentId, limit = 5) {
  const record = await this.getTodayRecord();
  const studentKey = String(studentId);
  const current = record.studentCounts.get(studentKey) || 0;
  return {
    allowed: current < limit,
    current,
    limit,
    remaining: Math.max(0, limit - current),
  };
};

// Increment student query count
doubtQuotaSchema.statics.recordQuery = async function (studentId, modelName = 'default') {
  const record = await this.getTodayRecord();
  const studentKey = String(studentId);
  const currentStudent = record.studentCounts.get(studentKey) || 0;
  record.studentCounts.set(studentKey, currentStudent + 1);

  const currentModel = record.modelCounts.get(modelName) || 0;
  record.modelCounts.set(modelName, currentModel + 1);

  record.totalQueries += 1;
  await record.save();
  return record;
};

module.exports = mongoose.model('DoubtQuota', doubtQuotaSchema);
