const express = require('express');
const router = express.Router();
const {
  getAllEvaluations,
  saveEvaluation,
  batchSyncEvaluations,
  clearAllEvaluations,
} = require('../controllers/evaluationController');

router.get('/', getAllEvaluations);
router.post('/', saveEvaluation);
router.post('/batch', batchSyncEvaluations);
router.delete('/', clearAllEvaluations);

module.exports = router;
