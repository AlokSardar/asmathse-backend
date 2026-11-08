const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const SecurityEvent = require('../models/SecurityEvent');
const EmailChangeRequest = require('../models/EmailChangeRequest');
const Doubt = require('../models/Doubt');
const AuditLog = require('../models/AuditLog');
const Notification = require('../models/Notification');
const { validatePasswordPolicy } = require('../utils/passwordPolicy');
const { maskIp } = require('../utils/redact');

// Generate JWT with tokenVersion
const generateToken = (id, extra = {}) => {
  return jwt.sign({ id, ...extra }, process.env.JWT_SECRET || 'asmaths_secret_jwt_key_2026_cluster0', {
    expiresIn: '30d',
  });
};

// In-memory rate limiter for password change attempts (5 attempts per 15 min per user & IP)
const passwordAttempts = new Map();
const cleanupOldAttempts = () => {
  const now = Date.now();
  for (const [key, record] of passwordAttempts.entries()) {
    if (now - record.firstAttempt > 15 * 60 * 1000) {
      passwordAttempts.delete(key);
    }
  }
};
setInterval(cleanupOldAttempts, 5 * 60 * 1000);

const checkPasswordRateLimit = (key) => {
  const now = Date.now();
  const record = passwordAttempts.get(key) || { count: 0, firstAttempt: now };
  if (now - record.firstAttempt > 15 * 60 * 1000) {
    record.count = 0;
    record.firstAttempt = now;
  }
  record.count += 1;
  passwordAttempts.set(key, record);
  return record.count;
};

const resetPasswordRateLimit = (key) => {
  passwordAttempts.delete(key);
};

// Helper: Extract client IP & User Agent
const getClientMeta = (req) => {
  const rawIp =
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.connection?.remoteAddress ||
    req.socket?.remoteAddress ||
    '127.0.0.1';
  const rawUa = req.headers['user-agent'] || 'Unknown Device';
  return {
    maskedIp: maskIp(rawIp),
    userAgent: rawUa.length > 150 ? rawUa.slice(0, 150) + '...' : rawUa,
  };
};

/**
 * GET /api/account/me
 * Retrieves current user's profile, permissions, and security metadata
 */
const getMyAccount = async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('-password');
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    // Check for pending email change requests
    const pendingEmailReq = await EmailChangeRequest.findOne({
      userId: user._id,
      status: 'pending',
    }).sort({ createdAt: -1 });

    res.json({
      success: true,
      user: {
        id: user._id,
        _id: user._id,
        name: user.name,
        email: user.email,
        role: (user.role || '').toLowerCase(),
        phone: user.phone || user.whatsapp || user.mobile || '',
        designation: user.designation || '',
        bio: user.bio || '',
        avatar: user.avatar || '',
        course: user.stream || user.targetCourse || 'Engineering',
        branch: user.branch || 'CSE',
        semester: user.semester || 'Semester 1',
        isApproved: user.isApproved !== false,
        mustChangePassword: Boolean(user.mustChangePassword),
        joinedDate: user.createdAt || user.registrationDate,
        lastLogin: user.lastLogin || null,
        preferences: user.preferences || {
          language: 'en',
          theme: 'light',
          defaultCourse: 'Engineering',
          defaultBranch: 'CSE',
          defaultSemester: 'Semester 1',
          notifications: { doubts: true, reEvaluations: true, slaBreaches: true },
        },
      },
      pendingEmailRequest: pendingEmailReq
        ? {
            id: pendingEmailReq._id,
            requestedEmail: pendingEmailReq.requestedEmail,
            reason: pendingEmailReq.reason,
            submittedAt: pendingEmailReq.createdAt,
          }
        : null,
    });
  } catch (err) {
    console.error('getMyAccount error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to retrieve account details.' });
  }
};

/**
 * PATCH /api/account/profile
 * Updates user editable fields with mass-assignment protection
 */
