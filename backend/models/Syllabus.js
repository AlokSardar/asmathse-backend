const mongoose = require('mongoose');

const moduleSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    moduleNumber: { type: Number, required: true },
    title: { type: String, required: true, trim: true },
    hours: { type: Number, default: 8 },
    topics: { type: [String], default: [] },
    learningOutcomes: { type: [String], default: [] },
    completedTopics: { type: [String], default: [] }, // Amendment 1: Topic completion tracking
  },
  { _id: false }
);

const textbookSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    author: { type: String, default: '' },
    edition: { type: String, default: '' },
    type: { type: String, enum: ['prescribed', 'reference'], default: 'prescribed' },
  },
  { _id: false }
);

const examPatternSchema = new mongoose.Schema(
  {
    internalAssessment: { type: Number, default: 30 },
    midSemester: { type: Number, default: 20 },
    endSemester: { type: Number, default: 50 },
  },
  { _id: false }
);

const syllabusSchema = new mongoose.Schema(
  {
    subjectName: { type: String, required: true, trim: true },
    subjectCode: { type: String, required: true, trim: true, index: true },
    credits: { type: Number, default: 4 },
    totalMarks: { type: Number, default: 100 },
    totalHours: { type: Number, default: 40 },
    academicYear: { type: String, default: '2026-2027' },
    description: { type: String, default: '' },

    // Cohort targeting
    course: { type: String, required: true, index: true },
    branch: { type: String, default: '', index: true },
    semester: { type: mongoose.Schema.Types.Mixed, required: true, index: true },
    classLevel: { type: String },
    isCommon: { type: Boolean, default: false },

    // Structured syllabus sections
    modules: { type: [moduleSchema], default: [] },
    textbooks: { type: [textbookSchema], default: [] },
    examPattern: { type: examPatternSchema, default: () => ({}) },

    // Official syllabus PDF attachment (Amendment 5)
    attachmentUrl: { type: String, default: '' },
    attachmentName: { type: String, default: '' },
    attachmentSize: { type: Number, default: 0 },

    // Visibility & Lifecycle
    visibility: {
      type: String,
      enum: ['published', 'draft', 'archived'],
      default: 'published',
      index: true,
    },
    isDeleted: { type: Boolean, default: false, index: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Virtual: calculate total completed topics across all modules
syllabusSchema.virtual('completionStats').get(function () {
  const mods = this.modules || [];
  let totalTopics = 0;
  let completedCount = 0;

  for (const m of mods) {
    const tCount = (m.topics || []).length;
    const cCount = (m.completedTopics || []).length;
    totalTopics += tCount;
    completedCount += cCount;
  }

  const percentage = totalTopics > 0 ? Math.round((completedCount / totalTopics) * 100) : 0;
  return {
    totalTopics,
    completedTopics: completedCount,
    percentage,
  };
});

// Compound index for performant cohort syllabus queries
syllabusSchema.index({
  course: 1,
  branch: 1,
  semester: 1,
  subjectCode: 1,
  visibility: 1,
  isDeleted: 1,
});

module.exports = mongoose.model('Syllabus', syllabusSchema);
