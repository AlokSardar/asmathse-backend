const Notification = require('../models/Notification');

// @desc    Get notifications for students
// @route   GET /api/notifications
// @access  Public
const getNotifications = async (req, res) => {
  try {
    const { course, branch, semester, classLevel, studentId, studentEmail } = req.query;
    const query = {};

    if (course) {
      query.$or = [
        { course: new RegExp(`^${course}$`, 'i') },
        { course: 'all' },
        { course: null },
        { course: '' }
      ];
    }

    const notifications = await Notification.find(query)
      .sort({ createdAt: -1 })
      .limit(50);

    const userKey = studentEmail || studentId;

    // Attach `isRead` flag for this student
    const result = notifications.map((n) => {
      const obj = n.toObject();
      obj.isRead = userKey ? (Array.isArray(obj.readBy) && obj.readBy.includes(userKey)) : false;
      return obj;
    });

    res.json(result);
  } catch (error) {
    console.error('Error fetching notifications:', error);
    res.status(500).json({ message: error.message });
  }
};

// @desc    Mark single notification as read
// @route   PUT /api/notifications/:id/read
// @access  Public
const markAsRead = async (req, res) => {
  try {
    const { studentEmail, studentId } = req.body;
    const userKey = studentEmail || studentId || 'student';

    const notif = await Notification.findOneAndUpdate(
      { id: req.params.id },
      { $addToSet: { readBy: userKey } },
      { new: true }
    );

    if (!notif) {
      return res.status(404).json({ message: 'Notification not found' });
    }

    res.json({ success: true, notification: notif });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Mark all notifications as read for a student
// @route   PUT /api/notifications/read-all
// @access  Public
const markAllAsRead = async (req, res) => {
  try {
    const { studentEmail, studentId, course } = req.body;
    const userKey = studentEmail || studentId || 'student';

    const filter = {};
    if (course) filter.course = new RegExp(`^${course}$`, 'i');

    await Notification.updateMany(
      filter,
      { $addToSet: { readBy: userKey } }
    );

    res.json({ success: true, message: 'All notifications marked as read' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Create manual notification (Admin Broadcast)
// @route   POST /api/notifications
// @access  Public
const createNotification = async (req, res) => {
  try {
    const data = req.body;
    const id = data.id || `notif_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
    const notif = await Notification.create({
      ...data,
      id,
      createdAt: new Date(),
    });
    res.status(201).json(notif);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  getNotifications,
  markAsRead,
  markAllAsRead,
  createNotification,
};