const updateMyProfile = async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    const { name, phone, designation, bio, preferences } = req.body;

    // Last-admin protection: prevent demoting, disabling, or locking the last active administrator
    if (user.role === 'admin') {
      const activeAdmins = await User.countDocuments({ role: 'admin', isApproved: true });
      if (activeAdmins <= 1) {
        if (
          (req.body.role && req.body.role !== 'admin') ||
          req.body.isApproved === false ||
          req.body.mustChangePassword === true
        ) {
          return res.status(403).json({
            success: false,
            message: 'Operation prohibited: Cannot demote, disable, or lock the last active administrator account.',
          });
        }
      }
    }

    // Mass-assignment protection: reject attempts to modify restricted administrative/system fields
    const restrictedKeys = [
      'role',
      'course',
      'branch',
      'semester',
      'stream',
      'email',
      'password',
      'isApproved',
      'profileCompleted',
      'tokenVersion',
      'mustChangePassword',
    ];
    for (const key of restrictedKeys) {
      if (req.body[key] !== undefined && String(req.body[key]) !== String(user[key])) {
        return res.status(400).json({
          success: false,
          message: `Modifying restricted field "${key}" via profile update is strictly prohibited.`,
        });
      }
    }

    // Validate and sanitize Name
    if (name !== undefined) {
      const sanitizedName = String(name).replace(/<[^>]*>?/gm, '').trim();
      if (!sanitizedName || sanitizedName.length < 2 || sanitizedName.length > 100) {
        return res.status(400).json({
          success: false,
          message: 'Full Name must be between 2 and 100 characters.',
        });
      }
      user.name = sanitizedName;
    }

    // Validate Phone
    if (phone !== undefined) {
      const sanitizedPhone = String(phone).trim();
      if (sanitizedPhone && !/^[+0-9\s-]{6,20}$/.test(sanitizedPhone)) {
        return res.status(400).json({
          success: false,
          message: 'Please provide a valid phone number (digits, optional +, 6-20 chars).',
        });
      }
      user.phone = sanitizedPhone;
      user.mobile = sanitizedPhone;
      user.whatsapp = sanitizedPhone;
    }

    // Validate Designation
    if (designation !== undefined) {
      const sanitizedDesig = String(designation).replace(/<[^>]*>?/gm, '').trim();
      if (sanitizedDesig.length > 100) {
        return res.status(400).json({ success: false, message: 'Designation cannot exceed 100 characters.' });
      }
      user.designation = sanitizedDesig;
    }

    // Validate Bio
    if (bio !== undefined) {
      const sanitizedBio = String(bio).replace(/<[^>]*>?/gm, '').trim();
      if (sanitizedBio.length > 500) {
        return res.status(400).json({ success: false, message: 'Bio cannot exceed 500 characters.' });
      }
      user.bio = sanitizedBio;
    }

    // Preferences
    if (preferences && typeof preferences === 'object') {
      const currentPrefs = user.preferences || {};
      user.preferences = {
        ...currentPrefs,
        language: ['en', 'bn'].includes(preferences.language) ? preferences.language : currentPrefs.language || 'en',
        theme: ['light', 'dark', 'system'].includes(preferences.theme) ? preferences.theme : currentPrefs.theme || 'light',
        defaultCourse: preferences.defaultCourse || currentPrefs.defaultCourse || 'Engineering',
        defaultBranch: preferences.defaultBranch || currentPrefs.defaultBranch || 'CSE',
        defaultSemester: preferences.defaultSemester || currentPrefs.defaultSemester || 'Semester 1',
        notifications: {
          doubts: preferences.notifications?.doubts ?? currentPrefs.notifications?.doubts ?? true,
          reEvaluations: preferences.notifications?.reEvaluations ?? currentPrefs.notifications?.reEvaluations ?? true,
          slaBreaches: preferences.notifications?.slaBreaches ?? currentPrefs.notifications?.slaBreaches ?? true,
        },
      };
      user.markModified('preferences');
    }

    await user.save();

    const { maskedIp, userAgent } = getClientMeta(req);
    await SecurityEvent.create({
      userId: user._id,
      userEmail: user.email,
      userRole: user.role,
      action: 'profile_updated',
      details: { updatedFields: Object.keys(req.body).filter((k) => !restrictedKeys.includes(k)) },
      ipAddress: maskedIp,
      userAgent,
    });

    res.json({
      success: true,
      message: 'Profile updated successfully.',
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        designation: user.designation,
        bio: user.bio,
        preferences: user.preferences,
      },
    });
  } catch (err) {
    console.error('updateMyProfile error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to update profile.' });
  }
};

