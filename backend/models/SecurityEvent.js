const mongoose = require('mongoose');

const securityEventSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    userEmail: { type: String, index: true },
    userRole: { type: String, index: true },
    action: {
      type: String,
      required: true,
      enum: [
        'password_changed',
        'sessions_revoked',
        'profile_updated',
        'email_change_requested',
        'email_change_approved',
        'email_change_rejected',
        'password_reset_by_admin',
        'initial_password_set',
        'failed_password_attempt',
        'preferences_updated',
      ],
      index: true,
    },
    details: { type: mongoose.Schema.Types.Mixed, default: {} },
    ipAddress: { type: String, default: 'Unknown' },
    userAgent: { type: String, default: 'Unknown Device' },
    timestamp: { type: Date, default: Date.now, index: true },
  },
  {
    timestamps: false,
    strict: true,
  }
);

securityEventSchema.index({ userId: 1, timestamp: -1 });

module.exports = mongoose.model('SecurityEvent', securityEventSchema);
