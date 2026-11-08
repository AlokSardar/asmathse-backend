const mongoose = require('mongoose');

const evaluationSchema = new mongoose.Schema({
  id: { type: String, unique: true, sparse: true, index: true },
  studentId: { type: String, index: true },
  studentName: { type: String },
  studentEmail: { type: String, index: true },
  studentRoll: { type: String },
  rollNumber: { type: String },
  testId: { type: String, index: true },
  testTitle: { type: String },
  examId: { type: String, index: true },
  examTitle: { type: String },
  examType: { type: String, default: 'Written / Upload', index: true },
  course: { type: String, index: true },
  branch: { type: String, index: true },
  sem: { type: mongoose.Schema.Types.Mixed },
  semester: { type: mongoose.Schema.Types.Mixed },
  classLevel: { type: String },
  subject: { type: String },
  
  // Marks & Grading
  score: { type: mongoose.Schema.Types.Mixed },
  marks: { type: mongoose.Schema.Types.Mixed },
  marksObtained: { type: Number },
  totalMarks: { type: Number },
  maxMarks: { type: Number, default: 50 },
  percentage: { type: Number },
  grade: { type: String },
  status: { type: String, default: 'Pending Evaluation', index: true },

  // Phase 1: On-Screen Marking & Rubrics
  markingSchemeId: { type: String, index: true },
  evaluationMode: { 
    type: String, 
    enum: ['manual_on_screen', 'ai_assisted', 'hybrid'], 
    default: 'manual_on_screen' 
  },
  evaluationStatus: { 
    type: String, 
    enum: ['pending', 'in_progress', 'evaluated', 'published'], 
    default: 'pending',
    index: true 
  },
  version: { type: Number, default: 0 }, // Optimistic concurrency lock counter
  lockedBy: {
    userId: { type: String },
    name: { type: String },
    role: { type: String },
    lockedAt: { type: Date },
    expiresAt: { type: Date },
  },
  questionMarks: [{
    questionNumber: { type: String, required: true },
    subPart: { type: String },
    maxMarks: { type: Number, default: 10 },
    marksAwarded: { type: Number, default: 0 },
    notAttempted: { type: Boolean, default: false },
    stepMarks: [{
      stepNumber: { type: Number },
      marksAwarded: { type: Number },
      comment: { type: String }
    }],
    remarks: { type: String },
    teacherFeedback: { type: String }
  }],
  pageEvaluations: [{
    pageNumber: { type: Number, required: true },
    marksAwarded: { type: Number, default: 0 },
    remarks: { type: String }
  }],
  evaluatedBy: { type: String },
  evaluatedByName: { type: String },
  evaluatedAt: { type: Date },
  
  // Real Uploaded Handwritten Answer Sheet Storage
  answerSheetUrl: { type: String },
  answerSheetDataUrl: { type: String },
  privateScriptUrl: { type: String }, // Authenticated / private streaming path
  answerPages: { type: mongoose.Schema.Types.Mixed, default: [] },
  totalPages: { type: Number, default: 1 },
  fileName: { type: String },
  fileType: { type: String },
  
  feedback: { type: String },
  mistakes: { type: [String], default: [] },
  hints: { type: String },
  metrics: { type: mongoose.Schema.Types.Mixed, default: [] },
  breakdown: { type: mongoose.Schema.Types.Mixed, default: [] },
  correctCount: { type: Number, default: 0 },
  attemptedCount: { type: Number, default: 0 },
  totalQuestions: { type: Number, default: 0 },
  submissionReason: { type: String },
  strikesRecorded: { type: Number, default: 0 },
  cheated: { type: Boolean, default: false },
  
  // Strict student visibility & publication
  autoGraded: { type: Boolean, default: false, index: true },
  published: { type: Boolean, default: false, index: true },
  publishedAt: { type: Date },
  publishedBy: { type: String },
  answerKeySnapshot: { type: mongoose.Schema.Types.Mixed },
  submittedAt: { type: Date, default: Date.now, index: true },
}, { 
  timestamps: true,
  strict: false 
});

module.exports = mongoose.model('Evaluation', evaluationSchema);