/**
 * POST /api/account/change-password
 * Password change with bcrypt verification, policy check, and session invalidation
 */
const changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword, confirmPassword } = req.body;
    const rateLimitKey = `${req.user._id}_${req.ip}`;
    const attempts = checkPasswordRateLimit(rateLimitKey);

    if (attempts > 5) {
      return res.status(429).json({
        success: false,
        message: 'Too many password change attempts. Please wait 15 minutes before trying again.',
      });
    }

    if (!currentPassword || !newPassword || !confirmPassword) {
      return res.status(400).json({
        success: false,
        message: 'Current password, new password, and password confirmation are required.',
      });
    }

    if (newPassword !== confirmPassword) {
      return res.status(400).json({
        success: false,
        message: 'New password and confirmation do not match.',
      });
    }

    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User account not found.' });
    }

    // 1. Verify Current Password
    const isMatch = await user.matchPassword(currentPassword);
    if (!isMatch) {
      const { maskedIp, userAgent } = getClientMeta(req);
      await SecurityEvent.create({
        userId: user._id,
        userEmail: user.email,
        userRole: user.role,
        action: 'failed_password_attempt',
        details: { reason: 'Incorrect current password' },
        ipAddress: maskedIp,
        userAgent,
      });

      return res.status(400).json({
        success: false,
        message: 'The current password you entered is incorrect.',
      });
    }

    // 2. Reject if new password equals current password
    if (currentPassword === newPassword) {
      return res.status(400).json({
        success: false,
        message: 'New password must be different from your current password.',
      });
    }

    // 3. Server-Side Password Policy Enforcement
    const policyResult = validatePasswordPolicy(newPassword, {
      name: user.name,
      email: user.email,
    });
    if (!policyResult.valid) {
      return res.status(400).json({
        success: false,
        message: 'Password does not satisfy corporate security criteria.',
        errors: policyResult.errors,
      });
    }

    // 4. Hash and save with bcrypt
    const salt = await bcrypt.genSalt(10);
    user.password = await bcrypt.hash(newPassword, salt);

    // 5. Invalidate all other sessions by bumping tokenVersion
    user.tokenVersion = (user.tokenVersion ?? 0) + 1;
    user.mustChangePassword = false;
    await user.save();

    resetPasswordRateLimit(rateLimitKey);

    // 6. Record Security Event
    const { maskedIp, userAgent } = getClientMeta(req);
    await SecurityEvent.create({
      userId: user._id,
      userEmail: user.email,
      userRole: user.role,
      action: 'password_changed',
      details: { sessionInvalidation: true, newTokenVersion: user.tokenVersion },
      ipAddress: maskedIp,
      userAgent,
    });

    // 7. Issue fresh JWT for the active session
    const freshToken = generateToken(user._id, { tokenVersion: user.tokenVersion });

    res.json({
      success: true,
      message: 'Password updated successfully. All other active sessions have been securely signed out.',
      token: freshToken,
    });
  } catch (err) {
    console.error('changePassword error:', err.message);
    res.status(500).json({ success: false, message: 'Password change failed.' });
  }
};

/**
 * POST /api/account/set-initial-password
 * Mandatory endpoint for users with mustChangePassword = true
 */
