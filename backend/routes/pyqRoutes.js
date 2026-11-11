const express = require('express');
const router = express.Router();
const {
  protect,
  requireTeacherOrAdmin,
  optionalAuth,
} = require('../middleware/authMiddleware');
const pyqController = require('../controllers/pyqController');

// 1. Upload PYQ Paper (File + Metadata) - Faculty Only
router.post(
  '/upload',
  protect,
  requireTeacherOrAdmin,
  pyqController.uploadMiddleware,
  pyqController.uploadPaper
);

// 2. Extract Questions from PDF/Scan (Gemini OCR Vision Pipeline) - Faculty Only
router.post(
  '/:paperId/extract',
  protect,
  requireTeacherOrAdmin,
  pyqController.extractQuestions
);

// 3. AI Generate Step-by-Step Solutions (Bilingual + SVG graphics) - Faculty Only
router.post(
  '/:paperId/solve',
  protect,
  requireTeacherOrAdmin,
  pyqController.solveQuestions
);

// 4. Update / Verify Specific Question - Faculty Only
router.patch(
  '/:paperId/questions/:qIndex',
  protect,
  requireTeacherOrAdmin,
  pyqController.updateQuestion
);

// 5. Publish to Student Portal - Faculty Only
router.patch(
  '/:paperId/publish',
  protect,
  requireTeacherOrAdmin,
  pyqController.publishPaper
);

// 6. Unpublish back to Draft - Faculty Only
router.patch(
  '/:paperId/unpublish',
  protect,
  requireTeacherOrAdmin,
  pyqController.unpublishPaper
);

// 7. Soft-Delete Paper - Faculty Only
router.delete(
  '/:paperId',
  protect,
  requireTeacherOrAdmin,
  pyqController.deletePaper
);

// 8. Restore Soft-Deleted Paper - Faculty Only
router.post(
  '/:paperId/restore',
  protect,
  requireTeacherOrAdmin,
  pyqController.restorePaper
);

// 8b. Send Questions to Question Bank - Faculty Only
router.post(
  '/:paperId/send-to-qb',
  protect,
  requireTeacherOrAdmin,
  pyqController.sendToQuestionBank
);

// 8c. Generate Rubric for Question - Faculty Only
router.post(
  '/:paperId/questions/:qIndex/rubric',
  protect,
  requireTeacherOrAdmin,
  pyqController.generateQuestionRubric
);

// 9. Download / Print Solved Paper View (HTML with Print Stylesheet) - Public / Optional Auth
router.get(
  '/:paperId/download',
  optionalAuth,
  pyqController.getPaperPrintView
);

// 10. List PYQ Papers (Scoped: students see published in their cohort; teachers see all)
router.get(
  '/',
  optionalAuth,
  pyqController.getPYQPapers
);

// 11. Get Single PYQ Paper by ID
router.get(
  '/:paperId',
  optionalAuth,
  pyqController.getPYQPaperById
);

module.exports = router;
