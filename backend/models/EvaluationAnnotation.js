const mongoose = require('mongoose');

const evaluationAnnotationSchema = new mongoose.Schema({
  id: { type: String, unique: true, required: true, index: true },
  evaluationId: { type: String, required: true, index: true },
  pageNumber: { type: Number, required: true, index: true },
  tool: { 
    type: String, 
    enum: ['pen', 'tick', 'cross', 'highlight', 'text', 'stamp'], 
    default: 'pen' 
  },
  color: { type: String, default: '#ef4444' },
  strokeWidth: { type: Number, default: 2 },
  
  // Bounded vector points: max 1000 coordinate pairs, normalized [0.0, 1.0]
  coordinates: {
    type: [{
      x: { type: Number, min: 0, max: 1 },
      y: { type: Number, min: 0, max: 1 },
    }],
    validate: [
      (val) => !val || val.length <= 1000,
      '{PATH} exceeds the limit of 1000 coordinate points'
    ],
    default: [],
  },

  content: { 
    type: String, 
    maxlength: 500, 
    default: '' 
  },
  
  authorId: { type: String, required: true },
  authorName: { type: String },
  authorRole: { type: String, required: true },
}, {
  timestamps: true,
  strict: true,
});

module.exports = mongoose.model('EvaluationAnnotation', evaluationAnnotationSchema);
