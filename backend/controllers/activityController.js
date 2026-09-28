const Activity = require('../models/Activity');

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

module.exports = {
  getAllActivities,
  logActivity
};
