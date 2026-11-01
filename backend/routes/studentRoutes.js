const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/authMiddleware');
const {
  getStudentContent,
  getStudentAssignments,
  submitAssignment,
  getMySubmissions,
  solveStudentDoubt,
} = require('../controllers/studentController');

// Intelligent AI Doubt Solving Endpoints (accessible for student inquiries)
router.post('/solve-doubt', solveStudentDoubt);
router.post('/doubt', solveStudentDoubt);

// All routes below are protected and require student role
router.use(protect);
router.use(authorize('student'));

router.get('/content', getStudentContent);
router.get('/assignments', getStudentAssignments);
router.post('/submissions', submitAssignment);
router.get('/submissions', getMySubmissions);

module.exports = router;
