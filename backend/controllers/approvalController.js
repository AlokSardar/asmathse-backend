/**
 * Student Registration Approval & Lifecycle Moderation Controller
 *
 * Provides enterprise-grade approval workflows for incoming student registrations:
 * - Querying with cohort filtering, search, pagination, and status breakdowns
 * - Individual Approve / Reject / Suspend / Reinstate operations
 * - Bulk actions (up to 50 users) with safety validation
 * - Dynamic metrics & stats for live notification badges
 */

const mongoose = require('mongoose');
const User = require('../models/User');
const Student = require('../models/Student');
const Notification = require('../models/Notification');
const { dbGuard } = require('../utils/dbGuard');
const { clearDashboardCache } = require('./dashboardController');

/**
 * Helper to ensure student record stays synchronized
 */
async function syncStudentDoc(userId, email, updates) {
  try {
    const studentQuery = [];
    if (userId) studentQuery.push({ userId });
    if (email) studentQuery.push({ email: email.toLowerCase() });
    if (studentQuery.length === 0) return;

    await Student.updateMany({ $or: studentQuery }, { $set: updates });
  } catch (err) {
    console.warn('[STUDENT SYNC NOTICE]:', err.message);
  }
}

/**
 * GET /api/approvals
 * Retrieve paginated student approvals with cohort filters and counts
 */
