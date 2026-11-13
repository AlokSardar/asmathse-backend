const express = require('express');
const router = express.Router();
const { protect, requireTeacherOrAdmin } = require('../middleware/authMiddleware');
const {
  getDashboardStats,
  getActivityFeed,
  getWeeklyVolume,
} = require('../controllers/dashboardController');

// All dashboard endpoints require authentication + Teacher or Admin role
router.use(protect);
router.use(requireTeacherOrAdmin);

router.get('/stats', getDashboardStats);
router.get('/activity-feed', getActivityFeed);
router.get('/weekly-volume', getWeeklyVolume);

module.exports = router;
