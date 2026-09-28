const mongoose = require('mongoose');

const activitySchema = new mongoose.Schema({
  id: { type: String, unique: true, sparse: true, index: true },
  studentId: { type: String, index: true },
  studentName: { type: String },
  studentEmail: { type: String },
  activityType: { type: String, required: true },
  description: { type: String },
  academicYear: { type: String },
  loggedAt: { type: Date, default: Date.now, index: true },
}, { 
  timestamps: true,
  strict: false 
});

module.exports = mongoose.model('Activity', activitySchema);
