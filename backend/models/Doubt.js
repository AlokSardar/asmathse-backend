const mongoose = require('mongoose');

const doubtSchema = new mongoose.Schema(
  {
    doubtCode: {
      type: String,
      unique: true,
      index: true,
      required: true,
    },
    student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    studentName: { type: String, required: true },
    studentEmail: { type: String, required: true, index: true },
    studentRoll: { type: String },

    // Academic Context
    course: { type: String, required: true, index: true },
    branch: { type: String, required: true, index: true },
    semester: { type: mongoose.Schema.Types.Mixed, required: true },
    subject: { type: String, default: 'Mathematics' },
    topic: { type: String, required: true, index: true },
    title: { type: String, required: true },
    language: { type: String, enum: ['en', 'bn'], default: 'en' },

    // Lifecycle Status
    status: {
      type: String,
      enum: [
        'draft',
        'processing',
        'transcribed',
        'ai_answered',
        'followup_pending',
        'escalated',
        'teacher_assigned',
        'teacher_answered',
        'clarification_requested',
        'resolved',
        'reopened',
        'closed',
        'error',
      ],
      default: 'processing',
      index: true,
    },
    priority: {
      type: String,
      enum: ['low', 'normal', 'high'],
      default: 'normal',
      index: true,
    },

    // Escalation & Faculty Assignment
    assignedTeacher: {
      id: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      name: { type: String },
      email: { type: String },
      assignedAt: { type: Date },
    },
    escalationReason: { type: String },
    escalatedAt: { type: Date },

    // Secure Attachments (Never raw public links)
    attachments: [
      {
        url: { type: String, default: '' },
        base64Data: { type: String },
        publicId: { type: String },
        fileName: { type: String },
        mimeType: { type: String },
        size: { type: Number },
        storageType: {
          type: String,
          enum: ['cloudinary', 'local', 'private_stream'],
          default: 'private_stream',
        },
      },
    ],

    // Stage 1: Problem Transcription
    aiTranscription: {
      problemText: { type: String, default: '' },
      latexEquation: { type: String, default: '' },
      confidence: { type: Number, default: 1.0 },
      warnings: [{ type: String }],
      needsClarification: { type: Boolean, default: false },
      clarifyingQuestion: { type: String, default: '' },
      confirmedByUser: { type: Boolean, default: false },
      transcribedAt: { type: Date },
      modelUsed: { type: String },
      attempts: [
        {
          model: { type: String },
          durationMs: { type: Number },
          status: { type: String },
          error: { type: String },
          timestamp: { type: Date, default: Date.now },
        },
      ],
    },

    // Stage 2: AI Explanation
    aiExplanation: {
      summary: { type: String },
      conceptsUsed: [{ type: String }],
      steps: [
        {
          stepNumber: { type: Number },
          title: { type: String },
          explanation: { type: String },
          math: { type: String },
        },
      ],
      finalAnswer: { type: String },
      quickCheck: { type: String },
      commonMistakes: [{ type: String }],
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
      generatedAt: { type: Date },
    },

    // Resolution & Counters
    resolvedAt: { type: Date },
    resolvedBy: { type: String, enum: ['student', 'teacher', 'ai'] },
    slaDueAt: { type: Date },
    slaDeadline: { type: Date, index: true },
    clarificationPrompt: { type: String },
    clarificationRequestedAt: { type: Date },
    followupCount: { type: Number, default: 0 },
    reopenCount: { type: Number, default: 0 },
    unreadByStudent: { type: Boolean, default: false },
    unreadByTeacher: { type: Boolean, default: false },

    // Audit Trail
    auditTrail: [
      {
        status: { type: String, required: true },
        changedBy: { type: String, required: true },
        role: { type: String, required: true },
        timestamp: { type: Date, default: Date.now },
        note: { type: String },
      },
    ],

    lastErrorMessage: { type: String },
  },
  { timestamps: true }
);

// Pre-validate hook to generate human-readable Doubt Code & attachment URLs
doubtSchema.pre('validate', async function () {
  if (!this.doubtCode) {
    const yearSuffix = new Date().getFullYear().toString().slice(-2);
    const randomSuffix = Math.random().toString(36).substring(2, 6).toUpperCase();
    const count = await this.constructor.countDocuments();
    const seq = String(count + 1).padStart(4, '0');
    this.doubtCode = `DBT-${yearSuffix}-${seq}-${randomSuffix}`;
  }
  if (Array.isArray(this.attachments)) {
    this.attachments.forEach((att, idx) => {
      if (!att.url) {
        att.url = `/api/doubts/${this._id}/attachments/${idx}`;
      }
    });
  }
});

// Generate human-readable Doubt Code
doubtSchema.statics.generateDoubtCode = async function () {
  const yearSuffix = new Date().getFullYear().toString().slice(-2);
  const randomSuffix = Math.random().toString(36).substring(2, 6).toUpperCase();
  const count = await this.countDocuments();
  const seq = String(count + 1).padStart(4, '0');
  return `DBT-${yearSuffix}-${seq}-${randomSuffix}`;
};

module.exports = mongoose.model('Doubt', doubtSchema);
