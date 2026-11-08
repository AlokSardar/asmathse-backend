const mongoose = require('mongoose');

const markingSchemeSchema = new mongoose.Schema({
  id: { type: String, unique: true, required: true, index: true },
  examId: { type: String, required: true, index: true }, // References Content.id / testId
  examTitle: { type: String, required: true },
  course: { type: String, required: true, index: true },
  branch: { type: String, required: true, index: true },
  semester: { type: mongoose.Schema.Types.Mixed, required: true },
  subject: { type: String },
  totalMarks: { type: Number, required: true },
  passingMarks: { type: Number },
  instructions: { type: [String], default: [] },
  
  sections: [{
    sectionName: { type: String, required: true },
    description: { type: String },
    totalMarks: { type: Number, default: 0 },
  }],

  questions: [{
    questionNumber: { type: String, required: true }, // e.g. "1", "1(a)"
    subPart: { type: String },
    section: { type: String },
    questionText: { type: String },
    maxMarks: { type: Number, required: true },
    stepRubric: [{
      stepNumber: { type: Number, required: true },
      description: { type: String, required: true },
      marksAwarded: { type: Number, required: true },
    }],
    modelSolutionLatex: { type: String },
    acceptableVariations: { type: [String], default: [] },
    commonMistakes: [{
      mistake: { type: String },
      deduction: { type: Number, default: 0 },
    }],
  }],

  status: { 
    type: String, 
    enum: ['draft', 'published', 'archived'], 
    default: 'draft',
    index: true 
  },
  createdBy: { type: String, required: true },
  createdByName: { type: String },
}, {
  timestamps: true,
  strict: true,
});

module.exports = mongoose.model('MarkingScheme', markingSchemeSchema);
