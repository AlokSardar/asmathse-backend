const mongoose = require('mongoose');

const reEvaluationRequestSchema = new mongoose.Schema({
  id: { type: String, unique: true, required: true, index: true },
  evaluationId: { type: String, required: true, index: true },
  testId: { type: String, required: true, index: true },
  testTitle: { type: String },
  studentId: { type: String, required: true, index: true },
  studentEmail: { type: String, required: true, index: true },
  studentName: { type: String },
  course: { type: String, index: true },
  branch: { type: String, index: true },
  semester: { type: mongoose.Schema.Types.Mixed },
  
  questionNumbers: { type: [String], default: [] },
  reason: { type: String, required: true, maxlength: 1000 },
  status: { 
    type: String, 
    enum: ['pending', 'under_review', 'approved', 'rejected'], 
    default: 'pending',
    index: true 
  },
  
  currentMarks: { type: Number },
  requestedAt: { type: Date, default: Date.now },
  
  reviewedBy: { type: String },
  reviewedByName: { type: String },
  reviewRemarks: { type: String, maxlength: 1000 },
  marksAdjustment: { type: Number, default: 0 },
  newMarks: { type: Number },
  resolvedAt: { type: Date },
}, {
  timestamps: true,
  strict: true,
});

module.exports = mongoose.model('ReEvaluationRequest', reEvaluationRequestSchema);
