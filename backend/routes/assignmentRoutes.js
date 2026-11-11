const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const {
  getAssignments,
  createAssignment,
  updateAssignment,
  updateAssignmentStatus,
  deleteAssignment,
  restoreAssignment,
  bulkAssignmentsAction,
  getAssignmentSubmissions,
  gradeSubmission,
  submitAssignment,
} = require('../controllers/assignmentController');
const { protect, optionalAuth, requireTeacherOrAdmin } = require('../middleware/authMiddleware');

// Multer memoryStorage configuration with 20MB limit and strict file type validation (Amendment 2)
const assignmentUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 20 * 1024 * 1024, // 20MB max
  },
  fileFilter: (req, file, cb) => {
    const allowedExts = ['.pdf', '.docx', '.doc', '.png', '.jpg', '.jpeg'];
    const allowedMimes = [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'image/png',
      'image/jpeg',
      'image/jpg',
    ];
    const ext = path.extname(file.originalname).toLowerCase();
    const mime = file.mimetype.toLowerCase();

    if (allowedExts.includes(ext) || allowedMimes.includes(mime)) {
      cb(null, true);
    } else {
      cb(
        new Error(
          `Unsupported file format (${ext}). Allowed formats: PDF, DOCX, DOC, PNG, JPG (up to 20MB).`
        )
      );
    }
  },
});

// Multer error handling wrapper
const handleUpload = (req, res, next) => {
  assignmentUpload.single('file')(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({
          success: false,
          message: 'File size exceeds maximum 20MB limit.',
        });
      }
      return res.status(400).json({ success: false, message: err.message });
    } else if (err) {
      return res.status(400).json({ success: false, message: err.message });
    }
    next();
  });
};

// 1. Query assignments (cohort-aware, server-side filtering, query-time overdue check)
router.get('/', optionalAuth, getAssignments);

// 2. Create new assignment (Teacher/Admin only)
router.post('/', requireTeacherOrAdmin, handleUpload, createAssignment);

// 3. Update assignment metadata
router.patch('/:id', requireTeacherOrAdmin, handleUpload, updateAssignment);

// 4. Update assignment status (draft / active / completed / archived)
router.patch('/:id/status', requireTeacherOrAdmin, updateAssignmentStatus);

// 5. Soft-delete assignment
router.delete('/:id', requireTeacherOrAdmin, deleteAssignment);

// 6. Restore soft-deleted assignment (5s Undo)
router.post('/:id/restore', requireTeacherOrAdmin, restoreAssignment);

// 7. Bulk operations (batch delete, status change, extend due date, move cohort)
router.post('/bulk', requireTeacherOrAdmin, bulkAssignmentsAction);

// 8. View student submissions for an assignment
router.get('/:id/submissions', requireTeacherOrAdmin, getAssignmentSubmissions);

// 9. Grade student submission
router.post('/:id/submissions/:studentId/grade', requireTeacherOrAdmin, gradeSubmission);

// 10. Submit assignment (Student submission with file + textAnswer)
router.post('/:id/submit', optionalAuth, handleUpload, submitAssignment);

module.exports = router;
