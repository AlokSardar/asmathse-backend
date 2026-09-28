const mongoose = require('mongoose');

const classTestSchema = new mongoose.Schema({
  title: { type: String, required: true },
  stream: { type: String, required: true },
  semester: { type: Number, required: true },
  durationMinutes: { type: Number, required: true },
  examDate: { type: Date, required: true },
  questionPaperUrl: { type: String }, // PDF or image url
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('ClassTest', classTestSchema);
