const mongoose = require('mongoose');

const contentSchema = new mongoose.Schema({
  id: { type: String, unique: true, sparse: true, index: true },
  title: { type: String, required: true },
  type: { type: String, required: true, index: true }, // 'syllabus', 'materials', 'pyq', 'assignment', 'classtest', etc.
  course: { type: String, index: true }, // 'engineering', 'cbse', 'jee', 'bsc'
  stream: { type: String }, // alias / branch
  branch: { type: String, index: true }, // 'CSE', 'ECE', 'Class 9', 'JEE Main', etc.
  semester: { type: mongoose.Schema.Types.Mixed }, // Number or String
  classLevel: { type: String, index: true }, // 'Class 9', 'Class 12', etc.
  subject: { type: String, index: true }, // 'Mathematics', etc.
  academicYear: { type: String }, // '2026-2027', etc.
  description: { type: String },
  
  // Resource Type & YouTube Integration
  resourceType: { 
    type: String, 
    enum: ['document', 'pdf', 'docx', 'image', 'youtube', 'other'], 
    default: 'document',
    index: true 
  },
  videoUrl: { type: String },
  videoId: { type: String },
  thumbnailUrl: { type: String },

  // File hashing & local storage (Atlas Free Tier Optimization)
  fileHash: { type: String, index: true, sparse: true },
  filePath: { type: String },
  fileName: { type: String },
  fileSize: { type: String },
  fileType: { type: String },
  fileUrl: { type: String },
  fileDataUrl: { type: String }, // Retained if needed, but primary storage is fileUrl

  // PYQ & Question Specifics
  examName: { type: String },
  examYear: { type: String },
  questionText: { type: String },
  keyFormula: { type: String },
  steps: { type: mongoose.Schema.Types.Mixed, default: [] },
  finalAnswer: { type: String },
  topic: { type: String },
  marks: { type: mongoose.Schema.Types.Mixed },
  difficulty: { type: String },
  qType: { type: String },

  // Assignment & Test Specifics
  testId: { type: String, index: true }, // Unique Test_ID isolating test data
  deadline: { type: String },
  examDate: { type: String },
  duration: { type: mongoose.Schema.Types.Mixed },
  aiScore: { type: String },
  aiFeedback: { type: String },

  // Pre-Computed LaTeX Answer Key & Review Hub
  answerKey: {
    generatedBy: { type: String, default: 'Google Gemini API' },
    status: { type: String, enum: ['draft', 'locked'], default: 'draft' },
    solutionSet: { type: mongoose.Schema.Types.Mixed, default: [] },
    fullLatexDocument: { type: String },
    lockedAt: { type: Date },
    updatedAt: { type: Date },
  },
  publishedResults: { type: Boolean, default: false },

  // Upload metadata
  uploadedBy: { type: mongoose.Schema.Types.Mixed },
  uploadedAt: { type: Date, default: Date.now, index: true },
}, { 
  timestamps: true,
  strict: false 
});

module.exports = mongoose.model('Content', contentSchema);