const setInitialPassword = async (req, res) => {
  try {
    const { newPassword, confirmPassword } = req.body;
    const user = await User.findById(req.user._id);

    if (!user) {
      return res.status(404).json({ success: false, message: 'User account not found.' });
    }

    if (!user.mustChangePassword) {
      return res.status(400).json({
        success: false,
        message: 'Your account does not have a pending forced password change requirement.',
      });
    }

    if (!newPassword || !confirmPassword) {
      return res.status(400).json({
        success: false,
        message: 'New password and confirmation are required.',
      });
    }

    if (newPassword !== confirmPassword) {
      return res.status(400).json({
        success: false,
        message: 'Passwords do not match.',
      });
    }

    const policyResult = validatePasswordPolicy(newPassword, {
      name: user.name,
      email: user.email,
    });
    if (!policyResult.valid) {
      return res.status(400).json({
        success: false,
        message: 'Password does not meet corporate security requirements.',
        errors: policyResult.errors,
      });
    }

    const salt = await bcrypt.genSalt(10);
    user.password = await bcrypt.hash(newPassword, salt);
    user.mustChangePassword = false;
    user.tokenVersion = (user.tokenVersion ?? 0) + 1;
    await user.save();

    const { maskedIp, userAgent } = getClientMeta(req);
    await SecurityEvent.create({
      userId: user._id,
      userEmail: user.email,
      userRole: user.role,
      action: 'initial_password_set',
      details: { forcedChangeResolved: true },
      ipAddress: maskedIp,
      userAgent,
    });

    const freshToken = generateToken(user._id, { tokenVersion: user.tokenVersion });

    res.json({
      success: true,
      message: 'Permanent password set successfully. Welcome to your Faculty Studio workspace!',
      token: freshToken,
    });
  } catch (err) {
    console.error('setInitialPassword error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to set password.' });
  }
};

/**
 * GET /api/account/security-events
 * Lists user-specific recent security & authentication activity
 */
const getMySecurityEvents = async (req, res) => {
  try {
    const events = await SecurityEvent.find({ userId: req.user._id })
      .sort({ timestamp: -1 })
      .limit(20)
      .lean();

    res.json({
      success: true,
      events: events.map((e) => ({
        id: e._id,
        action: e.action,
        ipAddress: e.ipAddress,
        userAgent: e.userAgent,
        details: e.details,
        timestamp: e.timestamp,
      })),
    });
  } catch (err) {
    console.error('getMySecurityEvents error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to retrieve security events.' });
  }
};

/**
 * POST /api/account/sessions/revoke-others
 * Invalidates all other tokens by incrementing tokenVersion
 */
const revokeOtherSessions = async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    user.tokenVersion = (user.tokenVersion ?? 0) + 1;
    await user.save();

    const { maskedIp, userAgent } = getClientMeta(req);
    await SecurityEvent.create({
      userId: user._id,
      userEmail: user.email,
      userRole: user.role,
      action: 'sessions_revoked',
      details: { newVersion: user.tokenVersion },
      ipAddress: maskedIp,
      userAgent,
    });

    const freshToken = generateToken(user._id, { tokenVersion: user.tokenVersion });

    res.json({
      success: true,
      message: 'All other active sessions have been signed out successfully.',
      token: freshToken,
    });
  } catch (err) {
    console.error('revokeOtherSessions error:', err.message);
    res.status(500).json({ success: false, message: 'Session revocation failed.' });
  }
};

/**
 * POST /api/account/email-change-request
 * Allows teachers and admins to request a login email change
 */
