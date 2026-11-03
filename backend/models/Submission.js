const mongoose = require('mongoose');

const submissionSchema = new mongoose.Schema({
  id: { type: String },
  assignment: { type: mongoose.Schema.Types.Mixed, required: true },
  assignmentId: { type: String },
  assignmentTitle: { type: String },
  student: { type: mongoose.Schema.Types.Mixed, required: true },
  studentId: { type: String },
  studentName: { type: String },
  studentEmail: { type: String },
  studentRoll: { type: String },
  answerFileUrl: { type: String },
  fileName: { type: String },
  fileSize: { type: String },
  notes: { type: String },
  course: { type: String },
  stream: { type: String },
  semester: { type: mongoose.Schema.Types.Mixed },
  status: { type: String, enum: ['submitted', 'pending', 'checked', 'graded'], default: 'submitted' },
  marksObtained: { type: Number },
  totalMarks: { type: Number, default: 20 },
  adminFeedback: { type: String },
  submittedAt: { type: Date, default: Date.now }
}, {
  timestamps: true,
  strict: false
});

module.exports = mongoose.model('Submission', submissionSchema);
