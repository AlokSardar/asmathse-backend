const express = require('express');
const router = express.Router();

const {
  protect,
  requireTeacherOrAdmin,
} = require('../middleware/authMiddleware');

const {
  testsScheduleLimiter,
} = require('../middleware/securityMiddleware');

const {
  getOverview,
  getTestsList,
  getCalendarEvents,
  getTestDetails,
  rescheduleTest,
  archiveTest,
  unarchiveTest,
  duplicateTest,
  getAnalytics,
  exportResultsCSV,
} = require('../controllers/testsScheduleController');

// All tests-schedule routes strictly require authenticated teacher or admin access
// Students receive immediate 403 Forbidden
router.use(protect);
router.use(requireTeacherOrAdmin);
router.use(testsScheduleLimiter);

// ── Static / Prefix Routes (Must precede parametric /:id routes) ──
router.get('/overview', getOverview);
router.get('/list', getTestsList);
router.get('/calendar', getCalendarEvents);

// ── Parametric Routes ──
router.get('/:id/details', getTestDetails);
router.patch('/:id/schedule', rescheduleTest);
router.post('/:id/archive', archiveTest);
router.post('/:id/unarchive', unarchiveTest);
router.post('/:id/duplicate', duplicateTest);
router.get('/:id/analytics', getAnalytics);
router.get('/:id/export', exportResultsCSV);

module.exports = router;
