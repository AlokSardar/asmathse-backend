const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema(
  {
    id: { type: String, index: true },
    userId: { type: mongoose.Schema.Types.Mixed, index: true }, // Target user ID (student or teacher)
    title: { type: String, required: true },
    message: { type: String, required: true },
    type: {
      type: String,
      default: 'general',
      index: true,
    },
    doubtId: { type: mongoose.Schema.Types.ObjectId, ref: 'Doubt', index: true },
    resourceType: { type: String, default: 'document' },
    course: { type: String, index: true },
    branch: { type: String, index: true },
    semester: { type: mongoose.Schema.Types.Mixed },
    classLevel: { type: String, index: true },
    subject: { type: String },
    contentId: { type: String, index: true },
    readAt: { type: Date },
    readBy: { type: [String], default: [] }, // Array of user identifiers who marked read
    isRead: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now, index: true },
  },
  {
    timestamps: true,
    strict: false,
  }
);

notificationSchema.index({ userId: 1, isRead: 1, createdAt: -1 });
notificationSchema.index({ doubtId: 1, createdAt: -1 });

module.exports = mongoose.model('Notification', notificationSchema);
