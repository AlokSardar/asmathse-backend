const mongoose = require('mongoose');

const materialDownloadSchema = new mongoose.Schema(
  {
    materialId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Content',
      required: true,
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    role: {
      type: String,
      required: true,
      default: 'student',
    },
    downloadedAt: {
      type: Date,
      default: Date.now,
      index: { expires: '90d' }, // Automatically purges after 90 days (Amendment 5)
    },
  },
  {
    timestamps: true,
  }
);

materialDownloadSchema.index({ materialId: 1, userId: 1, downloadedAt: -1 });

module.exports = mongoose.model('MaterialDownload', materialDownloadSchema);
