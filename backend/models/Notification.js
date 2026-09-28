const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
  id: { type: String, unique: true, index: true },
  title: { type: String, required: true },
  message: { type: String, required: true },
  type: { 
    type: String, 
    enum: ['materials', 'syllabus', 'pyq', 'classtest', 'assignment', 'general'], 
    default: 'materials' 
  },
  resourceType: { type: String, default: 'document' },
  course: { type: String, index: true },
  branch: { type: String, index: true },
  semester: { type: mongoose.Schema.Types.Mixed },
  classLevel: { type: String, index: true },
  subject: { type: String },
  contentId: { type: String, index: true },
  readBy: { type: [String], default: [] }, // Array of student identifiers (email or id) who marked read
  createdAt: { type: Date, default: Date.now, index: true },
}, { 
  timestamps: true,
  strict: false 
});

module.exports = mongoose.model('Notification', notificationSchema);
