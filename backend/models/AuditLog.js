const mongoose = require('mongoose');

const auditLogSchema = new mongoose.Schema({
  id: { type: String, unique: true, required: true, index: true },
  targetType: { 
    type: String, 
    enum: ['Evaluation', 'MarkingScheme', 'ReEvaluationRequest', 'EvaluationAnnotation'], 
    required: true, 
    index: true 
  },
  targetId: { type: String, required: true, index: true },
  action: { 
    type: String, 
    enum: [
      'draft_saved', 
      'marks_modified', 
      'lock_acquired', 
      'lock_released', 
      'evaluated', 
      'published', 
      'unpublished', 
      're_evaluation_requested', 
      're_evaluation_resolved',
      'admin_override',
      'version_conflict_override',
      'annotation_deleted'
    ], 
    required: true,
    index: true
  },
  actorId: { type: String, required: true, index: true },
  actorName: { type: String },
  actorRole: { type: String, required: true },
  actorEmail: { type: String },
  changes: { type: mongoose.Schema.Types.Mixed, default: {} },
  ipAddress: { type: String },
  userAgent: { type: String },
  timestamp: { type: Date, default: Date.now, index: true },
}, {
  timestamps: false,
  strict: true,
});

module.exports = mongoose.model('AuditLog', auditLogSchema);
