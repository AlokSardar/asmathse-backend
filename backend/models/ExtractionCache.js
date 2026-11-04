const mongoose = require('mongoose');

const extractionCacheSchema = new mongoose.Schema(
  {
    cacheKey: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    sha256: {
      type: String,
      required: true,
      index: true,
    },
    pageNumber: {
      type: Number,
      required: true,
    },
    modelName: {
      type: String,
      default: 'gemini-3.5-flash',
    },
    promptVersion: {
      type: String,
      default: 'v2-ocr-pure',
    },
    items: {
      type: Array,
      default: [],
    },
    rawResponse: {
      type: String,
      default: '',
    },
    createdAt: {
      type: Date,
      default: Date.now,
      expires: 60 * 60 * 24 * 7, // 7 days TTL
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('ExtractionCache', extractionCacheSchema);
