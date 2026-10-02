const mongoose = require('mongoose');

const testSubmissionSchema = new mongoose.Schema({
  test: { type: mongoose.Schema.Types.Mixed },
  student: { type: mongoose.Schema.Types.Mixed },
  answerSheetUrl: { type: String },
  submittedAt: { type: Date, default: Date.now },
  cheatDetected: { type: Boolean, default: false },
  strikes: { type: Number, default: 0 },
  submittedDueToViolation: { type: Boolean, default: false },
  violationReason: { type: String },
  answers: { type: mongoose.Schema.Types.Mixed },
  isOnlineTest: { type: Boolean, default: false },
  aiEvaluation: {
    marksAwarded: { type: Number },
    totalMarks: { type: Number },
    feedback: { type: String },
    mistakes: [{ type: String }],
    evaluatedAt: { type: Date }
  },
  status: { type: String, enum: ['submitted', 'evaluating', 'evaluated'], default: 'submitted' }
}, {
  timestamps: true,
  strict: false
});

module.exports = mongoose.model('TestSubmission', testSubmissionSchema);
