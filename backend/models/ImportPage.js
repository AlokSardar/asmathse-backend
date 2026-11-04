const mongoose = require('mongoose');

const importPageSchema = new mongoose.Schema(
  {
    sessionId: { type: String, required: true, index: true },
    pageNumber: { type: Number, required: true, index: true },
    status: {
      type: String,
      enum: ['pending', 'extracting', 'done', 'error', 'needs_review'],
      default: 'pending',
      index: true,
    },
    thumbnailUrl: { type: String, default: '' },
    pageDataUrl: { type: String, default: '' }, // Single-page base64 data for isolated OCR & fast thumbnail display
    extractedCount: { type: Number, default: 0 },
    errorMessage: { type: String, default: '' },
    retries: { type: Number, default: 0 },
    processedAt: { type: Date },
  },
  {
    timestamps: true,
  }
);

importPageSchema.index({ sessionId: 1, pageNumber: 1 }, { unique: true });

module.exports = mongoose.model('ImportPage', importPageSchema);
