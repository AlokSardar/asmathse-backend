const express = require('express');
const router = express.Router();
const {
  getAllActivities,
  logActivity,
} = require('../controllers/activityController');

router.get('/', getAllActivities);
router.post('/', logActivity);

module.exports = router;
