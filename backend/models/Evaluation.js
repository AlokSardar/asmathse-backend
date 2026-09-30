const mongoose = require('mongoose');

const evaluationSchema = new mongoose.Schema({
  id: { type: String, unique: true, sparse: true, index: true },
  studentId: { type: String, index: true },
  studentName: { type: String },
  studentEmail: { type: String },
  testId: { type: String },
  testTitle: { type: String },
  course: { type: String },
  branch: { type: String },
  sem: { type: mongoose.Schema.Types.Mixed },
  classLevel: { type: String },
  subject: { type: String },
  score: { type: mongoose.Schema.Types.Mixed },
  marks: { type: mongoose.Schema.Types.Mixed },
  totalMarks: { type: Number },
  maxMarks: { type: Number, default: 50 },
  percentage: { type: Number },
  
  // Real Uploaded Handwritten Answer Sheet Storage
  answerSheetUrl: { type: String },
  answerSheetDataUrl: { type: String },
  fileName: { type: String },
  fileType: { type: String },
  
  // AI OCR Line Separation & Question Tagging Output
  lineSeparatorsDetected: { type: Number, default: 0 },
  questionBlocks: { type: mongoose.Schema.Types.Mixed, default: [] },
  allMistakes: { type: mongoose.Schema.Types.Mixed, default: [] },
  
  feedback: { type: String },
  mistakes: { type: [String], default: [] },
  hints: { type: String },
  metrics: { type: mongoose.Schema.Types.Mixed, default: [] },
  cheated: { type: Boolean, default: false },
  submittedAt: { type: Date, default: Date.now, index: true },
}, { 
  timestamps: true,
  strict: false 
});

module.exports = mongoose.model('Evaluation', evaluationSchema);
