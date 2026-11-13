const express = require('express');
const router = express.Router();
const {
  protect,
  requireAdminOnly,
  requireTeacherOrAdmin,
} = require('../middleware/authMiddleware');
const {
  evaluationWorkspaceLimiter,
  evaluationSubmissionLimiter,
} = require('../middleware/securityMiddleware');
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
const {
  createOrUpdateMarkingScheme,
  getMarkingSchemeByExamId,
  getEvaluationWorkspace,
  acquireOrRefreshLock,
  releaseLock,
  saveEvaluationDraft,
  finalizeEvaluation,
  addAnnotation,
  deleteAnnotation,
  getAnnotations,
  getStudentAnnotations,
  publishEvaluation,
  bulkPublishEvaluations,
  requestReEvaluation,
  getStudentReEvaluationRequest,
  listReEvaluationRequests,
  getReEvaluationRequestById,
  resolveReEvaluationRequest,
  getAuditLogs,
  getScriptPages,
  streamPrivateScript,
  getExamsList,
  getSubmissionsQueue,
} = require('../controllers/evaluationHubController');
const { getWeeklyVolume } = require('../controllers/dashboardController');

// All evaluation endpoints require verified authentication
router.use(protect);

// ============================================================================
// 1. NON-PARAMETRIC / STATIC PREFIX ROUTES (Must precede /:id)
// ============================================================================

// Global evaluation lists (student sees own published/autoGraded; teacher/admin scoped)
router.get('/', getAllEvaluations);
router.get('/my-evaluations', getAllEvaluations);
router.get('/weekly-volume', requireTeacherOrAdmin, getWeeklyVolume);

// Workspace listings: exams & submissions queue
router.get('/exams', requireTeacherOrAdmin, getExamsList);
router.get('/submissions-queue', requireTeacherOrAdmin, getSubmissionsQueue);

// Proctoring
router.get('/proctoring-streams', requireTeacherOrAdmin, getActiveProctoringStreams);
router.post('/proctoring-stream', requireTeacherOrAdmin, updateProctoringStream);
router.post('/proctoring-video', requireTeacherOrAdmin, saveProctoringVideo);

// Marking Schemes
router.post('/marking-schemes', requireTeacherOrAdmin, evaluationSubmissionLimiter, createOrUpdateMarkingScheme);
router.get('/marking-schemes/:examId', requireTeacherOrAdmin, getMarkingSchemeByExamId);

// Re-Evaluation Requests (Dispute queue)
router.get('/re-evaluation-requests', requireTeacherOrAdmin, listReEvaluationRequests);
router.get('/re-evaluation-requests/:requestId', requireTeacherOrAdmin, evaluationWorkspaceLimiter, getReEvaluationRequestById);
router.patch('/re-evaluation-requests/:requestId', requireTeacherOrAdmin, evaluationWorkspaceLimiter, resolveReEvaluationRequest);

// Publishing & Legacy Batch
router.post('/bulk-publish', requireTeacherOrAdmin, evaluationWorkspaceLimiter, bulkPublishEvaluations);
router.post('/publish-results', requireTeacherOrAdmin, publishEvaluationResults);
router.post('/batch', requireTeacherOrAdmin, batchSyncEvaluations);
router.post('/evaluate-handwritten', requireTeacherOrAdmin, evaluateHandwrittenAnswerSheet);

// Admin-Only Batch Operations
router.post('/batch-delete', requireAdminOnly, deleteEvaluationsBatch);
router.delete('/', requireAdminOnly, clearAllEvaluations);

// ============================================================================
// 2. PARAMETRIC EVALUATION WORKSPACE & ACTIONS
// ============================================================================

// Teacher evaluation workspace data loading
router.get('/:id/workspace', requireTeacherOrAdmin, getEvaluationWorkspace);

// Concurrency locking with heartbeat (5 min TTL)
router.post('/:id/lock', requireTeacherOrAdmin, evaluationWorkspaceLimiter, acquireOrRefreshLock);
router.post('/:id/unlock', requireTeacherOrAdmin, evaluationWorkspaceLimiter, releaseLock);

// Versioned draft saves & finalization
router.patch('/:id/draft', requireTeacherOrAdmin, evaluationWorkspaceLimiter, saveEvaluationDraft);
router.post('/:id/finalize', requireTeacherOrAdmin, evaluationWorkspaceLimiter, finalizeEvaluation);

// Vector annotations
router.get('/:id/annotations', requireTeacherOrAdmin, getAnnotations);
router.get('/:id/student-annotations', getStudentAnnotations);
router.post('/:id/annotations', requireTeacherOrAdmin, evaluationWorkspaceLimiter, addAnnotation);
router.delete('/:id/annotations/:annotationId', requireTeacherOrAdmin, evaluationWorkspaceLimiter, deleteAnnotation);

// Publishing single evaluation
router.post('/:id/publish', requireTeacherOrAdmin, evaluationWorkspaceLimiter, publishEvaluation);

// Student re-evaluation dispute filing & status lookup
router.post('/:id/re-evaluate', evaluationSubmissionLimiter, requestReEvaluation);
router.get('/:id/re-evaluate', getStudentReEvaluationRequest);

// Audit logs
router.get('/:id/audit-logs', requireTeacherOrAdmin, getAuditLogs);

// Authenticated private script delivery (pages metadata & streaming)
router.get('/:id/pages', getScriptPages);
router.get('/:id/script-file', streamPrivateScript);

// ============================================================================
// 3. BASE CRUD (Single Evaluation)
// ============================================================================
router.get('/:id', getEvaluationById);
router.delete('/:id', requireAdminOnly, deleteEvaluationById);
router.post('/', evaluationSubmissionLimiter, saveEvaluation);

module.exports = router;
