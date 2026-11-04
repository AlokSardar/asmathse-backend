const mongoose = require('mongoose');

const importSessionSchema = new mongoose.Schema(
  {
    sessionId: { type: String, required: true, unique: true, index: true },
    fileName: { type: String, required: true },
    fileSize: { type: Number, default: 0 },
    fileSizeLabel: { type: String, default: '' },
    fileType: { type: String, default: 'application/pdf' },
    fileDataUrl: { type: String, default: '' }, // In-memory/base64 cache for interactive viewer
    course: { type: String, default: 'Engineering' },
    branch: { type: String, default: 'CSE' },
    semester: { type: String, default: 'Semester 1' },
    subject: { type: String, default: 'Applied Mathematics' },
    targetAudience: { type: String, default: 'all' },
    status: {
      type: String,
      enum: ['uploaded', 'processing', 'paused', 'completed', 'failed'],
      default: 'uploaded',
      index: true,
    },
    totalPages: { type: Number, default: 1 },
    processedPages: { type: Number, default: 0 },
    extractedCount: { type: Number, default: 0 },
    activePage: { type: Number, default: 1 },
    importedAt: { type: Date },
    lastImportedBatch: [{ type: String }], // Array of Content IDs for Undo support
    createdBy: { type: mongoose.Schema.Types.Mixed },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model('ImportSession', importSessionSchema);
