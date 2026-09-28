const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/authMiddleware');
const {
  uploadContent,
  createAssignment,
  getStudents,
  evaluateSubmission,
  getAcademicYearOverview,
} = require('../controllers/adminController');

// Academic Year Overview (Public/Admin accessible for dashboard viewing)
router.get('/academic-year-overview', getAcademicYearOverview);

// Protected routes requiring admin role
router.use(protect);
router.use(authorize('admin'));

router.post('/content', uploadContent);
router.post('/assignments', createAssignment);
router.get('/students/:stream/:semester', getStudents);
router.put('/submissions/:id', evaluateSubmission);

module.exports = router;
