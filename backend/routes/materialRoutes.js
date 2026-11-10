const express = require('express');
const router = express.Router();
const {
  getMaterials,
  uploadMaterial,
  updateMaterial,
  updateVisibility,
  deleteMaterial,
  downloadMaterial,
} = require('../controllers/materialController');
const { protect, requireTeacherOrAdmin } = require('../middleware/authMiddleware');
const { upload } = require('../middleware/uploadMiddleware');

// Soft auth helper for GET /: allows both authenticated (teacher/student) and unauthenticated
const optionalAuth = async (req, res, next) => {
  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
    return protect(req, res, next);
  }
  next();
};

// 1. Query materials (server-side filtering, role-aware)
router.get('/', optionalAuth, getMaterials);

// 2. Upload new material (Teachers/Admins only)
router.post('/', requireTeacherOrAdmin, upload.single('file'), uploadMaterial);

// 3. Update material metadata
router.patch('/:id', requireTeacherOrAdmin, updateMaterial);

// 4. Toggle visibility (draft / published / archived)
router.patch('/:id/visibility', requireTeacherOrAdmin, updateVisibility);

// 5. Soft-delete material
router.delete('/:id', requireTeacherOrAdmin, deleteMaterial);

// 6. Authenticated download tracking (Amendment 5)
router.get('/:id/download', protect, downloadMaterial);

module.exports = router;
