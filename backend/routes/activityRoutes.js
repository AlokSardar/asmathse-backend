const express = require('express');
const router = express.Router();
const {
  getAllActivities,
  logActivity,
  deleteActivityById,
  deleteActivitiesBatch,
  clearAllActivities
} = require('../controllers/activityController');

router.get('/', getAllActivities);
router.post('/', logActivity);
router.post('/batch-delete', deleteActivitiesBatch);
router.delete('/', clearAllActivities);
router.delete('/:id', deleteActivityById);

module.exports = router;
