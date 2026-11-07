const express = require('express');
const router = express.Router();
const {
  protect,
  requireAdmin,
  authorize,
} = require('../middleware/authMiddleware');
const {
  doubtLimiter,
  doubtGeneralLimiter,
  analyticsLimiter,
} = require('../middleware/securityMiddleware');
const { upload } = require('../middleware/uploadMiddleware');
const {
  askDoubt,
  confirmTranscription,
  askFollowup,
  escalateDoubt,
  resolveDoubt,
  reopenDoubt,
  claimDoubt,
  unclaimDoubt,
  reassignDoubt,
  requestClarification,
  respondToClarification,
  submitTeacherReply,
  getMyDoubts,
  getTeacherQueue,
  getDoubtById,
  getQuotaStatus,
  getAttachment,
  getTemplates,
  createTemplate,
  deleteTemplate,
  getDoubtNotifications,
  markDoubtNotificationRead,
  markAllDoubtNotificationsRead,
  getAnalyticsOverview,
  getAdminCapacity,
  exportDoubtsCsv,
  publishFaqEntry,
  searchFaqsAndSimilar,
  rateDoubtSolution,
} = require('../controllers/doubtController');

/**
 * Role-segregation helper for student routes:
 * Allows accounts with role 'student' (or 'admin' for system maintenance/testing),
 * while strictly blocking 'teacher' or unauthorized roles from polluting student submissions.
 */
const requireStudent = [
  protect,
  (req, res, next) => {
    const role = String(req.user?.role || '').toLowerCase();
    if (!['student', 'admin'].includes(role)) {
      return res.status(403).json({
        success: false,
        message: `Forbidden: Accounts with role "${role}" cannot perform student doubt operations.`,
      });
    }
    next();
  },
];

// Optional multer handler that safely ignores non-multipart requests
const optionalFileUpload = (req, res, next) => {
  const contentType = req.headers['content-type'] || '';
  if (contentType.includes('multipart/form-data')) {
    upload.array('files', 5)(req, res, (err) => {
      if (err) {
        return res.status(400).json({ success: false, message: `Upload error: ${err.message}` });
      }
      next();
    });
  } else {
    next();
  }
};

// ── Student Doubt Lifecycle Endpoints ──────────────────────────────────────────

// 1. Submit a new doubt (typed or photo/PDF)
router.post('/ask', doubtLimiter, requireStudent, optionalFileUpload, askDoubt);

// ── Shared Collections & Preferences (Before /:id) ───────────────────────────

// 7. Get student's doubts list (with filters)
router.get('/my', doubtGeneralLimiter, requireStudent, getMyDoubts);

// 8. Check student's daily quota status and remaining limits
router.get('/quota', doubtGeneralLimiter, protect, getQuotaStatus);

// 8b. Anonymized FAQs & Similar Doubts Search
router.get('/search-faqs', doubtGeneralLimiter, protect, searchFaqsAndSimilar);

// 8c. Analytics, Capacity & Reporting Endpoints (Teacher / Admin)
router.get('/analytics/overview', doubtGeneralLimiter, requireAdmin, getAnalyticsOverview);
router.get('/analytics/capacity', doubtGeneralLimiter, requireAdmin, getAdminCapacity);
router.get('/analytics/export', analyticsLimiter, requireAdmin, exportDoubtsCsv);

// 9. Faculty Saved Templates CRUD
router.get('/templates', doubtGeneralLimiter, requireAdmin, getTemplates);
router.post('/templates', doubtLimiter, requireAdmin, createTemplate);
router.delete('/templates/:id', doubtLimiter, requireAdmin, deleteTemplate);

// 10. Doubts Notification Stream & Acknowledgment
router.get('/notifications', doubtGeneralLimiter, protect, getDoubtNotifications);
router.put('/notifications/read-all', protect, markAllDoubtNotificationsRead);
router.put('/notifications/:id/read', protect, markDoubtNotificationRead);

// 11. Fetch teacher review queue (filtered by teacher's assigned course/branch; admin sees all)
router.get('/teacher/queue', doubtGeneralLimiter, requireAdmin, getTeacherQueue);


// ── Specific Ticket Operations (Parameterized by :id) ──────────────────────────

// 12. Confirm or edit Stage 1 transcription (for image doubts)
router.post('/:id/confirm-transcription', doubtLimiter, requireStudent, confirmTranscription);

// 13. Ask a pedagogical follow-up question (up to 3 in thread)
router.post('/:id/followup', doubtLimiter, requireStudent, askFollowup);

// 14. Student responds to faculty clarification request
router.post('/:id/respond-clarification', requireStudent, respondToClarification);

// 15. Escalate to teacher queue (with 24h SLA)
router.post('/:id/escalate', requireStudent, escalateDoubt);

// 16. Mark doubt as resolved (student owner or faculty)
router.post('/:id/resolve', protect, resolveDoubt);

// 17. Reopen a resolved doubt (up to 1 time)
router.post('/:id/reopen', requireStudent, reopenDoubt);

// 18. Faculty claims an escalated doubt ticket (atomic race guard)
router.post('/:id/claim', requireAdmin, claimDoubt);

// 19. Faculty unclaims ticket back to queue
router.post('/:id/unclaim', requireAdmin, unclaimDoubt);

// 20. Faculty or Admin reassigns ticket
router.post('/:id/reassign', requireAdmin, reassignDoubt);

// 21. Faculty requests clarification from student
router.post('/:id/request-clarification', requireAdmin, requestClarification);

// 22. Faculty submits verified LaTeX solution
router.post('/:id/teacher-reply', requireAdmin, optionalFileUpload, submitTeacherReply);

// 22b. Faculty/Admin publishes resolved doubt as anonymized FAQ entry
router.post('/:id/publish-faq', doubtLimiter, requireAdmin, publishFaqEntry);

// 22c. Student rates the pedagogical solution (1-5 stars with feedback)
router.post('/:id/rate', doubtLimiter, requireStudent, rateDoubtSolution);

// 23. Fetch full doubt thread with messages & audit trail (owner student or faculty only)
router.get('/:id', doubtGeneralLimiter, protect, getDoubtById);

// 24. Serve private authenticated image attachment (owner student or faculty only)
router.get('/:id/attachments/:index', doubtGeneralLimiter, protect, getAttachment);

module.exports = router;
