const mongoose = require('mongoose');

const testSubmissionSchema = new mongoose.Schema({
  test: { type: mongoose.Schema.Types.ObjectId, ref: 'ClassTest', required: true },
  student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  answerSheetUrl: { type: String, required: true },
  submittedAt: { type: Date, default: Date.now },
  cheatDetected: { type: Boolean, default: false },
  aiEvaluation: {
    marksAwarded: { type: Number },
    totalMarks: { type: Number },
    feedback: { type: String },
    mistakes: [{ type: String }],
    evaluatedAt: { type: Date }
  },
  status: { type: String, enum: ['submitted', 'evaluating', 'evaluated'], default: 'submitted' }
});

module.exports = mongoose.model('TestSubmission', testSubmissionSchema);
