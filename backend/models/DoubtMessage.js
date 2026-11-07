const mongoose = require('mongoose');

const doubtMessageSchema = new mongoose.Schema(
  {
    doubt: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Doubt',
      required: true,
      index: true,
    },
    authorRole: {
      type: String,
      enum: ['student', 'ai', 'teacher', 'system'],
      required: true,
    },
    authorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    authorName: {
      type: String,
      required: true,
    },
    messageType: {
      type: String,
      enum: [
        'student_question',
        'initial_question',
        'transcription',
        'explanation',
        'followup',
        'teacher_reply',
        'system_event',
      ],
      required: true,
    },
    contentPlain: {
      type: String,
      default: '',
    },
    contentLatex: {
      type: String,
      default: '',
    },
    structuredSteps: [
      {
        stepNumber: { type: Number },
        title: { type: String },
        explanation: { type: String },
        math: { type: String },
      },
    ],
    conceptsUsed: [{ type: String }],
    finalAnswer: { type: String },
    quickCheck: { type: String },
    commonMistakes: [{ type: String }],
    attachments: [
      {
        url: { type: String },
        fileName: { type: String },
        mimeType: { type: String },
      },
    ],
    modelUsed: { type: String },
    isFallbackModel: { type: Boolean, default: false },
    disclaimer: { type: String },
    attempts: [
      {
        model: { type: String },
        durationMs: { type: Number },
        status: { type: String },
        error: { type: String },
        timestamp: { type: Date, default: Date.now },
      },
    ],
    helpfulRating: { type: Number, min: 1, max: 5 },
    createdAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

module.exports = mongoose.model('DoubtMessage', doubtMessageSchema);
