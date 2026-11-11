const mongoose = require('mongoose');

const pyqSolutionSchema = new mongoose.Schema(
  {
    language: {
      type: String,
      enum: ['english', 'bengali'],
      default: 'english',
    },
    steps: {
      type: [String],
      default: [],
    },
    finalAnswer: {
      type: String,
      default: '',
    },
    hasGraphic: {
      type: Boolean,
      default: false,
    },
    graphicDescription: {
      type: String,
      default: '',
    },
    graphicSvg: {
      type: String,
      default: '',
    },
  },
  { _id: false }
);

const pyqQuestionSchema = new mongoose.Schema(
  {
    questionNumber: {
      type: String,
      required: true,
      default: '1',
    },
    questionText: {
      type: String,
      required: true,
      default: '',
    },
    marks: {
      type: Number,
      default: 5,
    },
    unit: {
      type: String,
      default: 'General',
    },
    qType: {
      type: String,
      enum: ['MCQ', 'Subjective', 'Short', 'Long'],
      default: 'Subjective',
    },
    options: {
      type: [String],
      default: [],
    },
    correctOption: {
      type: Number,
      default: null,
    },
    solution: {
      type: pyqSolutionSchema,
      default: () => ({}),
    },
    isVerified: {
      type: Boolean,
      default: false,
    },
    teacherNote: {
      type: String,
      default: '',
    },
  },
  { _id: true }
);

const pyqPaperSchema = new mongoose.Schema(
  {
    // Identity
    title: {
      type: String,
      required: true,
      trim: true,
    },
    examBody: {
      type: String,
      required: true,
      trim: true,
      index: true,
      default: 'MAKAUT',
    },
    examYear: {
      type: Number,
      required: true,
      index: true,
    },
    examMonth: {
      type: String,
      trim: true,
      default: '',
    },
    paperCode: {
      type: String,
      trim: true,
      default: '',
    },

    // Cohort (normalized via cohortNormalize.js)
    course: {
      type: String,
      required: true,
      index: true,
      default: 'Engineering',
    },
    branch: {
      type: String,
      required: true,
      index: true,
      default: 'CSE',
    },
    semester: {
      type: String,
      required: true,
      index: true,
      default: 'Semester 1',
    },
    classLevel: {
      type: String,
      default: '',
    },
    subject: {
      type: String,
      required: true,
      index: true,
      default: 'Mathematics',
    },

    // Source File
    originalFileUrl: {
      type: String,
      required: true,
    },
    originalFileName: {
      type: String,
      required: true,
    },
    originalFileSize: {
      type: Number,
      default: 0,
    },
    pageCount: {
      type: Number,
      default: 1,
    },

    // Extraction & Solving state machine
    extractionStatus: {
      type: String,
      enum: [
        'pending',
        'extracting',
        'extracted',
        'solving',
        'solved',
        'review',
        'published',
        'archived',
      ],
      default: 'pending',
      index: true,
    },
    extractedAt: {
      type: Date,
    },
    solvedAt: {
      type: Date,
    },
    publishedAt: {
      type: Date,
    },

    // Embedded Questions Array
    questions: {
      type: [pyqQuestionSchema],
      default: [],
    },

    // Summary Counters & Statistics
    totalQuestions: {
      type: Number,
      default: 0,
    },
    totalMarks: {
      type: Number,
      default: 0,
    },
    solvedCount: {
      type: Number,
      default: 0,
    },
    verifiedCount: {
      type: Number,
      default: 0,
    },

    // Visibility & Lifecycle Settings
    visibility: {
      type: String,
      enum: ['draft', 'published', 'archived'],
      default: 'draft',
      index: true,
    },
    isDownloadable: {
      type: Boolean,
      default: true,
    },
    isDeleted: {
      type: Boolean,
      default: false,
      index: true,
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

// Compound Indexes for fast queries & cohort isolation
pyqPaperSchema.index({
  course: 1,
  branch: 1,
  semester: 1,
  examYear: -1,
  visibility: 1,
  isDeleted: 1,
});

pyqPaperSchema.index({
  examBody: 1,
  examYear: -1,
  isDeleted: 1,
});

pyqPaperSchema.index({
  extractionStatus: 1,
  isDeleted: 1,
});

module.exports = mongoose.model('PYQPaper', pyqPaperSchema, 'pyqpapers');
