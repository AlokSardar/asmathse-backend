const mongoose = require('mongoose');

const classTestSchema = new mongoose.Schema({
  title: { type: String, required: true },
  stream: { type: String },
  course: { type: String, index: true },
  board: { type: String, index: true },
  class: { type: String, index: true },
  class_name: { type: String, index: true },
  classNumber: { type: Number, index: true },
  branch: { type: String, index: true },
  classLevel: { type: String, index: true },
  subject: { type: String, index: true },
  semester: { type: mongoose.Schema.Types.Mixed },
  isCommon: { type: Boolean, default: false, index: true },
  targetScope: { type: String, index: true },
  isCommonFirstYear: { type: Boolean, default: false, index: true },
  targetAudience: { type: String, index: true },
  durationMinutes: { type: Number },
  examDate: { type: Date },
  questionPaperUrl: { type: String }, // PDF or image url

  // ── Tests & Schedule Module Additive Schema Fields ──
  startAt: { type: Date, index: true },
  endAt: { type: Date, index: true },
  scheduledTime: { type: String },
  scheduleEstimated: { type: Boolean, default: false },
  attemptsAllowed: { type: Number, default: 1 },
  isArchived: { type: Boolean, default: false, index: true },
  archivedAt: { type: Date },
  isCancelled: { type: Boolean, default: false, index: true },
  cancelledAt: { type: Date },
  cancellationReason: { type: String },
  rescheduleHistory: [{
    previousStart: { type: Date },
    previousEnd: { type: Date },
    newStart: { type: Date },
    newEnd: { type: Date },
    reason: { type: String },
    rescheduledBy: { type: String },
    rescheduledAt: { type: Date, default: Date.now },
  }],

  createdAt: { type: Date, default: Date.now }
}, {
  timestamps: true,
  strict: false
});

// Optimized Compound Index for Tests & Schedule filtering and ordering
classTestSchema.index({ course: 1, branch: 1, semester: 1, startAt: 1, isArchived: 1 });

module.exports = mongoose.model('ClassTest', classTestSchema);
