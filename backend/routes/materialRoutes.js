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
const { protect, optionalAuth, requireTeacherOrAdmin } = require('../middleware/authMiddleware');
const { upload } = require('../middleware/uploadMiddleware');

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
