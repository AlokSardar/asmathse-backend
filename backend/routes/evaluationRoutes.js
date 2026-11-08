const express = require('express');
const router = express.Router();
const {
  protect,
  requireAdminOnly,
  requireTeacherOrAdmin,
} = require('../middleware/authMiddleware');
const {
  getAllEvaluations,
  getEvaluationById,
  saveEvaluation,
  evaluateHandwrittenAnswerSheet,
  publishEvaluationResults,
  batchSyncEvaluations,
  clearAllEvaluations,
  deleteEvaluationById,
  deleteEvaluationsBatch,
  updateProctoringStream,
  getActiveProctoringStreams,
  saveProctoringVideo,
} = require('../controllers/evaluationController');

// All evaluation endpoints require verified authentication
router.use(protect);

// Student (own published only) & Faculty/Admin (scoped to course/branch) Read Routes
router.get('/', getAllEvaluations);
router.get('/my-evaluations', getAllEvaluations);
router.get('/proctoring-streams', requireTeacherOrAdmin, getActiveProctoringStreams);
router.post('/proctoring-stream', requireTeacherOrAdmin, updateProctoringStream);
router.post('/proctoring-video', requireTeacherOrAdmin, saveProctoringVideo);
router.get('/:id', getEvaluationById);

// Faculty & Admin Grading & Publishing Routes (strictly forbidden to students)
router.post('/', requireTeacherOrAdmin, saveEvaluation);
router.post('/evaluate-handwritten', requireTeacherOrAdmin, evaluateHandwrittenAnswerSheet);
router.post('/publish-results', requireTeacherOrAdmin, publishEvaluationResults);
router.post('/batch', requireTeacherOrAdmin, batchSyncEvaluations);

// Admin-Only Destructive Routes (strictly forbidden to students and teachers)
router.post('/batch-delete', requireAdminOnly, deleteEvaluationsBatch);
router.delete('/', requireAdminOnly, clearAllEvaluations);
router.delete('/:id', requireAdminOnly, deleteEvaluationById);

module.exports = router;
