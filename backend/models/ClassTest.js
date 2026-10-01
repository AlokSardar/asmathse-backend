const mongoose = require('mongoose');

const classTestSchema = new mongoose.Schema({
  title: { type: String, required: true },
  stream: { type: String },
  course: { type: String, index: true },
  branch: { type: String, index: true },
  classLevel: { type: String, index: true },
  subject: { type: String, index: true },
  semester: { type: mongoose.Schema.Types.Mixed },
  durationMinutes: { type: Number },
  examDate: { type: Date },
  questionPaperUrl: { type: String }, // PDF or image url
  createdAt: { type: Date, default: Date.now }
}, {
  timestamps: true,
  strict: false
});

module.exports = mongoose.model('ClassTest', classTestSchema);
