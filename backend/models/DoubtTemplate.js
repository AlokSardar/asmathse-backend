const mongoose = require('mongoose');

const doubtTemplateSchema = new mongoose.Schema(
  {
    teacher: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
    },
    category: {
      type: String,
      default: 'General',
      trim: true,
    },
    contentPlain: {
      type: String,
      default: '',
    },
    contentLatex: {
      type: String,
      default: '',
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('DoubtTemplate', doubtTemplateSchema);
