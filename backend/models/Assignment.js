const mongoose = require('mongoose');

const assignmentSchema = new mongoose.Schema({
  title: { type: String, required: true },
  description: { type: String },
  stream: { type: String, enum: ['CS', 'ME', 'EE', 'CE'], required: true },
  semester: { type: Number, required: true },
  questionFileUrl: { type: String }, 
  deadline: { type: Date, required: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

module.exports = mongoose.model('Assignment', assignmentSchema);
