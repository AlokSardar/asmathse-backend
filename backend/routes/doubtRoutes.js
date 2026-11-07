const express = require('express');
const router = express.Router();
const {
  protect,
  requireAdmin,
  authorize,
} = require('../middleware/authMiddleware');
const { doubtLimiter } = require('../middleware/securityMiddleware');
const { upload } = require('../middleware/uploadMiddleware');
const {
  askDoubt,
  confirmTranscription,
  askFollowup,
  escalateDoubt,
  resolveDoubt,
  reopenDoubt,
  claimDoubt,
  submitTeacherReply,
  getMyDoubts,
  getTeacherQueue,
  getDoubtById,
  getQuotaStatus,
  getAttachment,
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

// 2. Confirm or edit Stage 1 transcription (for image doubts)
router.post('/:id/confirm-transcription', doubtLimiter, requireStudent, confirmTranscription);

// 3. Ask a pedagogical follow-up question (up to 3 in thread)
router.post('/:id/followup', doubtLimiter, requireStudent, askFollowup);

// 4. Escalate to teacher queue (with 24h SLA)
router.post('/:id/escalate', requireStudent, escalateDoubt);

// 5. Mark doubt as resolved (student owner or faculty)
router.post('/:id/resolve', protect, resolveDoubt);

// 6. Reopen a resolved doubt (up to 1 time)
router.post('/:id/reopen', requireStudent, reopenDoubt);

// 7. Get student's doubts list (with filters)
router.get('/my', requireStudent, getMyDoubts);

// 8. Check student's daily quota status and remaining limits
router.get('/quota', protect, getQuotaStatus);


// ── Teacher / Faculty Escalation Queue Endpoints ──────────────────────────────

// 9. Fetch teacher review queue (filtered by teacher's assigned course/branch; admin sees all)
router.get('/teacher/queue', requireAdmin, getTeacherQueue);

// 10. Claim an escalated doubt ticket
router.post('/:id/claim', requireAdmin, claimDoubt);

// 11. Submit teacher LaTeX verified solution
router.post('/:id/teacher-reply', requireAdmin, optionalFileUpload, submitTeacherReply);


// ── Shared Ticket Detail Endpoint ─────────────────────────────────────────────

// 12. Fetch full doubt thread with messages & audit trail (owner student or faculty only)
router.get('/:id', protect, getDoubtById);

// 13. Serve private authenticated image attachment (owner student or faculty only)
router.get('/:id/attachments/:index', protect, getAttachment);

module.exports = router;