const requestEmailChange = async (req, res) => {
  try {
    const userRole = String(req.user?.role || '').toLowerCase();
    if (userRole === 'student') {
      return res.status(403).json({
        success: false,
        message: 'Changing student login email is out of scope in this phase. Please contact academic administration.',
      });
    }

    const { requestedEmail, reason, currentPassword } = req.body;

    if (!requestedEmail || !/^\S+@\S+\.\S+$/.test(requestedEmail)) {
      return res.status(400).json({
        success: false,
        message: 'Please provide a valid requested email address.',
      });
    }

    const cleanEmail = requestedEmail.toLowerCase().trim();

    // Check if email already belongs to any user
    const existingUser = await User.findOne({
      email: { $regex: new RegExp(`^${cleanEmail}$`, 'i') },
    });
    if (existingUser) {
      return res.status(400).json({
        success: false,
        message: 'Requested email address is already in use by another registered user.',
      });
    }

    // Special flow for ADMIN changing their own email
    if (userRole === 'admin') {
      if (!currentPassword) {
        return res.status(400).json({
          success: false,
          message: 'Admin self-email change requires verification with your current password.',
        });
      }

      const adminUser = await User.findById(req.user._id);
      const isMatch = await adminUser.matchPassword(currentPassword);
      if (!isMatch) {
        return res.status(400).json({
          success: false,
          message: 'Current password verification failed.',
        });
      }

      const oldEmail = adminUser.email;
      adminUser.email = cleanEmail;
      adminUser.tokenVersion = (adminUser.tokenVersion ?? 0) + 1;
      await adminUser.save();

      const { maskedIp, userAgent } = getClientMeta(req);
      await SecurityEvent.create({
        userId: adminUser._id,
        userEmail: cleanEmail,
        userRole: adminUser.role,
        action: 'email_change_approved',
        details: { oldEmail, newEmail: cleanEmail, adminSelfChange: true },
        ipAddress: maskedIp,
        userAgent,
      });

      return res.json({
        success: true,
        message: 'Admin email updated successfully. Please sign in with your new email address.',
        requireReLogin: true,
      });
    }

    // Teacher Flow: Submit request for administrative review
    if (!reason || reason.trim().length < 5) {
      return res.status(400).json({
        success: false,
        message: 'Please provide a clear reason for requesting an email change (minimum 5 characters).',
      });
    }

    // Check if user already has an active pending request
    const existingReq = await EmailChangeRequest.findOne({
      userId: req.user._id,
      status: 'pending',
    });
    if (existingReq) {
      return res.status(400).json({
        success: false,
        message: 'You already have an email change request under administrative review.',
      });
    }

    const newReq = await EmailChangeRequest.create({
      userId: req.user._id,
      currentEmail: req.user.email,
      requestedEmail: cleanEmail,
      reason: reason.trim(),
    });

    const { maskedIp, userAgent } = getClientMeta(req);
    await SecurityEvent.create({
      userId: req.user._id,
      userEmail: req.user.email,
      userRole: req.user.role,
      action: 'email_change_requested',
      details: { requestedEmail: cleanEmail, requestId: newReq._id },
      ipAddress: maskedIp,
      userAgent,
    });

    res.json({
      success: true,
      message: 'Email change request submitted for administrative review.',
      requestId: newReq._id,
    });
  } catch (err) {
    console.error('requestEmailChange error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to process email change request.' });
  }
};

/**
 * ─────────────────────────────────────────────────────────
 * ADMINISTRATIVE MANAGEMENT ENDPOINTS (Admin Only)
 * ─────────────────────────────────────────────────────────
 */

/**
 * GET /api/account/admin/users
 * Paginated search and list of teachers and students
 */
const getAdminUsersList = async (req, res) => {
  try {
    const { search, role, page = 1, limit = 20 } = req.query;
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(50, Math.max(1, parseInt(limit, 10) || 20));

    const filter = {};
    if (role && role !== 'all') {
      filter.role = new RegExp(`^${role}$`, 'i');
    }

    if (search && search.trim()) {
      const q = search.trim();
      filter.$or = [
        { name: { $regex: q, $options: 'i' } },
        { email: { $regex: q, $options: 'i' } },
        { phone: { $regex: q, $options: 'i' } },
      ];
    }

    const [users, total] = await Promise.all([
      User.find(filter)
        .select('name email role stream branch semester lastLogin isApproved mustChangePassword createdAt designation')
        .sort({ createdAt: -1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum)
        .lean(),
      User.countDocuments(filter),
    ]);

    res.json({
      success: true,
      users: users.map((u) => ({
        id: u._id,
        name: u.name,
        email: u.email,
        role: (u.role || '').toLowerCase(),
        course: u.stream || 'Engineering',
        branch: u.branch || 'CSE',
        semester: u.semester || 'Semester 1',
        designation: u.designation || '',
        lastLogin: u.lastLogin || null,
        isApproved: u.isApproved !== false,
        mustChangePassword: Boolean(u.mustChangePassword),
        joinedDate: u.createdAt,
      })),
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
      },
    });
  } catch (err) {
    console.error('getAdminUsersList error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to retrieve users list.' });
  }
};

