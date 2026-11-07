const mongoose = require('mongoose');

const doubtFaqSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    topic: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    chapter: {
      type: String,
      trim: true,
    },
    subject: {
      type: String,
      default: 'Mathematics',
    },
    course: {
      type: String,
      required: true,
      index: true,
    },
    branch: {
      type: String,
      required: true,
      index: true,
    },
    semester: {
      type: mongoose.Schema.Types.Mixed,
    },
    solutionPlain: {
      type: String,
      required: true,
    },
    solutionLatex: {
      type: String,
      default: '',
    },
    verifiedByTeacherName: {
      type: String,
      required: true,
    },
    verifiedByTeacherId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    originalDoubtId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Doubt',
    },
    viewCount: {
      type: Number,
      default: 0,
    },
    helpfulCount: {
      type: Number,
      default: 0,
    },
    tags: [{ type: String, trim: true }],
  },
  { timestamps: true }
);

// Full-text search index on question title, topic, and solution
doubtFaqSchema.index({ title: 'text', topic: 'text', solutionPlain: 'text' });
doubtFaqSchema.index({ course: 1, branch: 1, topic: 1 });

module.exports = mongoose.model('DoubtFaq', doubtFaqSchema);
