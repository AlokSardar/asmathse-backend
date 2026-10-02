const express = require('express');
const router = express.Router();
const {
  getAllEvaluations,
  getEvaluationById,
  saveEvaluation,
  evaluateHandwrittenAnswerSheet,
  publishEvaluationResults,
  batchSyncEvaluations,
  clearAllEvaluations,
} = require('../controllers/evaluationController');

router.get('/', getAllEvaluations);
router.get('/:id', getEvaluationById);
router.post('/', saveEvaluation);
router.post('/evaluate-handwritten', evaluateHandwrittenAnswerSheet);
router.post('/publish-results', publishEvaluationResults);
router.post('/batch', batchSyncEvaluations);
router.delete('/', clearAllEvaluations);

module.exports = router;
