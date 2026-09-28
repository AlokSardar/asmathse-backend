const mongoose = require('mongoose');

const submissionSchema = new mongoose.Schema({
  assignment: { type: mongoose.Schema.Types.ObjectId, ref: 'Assignment', required: true },
  student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  answerFileUrl: { type: String, required: true },
  status: { type: String, enum: ['pending', 'checked'], default: 'pending' },
  marksObtained: { type: Number },
  adminFeedback: { type: String }
}, { timestamps: true });

module.exports = mongoose.model('Submission', submissionSchema);
