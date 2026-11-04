const mongoose = require('mongoose');

const importItemSchema = new mongoose.Schema(
  {
    sessionId: { type: String, required: true, index: true },
    itemId: { type: String, required: true, unique: true, index: true },
    pageNumber: { type: Number, required: true, index: true },
    itemNumber: { type: String, default: '1' },
    type: {
      type: String,
      enum: ['MCQ', 'Short', 'Long', 'True-False', 'Fill-blank', 'Subjective', 'Descriptive'],
      default: 'Subjective',
    },
    marks: { type: Number, default: 4 },
    marksRawLabel: { type: String, default: '' },
    question_latex: { type: String, required: true },
    options: [{ type: String }],
    correctOption: { type: Number, default: null },
    answer_latex: { type: String, default: '' },
    solution_latex: { type: String, default: '' },
    has_figure: { type: Boolean, default: false },
    figure_bbox: { type: mongoose.Schema.Types.Mixed, default: null },
    diagram_url: { type: String, default: '' },
    topic_guess: { type: String, default: 'Engineering Mathematics' },
    chapter_guess: { type: String, default: '' },
    difficulty_guess: {
      type: String,
      enum: ['Easy', 'Medium', 'Hard'],
      default: 'Medium',
    },
    confidence: { type: Number, default: 0.95 },
    warnings: [{ type: String }],
    
    // Granular Feature Toggles
    included: { type: Boolean, default: true, index: true },
    includeAnswer: { type: Boolean, default: true },
    includeSolution: { type: Boolean, default: true },
    includeMarks: { type: Boolean, default: true },
    includeDiagram: { type: Boolean, default: false },

    // Duplicate Detection & Resolution
    isDuplicate: { type: Boolean, default: false },
    duplicateMatchId: { type: String, default: '' },
    duplicateTitle: { type: String, default: '' },
    duplicateSimilarity: { type: Number, default: 0 },
    duplicateAction: {
      type: String,
      enum: ['skip', 'replace', 'import_anyway'],
      default: 'skip',
    },

    renderError: { type: Boolean, default: false },
  },
  {
    timestamps: true,
  }
);

importItemSchema.index({ sessionId: 1, pageNumber: 1 });

module.exports = mongoose.model('ImportItem', importItemSchema);
