const mongoose = require('mongoose');

const emailChangeRequestSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    currentEmail: { type: String, required: true },
    requestedEmail: { type: String, required: true, lowercase: true, trim: true },
    reason: { type: String, required: true, maxlength: 500 },
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected'],
      default: 'pending',
      index: true,
    },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    reviewedByName: { type: String },
    reviewedAt: { type: Date },
    rejectionReason: { type: String, maxlength: 500 },
  },
  {
    timestamps: true,
  }
);

emailChangeRequestSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model('EmailChangeRequest', emailChangeRequestSchema);
