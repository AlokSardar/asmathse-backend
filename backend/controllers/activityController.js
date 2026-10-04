const Activity = require('../models/Activity');
const mongoose = require('mongoose');

// @desc    Get all student activity logs
// @route   GET /api/analytics
// @access  Public
const getAllActivities = async (req, res) => {
  try {
    const { studentEmail, activityType } = req.query;
    const query = {};
    if (studentEmail) query.studentEmail = studentEmail;
    if (activityType) query.activityType = activityType;

    const activities = await Activity.find(query).sort({ loggedAt: -1, createdAt: -1 }).limit(200);
    res.json(activities);
  } catch (error) {
    console.error('Error fetching activities:', error);
    res.status(500).json({ message: error.message });
  }
};

// @desc    Log student activity
// @route   POST /api/analytics
// @access  Public
const logActivity = async (req, res) => {
  try {
    const data = req.body;
    const id = data.id || `act_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
    const payload = {
      ...data,
      id,
      loggedAt: data.loggedAt || new Date()
    };

    const saved = await Activity.create(payload);
    res.status(201).json(saved);
  } catch (error) {
    console.error('Error logging activity to MongoDB Atlas:', error);
    res.status(500).json({ message: error.message });
  }
};

// @desc    Delete single activity by ID
// @route   DELETE /api/analytics/:id
// @access  Public
const deleteActivityById = async (req, res) => {
  try {
    const { id } = req.params;
    const isObjId = mongoose.Types.ObjectId.isValid(id);
    const result = await Activity.deleteOne({
      $or: [
        ...(isObjId ? [{ _id: id }] : []),
        { id: id }
      ]
    });
    res.json({ success: true, message: 'Activity log deleted', deletedCount: result.deletedCount });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Delete multiple activities by IDs
// @route   POST /api/analytics/batch-delete
// @access  Public
const deleteActivitiesBatch = async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ success: false, message: 'ids array is required' });
    }
    const validObjectIds = ids.filter(id => mongoose.Types.ObjectId.isValid(id));
    const result = await Activity.deleteMany({
      $or: [
        { _id: { $in: validObjectIds } },
        { id: { $in: ids } }
      ]
    });
    res.json({ success: true, message: `${result.deletedCount} activity logs deleted`, deletedCount: result.deletedCount });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Clear all activity logs
// @route   DELETE /api/analytics
// @access  Public
const clearAllActivities = async (req, res) => {
  try {
    const result = await Activity.deleteMany({});
    res.json({ success: true, message: 'All activity logs cleared', deletedCount: result.deletedCount });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  getAllActivities,
  logActivity,
  deleteActivityById,
  deleteActivitiesBatch,
  clearAllActivities
};