exports.getApprovals = async (req, res) => {
  try {
    dbGuard('GET /api/approvals');

    const {
      status = 'all',
      course,
      branch,
      semester,
      classLevel,
      search = '',
      sortBy = 'newest',
      from,
      to,
      page = 1,
      limit = 20,
    } = req.query;

    const baseStudentFilter = {
      role: { $in: ['student', 'Student'] },
    };

    const filter = { ...baseStudentFilter };

    // Status filter
    if (status && status !== 'all') {
      filter.approvalStatus = status.toLowerCase();
    }

    // Cohort filters
    if (course && course !== 'all') {
      filter.$or = [
        { course: new RegExp(`^${course}$`, 'i') },
        { stream: new RegExp(`^${course}$`, 'i') },
      ];
    }

    if (branch && branch !== 'all') {
      filter.branch = new RegExp(`^${branch}$`, 'i');
    }

    if (semester && semester !== 'all') {
      const cleanSem = String(semester).replace(/\D/g, '');
      const semNum = parseInt(cleanSem, 10);
      filter.$or = [
        { semester: semNum || semester },
        { semester: String(semester) },
        { semester: new RegExp(semester, 'i') },
      ];
    }

    if (classLevel && classLevel !== 'all') {
      filter.classLevel = new RegExp(`^${classLevel}$`, 'i');
    }

    // Search filter
    if (search && search.trim()) {
      const q = search.trim();
      const searchRegex = new RegExp(q, 'i');
      filter.$and = filter.$and || [];
      filter.$and.push({
        $or: [
          { name: searchRegex },
          { email: searchRegex },
          { phone: searchRegex },
          { whatsapp: searchRegex },
          { rollNumber: searchRegex },
          { studentWhatsapp: searchRegex },
        ],
      });
    }

    // Date range filter
    if (from || to) {
      filter.createdAt = filter.createdAt || {};
      if (from) filter.createdAt.$gte = new Date(from);
      if (to) {
        const toDate = new Date(to);
        toDate.setHours(23, 59, 59, 999);
        filter.createdAt.$lte = toDate;
      }
    }

    // Sort order
    let sort = { createdAt: -1 };
    if (sortBy === 'oldest') {
      sort = { createdAt: 1 };
    } else if (sortBy === 'name_asc') {
      sort = { name: 1 };
    }

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const skip = (pageNum - 1) * limitNum;

    // Fetch data and overall status counts in parallel
    const [users, total, pendingCount, approvedCount, rejectedCount, suspendedCount] = await Promise.all([
      User.find(filter)
        .select('-password')
        .populate('approvedBy', 'name email')
        .populate('rejectedBy', 'name email')
        .sort(sort)
        .skip(skip)
        .limit(limitNum)
        .lean(),
      User.countDocuments(filter),
      User.countDocuments({ ...baseStudentFilter, approvalStatus: 'pending' }),
      User.countDocuments({ ...baseStudentFilter, approvalStatus: 'approved' }),
      User.countDocuments({ ...baseStudentFilter, approvalStatus: 'rejected' }),
      User.countDocuments({ ...baseStudentFilter, approvalStatus: 'suspended' }),
    ]);

    const totalStudents = pendingCount + approvedCount + rejectedCount + suspendedCount;

    return res.status(200).json({
      success: true,
      data: users.map((u) => ({
        ...u,
        id: u._id,
        course: u.course || u.stream || 'Engineering',
        branch: u.branch || 'General',
        semester: u.semester || 1,
      })),
      pagination: {
        page: pageNum,
        limit: limitNum,
        totalPages: Math.ceil(total / limitNum) || 1,
        total,
      },
      counts: {
        pending: pendingCount,
        approved: approvedCount,
        rejected: rejectedCount,
        suspended: suspendedCount,
        total: totalStudents,
      },
    });
  } catch (error) {
    console.error('getApprovals error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * PATCH /api/approvals/:userId/approve
 * Approves a pending/rejected/suspended student account
 */
exports.approveStudent = async (req, res) => {
  try {
    dbGuard('PATCH /api/approvals/:userId/approve');

    const { userId } = req.params;
    const user = await User.findById(userId);

    if (!user) {
      return res.status(404).json({ success: false, message: 'Student account not found.' });
    }

    user.approvalStatus = 'approved';
    user.isApproved = true;
    user.isActive = true;
    user.approvedBy = req.user?._id !== 'master_admin_id' ? req.user?._id : null;
    user.approvedAt = new Date();
    user.rejectedBy = undefined;
    user.rejectedAt = undefined;
    user.rejectionReason = '';
    user.suspendedAt = undefined;
    user.suspensionReason = '';

    await user.save();
    clearDashboardCache();

    // Synchronize Student record
    await syncStudentDoc(user._id, user.email, {
      isApproved: true,
      approvalStatus: 'approved',
    });

    // Send in-app notification to student
    await Notification.create({
      userId: user._id,
      title: 'Account Approved! 🎉',
      message: 'Your registration has been approved. You now have full access to study materials, assignments, and test schedules.',
      type: 'account_approved',
      isRead: false,
      createdAt: new Date(),
    }).catch(() => {});

    return res.status(200).json({
      success: true,
      message: `✓ ${user.name} has been approved successfully.`,
      user: {
        _id: user._id,
        id: user._id,
        name: user.name,
        email: user.email,
        approvalStatus: user.approvalStatus,
        isApproved: user.isApproved,
        isActive: user.isActive,
        approvedAt: user.approvedAt,
      },
    });
  } catch (error) {
    console.error('approveStudent error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * PATCH /api/approvals/:userId/reject
 * Rejects a student registration with mandatory reason
 */
exports.rejectStudent = async (req, res) => {
  try {
    dbGuard('PATCH /api/approvals/:userId/reject');

    const { userId } = req.params;
    const { reason = '' } = req.body;

    const cleanReason = String(reason).trim();
    if (!cleanReason || cleanReason.length < 10) {
      return res.status(400).json({
        success: false,
        message: 'Rejection reason is required and must be at least 10 characters long.',
      });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'Student account not found.' });
    }

    user.approvalStatus = 'rejected';
    user.isApproved = false;
    user.isActive = false;
    user.rejectedBy = req.user?._id !== 'master_admin_id' ? req.user?._id : null;
    user.rejectedAt = new Date();
    user.rejectionReason = cleanReason;

    await user.save();
    clearDashboardCache();

    await syncStudentDoc(user._id, user.email, {
      isApproved: false,
      approvalStatus: 'rejected',
      rejectionReason: cleanReason,
    });

    // Send in-app notification to student
    await Notification.create({
      userId: user._id,
      title: 'Registration Rejected',
      message: `Your registration was not approved. Reason: ${cleanReason}`,
      type: 'account_rejected',
      isRead: false,
      createdAt: new Date(),
    }).catch(() => {});

    return res.status(200).json({
      success: true,
      message: `✗ ${user.name}'s registration has been rejected.`,
      user: {
        _id: user._id,
        id: user._id,
        name: user.name,
        email: user.email,
        approvalStatus: user.approvalStatus,
        isApproved: user.isApproved,
        isActive: user.isActive,
        rejectionReason: user.rejectionReason,
        rejectedAt: user.rejectedAt,
      },
    });
  } catch (error) {
    console.error('rejectStudent error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * PATCH /api/approvals/:userId/suspend
 * Suspends an approved student account
 */
exports.suspendStudent = async (req, res) => {
  try {
    dbGuard('PATCH /api/approvals/:userId/suspend');

    const { userId } = req.params;
    const { reason = '', duration = 'Permanent' } = req.body;

    const cleanReason = String(reason).trim();
    if (!cleanReason || cleanReason.length < 10) {
      return res.status(400).json({
        success: false,
        message: 'Suspension reason is required and must be at least 10 characters long.',
      });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'Student account not found.' });
    }

    user.approvalStatus = 'suspended';
    user.isApproved = false;
    user.isActive = false;
    user.suspendedAt = new Date();
    user.suspensionReason = `${cleanReason}${duration ? ` (Duration: ${duration})` : ''}`;

    await user.save();
    clearDashboardCache();

    await syncStudentDoc(user._id, user.email, {
      isApproved: false,
      approvalStatus: 'suspended',
      suspensionReason: user.suspensionReason,
    });

    return res.status(200).json({
      success: true,
      message: `🔒 ${user.name}'s account has been suspended.`,
      user: {
        _id: user._id,
        id: user._id,
        name: user.name,
        approvalStatus: user.approvalStatus,
        isApproved: user.isApproved,
        isActive: user.isActive,
        suspensionReason: user.suspensionReason,
        suspendedAt: user.suspendedAt,
      },
    });
  } catch (error) {
    console.error('suspendStudent error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * PATCH /api/approvals/:userId/reinstate
 * Reinstates a suspended user back to approved status
 */
exports.reinstateStudent = async (req, res) => {
  try {
    dbGuard('PATCH /api/approvals/:userId/reinstate');

    const { userId } = req.params;
    const user = await User.findById(userId);

    if (!user) {
      return res.status(404).json({ success: false, message: 'Student account not found.' });
    }

    user.approvalStatus = 'approved';
    user.isApproved = true;
    user.isActive = true;
    user.suspendedAt = undefined;
    user.suspensionReason = '';

    await user.save();
    clearDashboardCache();

    await syncStudentDoc(user._id, user.email, {
      isApproved: true,
      approvalStatus: 'approved',
    });

    return res.status(200).json({
      success: true,
      message: `✓ ${user.name} has been reinstated successfully.`,
      user: {
        _id: user._id,
        id: user._id,
        name: user.name,
        approvalStatus: user.approvalStatus,
        isApproved: user.isApproved,
        isActive: user.isActive,
      },
    });
  } catch (error) {
    console.error('reinstateStudent error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * POST /api/approvals/bulk
 * Bulk approve / reject / suspend up to 50 users at once
 */
exports.bulkApprovals = async (req, res) => {
  try {
    dbGuard('POST /api/approvals/bulk');

    const { userIds, action, reason = '' } = req.body;

    if (!Array.isArray(userIds) || userIds.length === 0) {
      return res.status(400).json({ success: false, message: 'Please provide an array of user IDs.' });
    }

    if (userIds.length > 50) {
      return res.status(400).json({
        success: false,
        message: 'Maximum 50 students can be processed per bulk action.',
      });
    }

    const validActions = ['approve', 'reject', 'suspend'];
    const cleanAction = String(action).toLowerCase().trim();
    if (!validActions.includes(cleanAction)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid bulk action. Must be "approve", "reject", or "suspend".',
      });
    }

    if ((cleanAction === 'reject' || cleanAction === 'suspend') && (!reason || reason.trim().length < 10)) {
      return res.status(400).json({
        success: false,
        message: `A reason of at least 10 characters is required for bulk ${cleanAction}.`,
      });
    }

    const now = new Date();
    const adminId = req.user?._id !== 'master_admin_id' ? req.user?._id : null;

    let updateFields = {};
    if (cleanAction === 'approve') {
      updateFields = {
        approvalStatus: 'approved',
        isApproved: true,
        isActive: true,
        approvedBy: adminId,
        approvedAt: now,
        rejectionReason: '',
        suspensionReason: '',
      };
    } else if (cleanAction === 'reject') {
      updateFields = {
        approvalStatus: 'rejected',
        isApproved: false,
        isActive: false,
        rejectedBy: adminId,
        rejectedAt: now,
        rejectionReason: reason.trim(),
      };
    } else if (cleanAction === 'suspend') {
      updateFields = {
        approvalStatus: 'suspended',
        isApproved: false,
        isActive: false,
        suspendedAt: now,
        suspensionReason: reason.trim(),
      };
    }

    const result = await User.updateMany(
      { _id: { $in: userIds }, role: { $in: ['student', 'Student'] } },
      { $set: updateFields }
    );

    // Sync student collection
    await Student.updateMany(
      { userId: { $in: userIds } },
      { $set: { approvalStatus: updateFields.approvalStatus, isApproved: updateFields.isApproved } }
    ).catch(() => {});

    clearDashboardCache();

    return res.status(200).json({
      success: true,
      count: result.modifiedCount,
      message: `✓ Successfully ${cleanAction}d ${result.modifiedCount} student(s).`,
    });
  } catch (error) {
    console.error('bulkApprovals error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * GET /api/approvals/stats
 * Metrics for sidebar badge, 30-day registration trend, and approval rate
 */
exports.getApprovalStats = async (req, res) => {
  try {
    dbGuard('GET /api/approvals/stats');

    const baseFilter = { role: { $in: ['student', 'Student'] } };

    const [pendingCount, approvedCount, rejectedCount, suspendedCount] = await Promise.all([
      User.countDocuments({ ...baseFilter, approvalStatus: 'pending' }),
      User.countDocuments({ ...baseFilter, approvalStatus: 'approved' }),
      User.countDocuments({ ...baseFilter, approvalStatus: 'rejected' }),
      User.countDocuments({ ...baseFilter, approvalStatus: 'suspended' }),
    ]);

    const totalCount = pendingCount + approvedCount + rejectedCount + suspendedCount;
    const decided = approvedCount + rejectedCount;
    const approvalRate = decided > 0 ? Math.round((approvedCount / decided) * 100) : 100;

    // Registrations in the last 24 hours
    const last24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const todayCount = await User.countDocuments({
      ...baseFilter,
      createdAt: { $gte: last24h },
    });

    // Daily registrations for last 30 days
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const dailyRegistrations = await User.aggregate([
      {
        $match: {
          ...baseFilter,
          createdAt: { $gte: thirtyDaysAgo },
        },
      },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    return res.status(200).json({
      success: true,
      pendingCount,
      approvedCount,
      rejectedCount,
      suspendedCount,
      totalCount,
      approvalRate,
      todayCount,
      dailyRegistrations: dailyRegistrations.map((d) => ({ date: d._id, count: d.count })),
    });
  } catch (error) {
    console.error('getApprovalStats error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};
