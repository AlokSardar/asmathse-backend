const mongoose = require('mongoose');

const studentSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true, index: true },
  
  // Stream & Classification
  stream: { type: String, required: true }, // 'Engineering', 'BSc', 'JEE Mains & Advance', 'CBSE'
  branch: { type: String },
  semester: { type: mongoose.Schema.Types.Mixed },
  classLevel: { type: String },
  subject: { type: String },
  academicYear: { type: String, default: '2026-2027', index: true },
  
  // Contact details
  whatsapp: { type: String, required: true },
  studentWhatsapp: { type: String },
  fatherWhatsapp: { type: String, required: true },
  fatherContact: { type: String },
  
  // Auto-captured Registration Date & Onboarding Flag
  registrationDate: { type: Date, default: Date.now, index: true },
  profileCompleted: { type: Boolean, default: true },
  isApproved: { type: Boolean, default: false },
}, { 
  timestamps: true,
  strict: false 
});

module.exports = mongoose.model('Student', studentSchema);
