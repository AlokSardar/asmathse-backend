const mongoose = require('mongoose');

const classTestSchema = new mongoose.Schema({
  id: { type: String, index: true },
  testId: { type: String, index: true },
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
  fullMarks: { type: Number },
  totalMarks: { type: Number },
  passingMarks: { type: Number },
  status: { type: String, index: true },
  isDraft: { type: Boolean, default: false, index: true },
  questions: { type: Array, default: [] },
  questionPaperUrl: { type: String }, // PDF or image url

  // ── Tests & Schedule Module Additive Schema Fields ──
  startAt: { type: Date, index: true },
  endAt: { type: Date, index: true },
  scheduledTime: { type: String },
  scheduleEstimated: { type: Boolean, default: false },
  attemptsAllowed: { type: Number, default: 1 },
  instructions: { type: String },
  isArchived: { type: Boolean, default: false, index: true },
  archivedAt: { type: Date },
  isCancelled: { type: Boolean, default: false, index: true },
  cancelledAt: { type: Date },
  cancellationReason: { type: String },
  isDeleted: { type: Boolean, default: false, index: true },
  deletedAt: { type: Date, default: null, index: true },
  deletedBy: {
    id: { type: String },
    email: { type: String },
    role: { type: String },
  },
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
classTestSchema.index({ course: 1, branch: 1, semester: 1, startAt: 1, isArchived: 1, isDeleted: 1 });
classTestSchema.index({ isDeleted: 1, deletedAt: 1 });

module.exports = mongoose.model('ClassTest', classTestSchema);
