const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/authMiddleware');
const {
  getStudentContent,
  getStudentAssignments,
  submitAssignment,
  getMySubmissions
} = require('../controllers/studentController');

// All routes here are protected and require student role
router.use(protect);
router.use(authorize('student'));

router.get('/content', getStudentContent);
router.get('/assignments', getStudentAssignments);
router.post('/submissions', submitAssignment);
router.get('/submissions', getMySubmissions);

module.exports = router;
