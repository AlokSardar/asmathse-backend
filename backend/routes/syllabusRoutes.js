const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const {
  getSyllabi,
  getSyllabusById,
  createSyllabus,
  updateSyllabus,
  toggleTopicCompletion,
  deleteSyllabus,
  restoreSyllabus,
  extractPdfText,
} = require('../controllers/syllabusController');
const { protect, optionalAuth, requireTeacherOrAdmin } = require('../middleware/authMiddleware');

// Multer memoryStorage configuration with 20MB limit for PDF syllabus attachments
const syllabusUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 20 * 1024 * 1024, // 20MB max
  },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const mime = file.mimetype.toLowerCase();

    if (ext === '.pdf' || mime === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Invalid file format. Only PDF documents up to 20MB are supported.'));
    }
  },
});

// Multer error handling wrapper
const handlePdfUpload = (req, res, next) => {
  syllabusUpload.single('file')(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({
          success: false,
          message: 'PDF file exceeds maximum 20MB limit.',
        });
      }
      return res.status(400).json({ success: false, message: err.message });
    } else if (err) {
      return res.status(400).json({ success: false, message: err.message });
    }
    next();
  });
};

// 1. Query syllabi by cohort (role-aware)
router.get('/', optionalAuth, getSyllabi);

// 2. Extract description text from uploaded PDF (Amendment 3)
router.post('/extract-pdf', requireTeacherOrAdmin, handlePdfUpload, extractPdfText);
router.post('/import-pdf', requireTeacherOrAdmin, handlePdfUpload, extractPdfText);

// 3. Get single syllabus detail
router.get('/:id', optionalAuth, getSyllabusById);

// 4. Create new subject syllabus
router.post('/', requireTeacherOrAdmin, handlePdfUpload, createSyllabus);

// 5. Update syllabus
router.patch('/:id', requireTeacherOrAdmin, handlePdfUpload, updateSyllabus);

// 6. Toggle topic completion or add micro-topic (Amendment 1)
router.patch('/:id/topics', requireTeacherOrAdmin, toggleTopicCompletion);

// 7. Soft-delete syllabus
router.delete('/:id', requireTeacherOrAdmin, deleteSyllabus);

// 8. Restore soft-deleted syllabus
router.post('/:id/restore', requireTeacherOrAdmin, restoreSyllabus);

module.exports = router;
