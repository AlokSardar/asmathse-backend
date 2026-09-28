const Evaluation = require('../models/Evaluation');

// @desc    Get all student evaluations
// @route   GET /api/evaluations
// @access  Public
const getAllEvaluations = async (req, res) => {
  try {
    const { studentEmail, testId } = req.query;
    const query = {};
    if (studentEmail) query.studentEmail = studentEmail;
    if (testId) query.testId = testId;

    const evals = await Evaluation.find(query).sort({ submittedAt: -1, createdAt: -1 });
    res.json(evals);
  } catch (error) {
    console.error('Error fetching evaluations:', error);
    res.status(500).json({ message: error.message });
  }
};

// @desc    Save student evaluation
// @route   POST /api/evaluations
// @access  Public
const saveEvaluation = async (req, res) => {
  try {
    const data = req.body;
    const id = data.id || `eval_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    const payload = {
      ...data,
      id,
      submittedAt: data.submittedAt || new Date()
    };

    const saved = await Evaluation.findOneAndUpdate(
      { id },
      { $set: payload },
      { new: true, upsert: true, runValidators: false }
    );

    res.status(201).json(saved);
  } catch (error) {
    console.error('Error saving evaluation to MongoDB Atlas:', error);
    res.status(500).json({ message: error.message });
  }
};

// @desc    Batch sync student evaluations
// @route   POST /api/evaluations/batch
// @access  Public
const batchSyncEvaluations = async (req, res) => {
  try {
    const { items } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      return res.json({ count: 0, message: 'No evaluations provided' });
    }

    const ops = items.map((item) => {
      const id = item.id || `eval_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
      return {
        updateOne: {
          filter: { id },
          update: { $set: { ...item, id, submittedAt: item.submittedAt || new Date() } },
          upsert: true
        }
      };
    });

    const result = await Evaluation.bulkWrite(ops);
    res.json({
      success: true,
      upsertedCount: result.upsertedCount,
      modifiedCount: result.modifiedCount
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Clear all evaluations
// @route   DELETE /api/evaluations
// @access  Public
const clearAllEvaluations = async (req, res) => {
  try {
    await Evaluation.deleteMany({});
    res.json({ success: true, message: 'All evaluations cleared from MongoDB Atlas' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  getAllEvaluations,
  saveEvaluation,
  batchSyncEvaluations,
  clearAllEvaluations
};