/**
 * POST /api/account/admin/reset-password
 * Admin resets a user's password with temporary random credentials
 */
const adminResetUserPassword = async (req, res) => {
  // Enforce zero-caching on temporary credentials
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');

  try {
    const { targetUserId } = req.body;
    if (!targetUserId) {
      return res.status(400).json({ success: false, message: 'Target user ID is required.' });
    }

    // Rate Limiting per Admin User ID & IP
    const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || '127.0.0.1';
    const rateLimitKey = `admin_reset_${req.user._id}_${clientIp}`;
    const attempts = checkPasswordRateLimit(rateLimitKey);
    if (attempts > 5) {
      return res.status(429).json({
        success: false,
        message: 'Too many administrative reset attempts. Please wait 15 minutes before trying again.',
      });
    }

    // Prevent admin from resetting their own password through this route
    if (String(targetUserId) === String(req.user._id) || String(targetUserId) === 'master_admin_id') {
      return res.status(400).json({
        success: false,
        message: 'Administrators cannot reset their own password via administrative override. Please use the standard Change Password feature.',
      });
    }

    const targetUser = await User.findById(targetUserId);
    if (!targetUser) {
      return res.status(404).json({ success: false, message: 'Target user not found.' });
    }

    const targetRole = String(targetUser.role || '').toLowerCase();

    // Admin resetting another admin is strictly prohibited (only teachers and students can be reset by an admin)
    if (targetRole === 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Operation prohibited: Administrators cannot reset another administrator account. Admin-assisted reset is permitted only for teachers and students.',
      });
    }

    if (targetRole !== 'teacher' && targetRole !== 'student') {
      return res.status(403).json({
        success: false,
        message: 'Administrative reset is permitted only for faculty/teacher and student accounts.',
      });
    }

    // Generate secure temporary password: 16+ chars, guaranteed mixed
    const randomHex = crypto.randomBytes(9).toString('base64url'); // ~12 alphanumeric chars
    const temporaryPassword = `Tmp!${randomHex}9Aa`; // Guarantees symbols, numbers, upper and lower case

    // Hash with bcrypt
    const salt = await bcrypt.genSalt(10);
    targetUser.password = await bcrypt.hash(temporaryPassword, salt);
    targetUser.mustChangePassword = true;
    targetUser.tokenVersion = (targetUser.tokenVersion ?? 0) + 1;
    await targetUser.save();

    // Log security event (NEVER include temporaryPassword in logs/events)
    const { maskedIp, userAgent } = getClientMeta(req);
    await SecurityEvent.create({
      userId: targetUser._id,
      userEmail: targetUser.email,
      userRole: targetUser.role,
      action: 'password_reset_by_admin',
      details: {
        resetByAdminId: req.user._id,
        resetByAdminEmail: req.user.email,
        forcedChangeRequired: true,
      },
      ipAddress: maskedIp,
      userAgent,
    });

    // Write audit log
    await AuditLog.create({
      id: `audit_reset_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      targetType: 'Evaluation', // fallback or general target
      targetId: String(targetUser._id),
      action: 'admin_override',
      actorId: String(req.user._id),
      actorName: req.user.name || 'Administrator',
      actorRole: 'admin',
      actorEmail: req.user.email,
      changes: { action: 'admin_assisted_password_reset', targetEmail: targetUser.email },
      ipAddress: maskedIp,
      userAgent,
    }).catch(() => {});

    res.json({
      success: true,
      message: 'Temporary password generated successfully. Show this once to the user.',
      temporaryPassword,
      targetUser: {
        id: targetUser._id,
        name: targetUser.name,
        email: targetUser.email,
        role: targetUser.role,
      },
    });
  } catch (err) {
    console.error('adminResetUserPassword error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to reset password.' });
  }
};

/**
 * GET /api/account/admin/email-requests
 * Lists pending email change requests
 */
const getPendingEmailChangeRequests = async (_req, res) => {
  try {
    const requests = await EmailChangeRequest.find({ status: { $in: ['pending', 'processing'] } })
      .populate('userId', 'name email role stream branch')
      .sort({ createdAt: -1 })
      .lean();

    res.json({
      success: true,
      requests: requests.map((r) => ({
        id: r._id,
        user: r.userId
          ? {
              id: r.userId._id,
              name: r.userId.name,
              currentEmail: r.userId.email,
              role: r.userId.role,
              course: r.userId.stream || 'Engineering',
              branch: r.userId.branch || 'CSE',
            }
          : { id: r.userId, currentEmail: r.currentEmail },
        requestedEmail: r.requestedEmail,
        reason: r.reason,
        submittedAt: r.createdAt,
      })),
    });
  } catch (err) {
    console.error('getPendingEmailChangeRequests error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to retrieve email change requests.' });
  }
};

/**
 * POST /api/account/admin/email-requests/:id/approve
 * Approves an email change request with transaction/compensating rollback
 */
const approveEmailChangeRequest = async (req, res) => {
  try {
    const { id } = req.params;
    const request = await EmailChangeRequest.findById(id);
    if (!request || !['pending', 'processing'].includes(request.status)) {
      return res.status(404).json({ success: false, message: 'Pending or processing email change request not found.' });
    }

    // Step 0: Mark request as 'processing' before starting the multi-step updates
    request.status = 'processing';
    request.reviewedBy = req.user._id;
    request.reviewedByName = req.user.name || 'Administrator';
    await request.save();

    const cleanEmail = request.requestedEmail.toLowerCase().trim();

    // Check uniqueness
    const inUse = await User.findOne({
      _id: { $ne: request.userId },
      email: { $regex: new RegExp(`^${cleanEmail}$`, 'i') },
    });
    if (inUse) {
      return res.status(400).json({
        success: false,
        message: 'The requested email address is already claimed by another user.',
      });
    }

    const user = await User.findById(request.userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    const oldEmail = user.email;

    // Execution with Compensating Rollback Guarantee
    let doubtUpdateCount = 0;
    try {
      // 1. Update User
      user.email = cleanEmail;
      user.tokenVersion = (user.tokenVersion ?? 0) + 1;
      await user.save();

      // 2. Update Doubt assignedTeacher.email if this was a teacher
      const doubtResult = await Doubt.updateMany(
        { 'assignedTeacher.id': user._id },
        { $set: { 'assignedTeacher.email': cleanEmail } }
      );
      doubtUpdateCount = doubtResult.modifiedCount || 0;

      // 3. Update Notification readBy array so teacher read status persists under new email
      await Notification.updateMany(
        { readBy: oldEmail },
        { $set: { 'readBy.$[elem]': cleanEmail } },
        { arrayFilters: [{ elem: oldEmail }] }
      );

      // 4. Mark Request Approved
      request.status = 'approved';
      request.reviewedBy = req.user._id;
      request.reviewedByName = req.user.name || 'Administrator';
      request.reviewedAt = new Date();
      await request.save();
    } catch (stepErr) {
      // Compensating rollback
      console.error('Email change error, initiating rollback:', stepErr.message);
      user.email = oldEmail;
      await user.save().catch(() => {});
      await Doubt.updateMany(
        { 'assignedTeacher.id': user._id },
        { $set: { 'assignedTeacher.email': oldEmail } }
      ).catch(() => {});
      await Notification.updateMany(
        { readBy: cleanEmail },
        { $set: { 'readBy.$[elem]': oldEmail } },
        { arrayFilters: [{ elem: cleanEmail }] }
      ).catch(() => {});
      throw stepErr;
    }

    // 4. Security Events & Audit
    const { maskedIp, userAgent } = getClientMeta(req);
    await SecurityEvent.create({
      userId: user._id,
      userEmail: cleanEmail,
      userRole: user.role,
      action: 'email_change_approved',
      details: {
        oldEmail,
        newEmail: cleanEmail,
        approvedByAdminId: req.user._id,
        doubtsUpdated: doubtUpdateCount,
      },
      ipAddress: maskedIp,
      userAgent,
    });

    res.json({
      success: true,
      message: `Email change request approved. Login ID updated from ${oldEmail} to ${cleanEmail}.`,
    });
  } catch (err) {
    console.error('approveEmailChangeRequest error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to approve email change request.' });
  }
};

/**
 * POST /api/account/admin/email-requests/:id/reject
 * Rejects an email change request
 */
const rejectEmailChangeRequest = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    const request = await EmailChangeRequest.findById(id);
    if (!request || !['pending', 'processing'].includes(request.status)) {
      return res.status(404).json({ success: false, message: 'Pending email change request not found.' });
    }

    request.status = 'rejected';
    request.reviewedBy = req.user._id;
    request.reviewedByName = req.user.name || 'Administrator';
    request.reviewedAt = new Date();
    request.rejectionReason = reason ? String(reason).trim() : 'Administrative review determined request could not be fulfilled.';
    await request.save();

    const { maskedIp, userAgent } = getClientMeta(req);
    await SecurityEvent.create({
      userId: request.userId,
      userEmail: request.currentEmail,
      action: 'email_change_rejected',
      details: {
        requestedEmail: request.requestedEmail,
        rejectedByAdminId: req.user._id,
        reason: request.rejectionReason,
      },
      ipAddress: maskedIp,
      userAgent,
    });

    res.json({
      success: true,
      message: 'Email change request has been rejected.',
    });
  } catch (err) {
    console.error('rejectEmailChangeRequest error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to reject email change request.' });
  }
};

/**
 * POST /api/account/admin/email-requests/:id/revert
 * Administrative recovery path: reverts a 'processing' or 'pending' email request,
 * restores User.email and active Doubts to currentEmail, bumps tokenVersion,
 * and marks status as 'rejected'.
 */
const revertEmailChangeRequest = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    const request = await EmailChangeRequest.findById(id);
    if (!request || !['pending', 'processing'].includes(request.status)) {
      return res.status(404).json({
        success: false,
        message: 'Pending or processing email change request not found.',
      });
    }

    const user = await User.findById(request.userId);
    if (user) {
      user.email = request.currentEmail;
      user.tokenVersion = (user.tokenVersion ?? 0) + 1;
      await user.save();

      await Doubt.updateMany(
        { 'assignedTeacher.id': user._id },
        { $set: { 'assignedTeacher.email': request.currentEmail } }
      ).catch(() => {});

      await Notification.updateMany(
        { readBy: request.requestedEmail },
        { $set: { 'readBy.$[elem]': request.currentEmail } },
        { arrayFilters: [{ elem: request.requestedEmail }] }
      ).catch(() => {});
    }

    request.status = 'rejected';
    request.reviewedBy = req.user._id;
    request.reviewedByName = req.user.name || 'Administrator';
    request.reviewedAt = new Date();
    request.rejectionReason = reason ? String(reason).trim() : 'Reverted by administrator via recovery path.';
    await request.save();

    const { maskedIp, userAgent } = getClientMeta(req);
    await SecurityEvent.create({
      userId: request.userId,
      userEmail: request.currentEmail,
      userRole: user ? user.role : 'teacher',
      action: 'email_change_reverted',
      details: { requestId: request._id, requestedEmail: request.requestedEmail },
      ipAddress: maskedIp,
      userAgent,
    });

    res.json({
      success: true,
      message: 'Email change request reverted successfully. Account restored to original email.',
    });
  } catch (err) {
    console.error('revertEmailChangeRequest error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to revert email change request.' });
  }
};

module.exports = {
  revertEmailChangeRequest,
  getMyAccount,
  updateMyProfile,
  changePassword,
  setInitialPassword,
  getMySecurityEvents,
  revokeOtherSessions,
  requestEmailChange,
  getAdminUsersList,
  adminResetUserPassword,
  getPendingEmailChangeRequests,
  approveEmailChangeRequest,
  rejectEmailChangeRequest,
};
