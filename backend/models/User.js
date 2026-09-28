const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  role: { type: String, enum: ['admin', 'student', 'Admin', 'Student'], default: 'student', required: true },
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  
  // Student contact & parent details
  mobile: { type: String },
  whatsapp: { type: String },
  studentWhatsapp: { type: String },
  fatherWhatsapp: { type: String },
  fatherContact: { type: String },

  // Academic classification
  stream: { type: String },
  targetCourse: { type: String },
  branch: { type: String },
  semester: { type: mongoose.Schema.Types.Mixed },
  classLevel: { type: String },
  subject: { type: String },
  academicYear: { type: String },
  
  // Mandatory Student Onboarding Tracking & Admin Approval
  profileCompleted: { type: Boolean, default: false },
  isApproved: { type: Boolean, default: false },
  registrationDate: { type: Date, default: Date.now },

  // Password Recovery / Reset
  resetPasswordToken: { type: String },
  resetPasswordExpire: { type: Date },
}, { timestamps: true });

// Match user entered password to hashed password in database
userSchema.methods.matchPassword = async function (enteredPassword) {
  if (!enteredPassword || !this.password) return false;
  // Direct match fallback or bcrypt compare
  if (this.password === enteredPassword) return true;
  try {
    return await bcrypt.compare(enteredPassword, this.password);
  } catch (err) {
    console.error('Password comparison error in matchPassword:', err.message);
    return false;
  }
};

// Encrypt password using bcrypt if modified and not already hashed
userSchema.pre('save', async function () {
  if (!this.isModified('password')) {
    return;
  }
  // Safeguard against double-hashing: check if password is already a valid bcrypt hash
  if (typeof this.password === 'string' && /^\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}$/.test(this.password)) {
    return;
  }
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
});

module.exports = mongoose.model('User', userSchema);
