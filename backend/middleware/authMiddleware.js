const jwt = require('jsonwebtoken');
const { verifyToken } = require('../config/jwt');
const User = require('../models/User');

const protect = async (req, res, next) => {
  let token;

  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith('Bearer')
  ) {
    try {
      token = req.headers.authorization.split(' ')[1];
      const decoded = verifyToken(token);

      if (decoded.id === 'master_admin_id') {
        req.user = {
          _id: 'master_admin_id',
          id: 'master_admin_id',
          role: 'admin',
          name: 'Dr. A. Sardar',
          email: 'admin@asmaths.com',
          tokenVersion: 0,
          mustChangePassword: false,
        };
      } else {
        req.user = await User.findById(decoded.id).select('-password');
      }

      if (!req.user) {
        return res.status(401).json({ message: 'Not authorized: User account not found' });
      }

      // 1. Critical Token Version Verification (Amendment 1)
      if (req.user._id !== 'master_admin_id') {
        const tokenV = decoded.tokenVersion ?? 0;
        const currentV = req.user.tokenVersion ?? 0;
        if (tokenV < currentV) {
          return res.status(401).json({
            success: false,
            code: 'TOKEN_REVOKED',
            message: 'Session has expired or was revoked. Please sign in again.',
          });
        }
      }

      // 2. Server-Side Forced Password Change Guard (Amendment 2)
      if (req.user.mustChangePassword) {
        const path = (req.originalUrl || req.url || '').split('?')[0];
        const method = req.method.toUpperCase();

        const isAllowedMe = method === 'GET' && path.endsWith('/account/me');
        const isAllowedSetPassword = method === 'POST' && path.endsWith('/account/set-initial-password');
        const isAllowedLogout = path.includes('/logout');

        if (!isAllowedMe && !isAllowedSetPassword && !isAllowedLogout) {
          return res.status(403).json({
            success: false,
            code: 'MUST_CHANGE_PASSWORD',
            message: 'Temporary password must be replaced before accessing portal features.',
          });
        }
      }

      next();
      return;
    } catch (error) {
      console.error('Auth error in protect middleware:', error.message);
      return res.status(401).json({ message: 'Not authorized, token failed' });
    }
  }

  if (!token) {
    return res.status(401).json({ message: 'Not authorized, no token' });
  }
};

const authorize = (...roles) => {
  return (req, res, next) => {
    const userRole = String(req.user?.role || '').toLowerCase();
    const normalizedRoles = roles.map((r) => String(r).toLowerCase());
    if (!normalizedRoles.includes(userRole)) {
      return res.status(403).json({
        message: `Forbidden: Account with role "${userRole}" is not authorized to access this route.`,
      });
    }
    next();
  };
};

/**
 * Explicit Role-Segregation Guards:
 * Segregates Student and Teacher/Admin access to prevent unauthorized privilege escalation.
 */
const requireAdmin = [protect, authorize('admin', 'teacher')];
const requireStudent = [protect, authorize('student')];
const requireAdminOnly = [protect, authorize('admin')];
const requireTeacherOrAdmin = [protect, authorize('teacher', 'admin')];

/**
 * Non-destructive Role-Segregation Inspector:
 * Whenever an authorization header is present, ensures student tokens cannot
 * execute administrative mutations or approval actions.
 */
const verifyRoleSegregation = (req, res, next) => {
  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
    try {
      const token = req.headers.authorization.split(' ')[1];
      const decoded = verifyToken(token);
      const role = (decoded.role || '').toLowerCase();

      const path = req.originalUrl || req.url || '';
      if (
        role === 'student' &&
        (path.includes('/api/admin') ||
          path.includes('/api/approvals') ||
          path.includes('/approve/') ||
          path.includes('/reject/') ||
          path.includes('/api/account/admin'))
      ) {
        return res.status(403).json({
          success: false,
          message: 'Forbidden: Student accounts are not permitted to access administrative management endpoints.',
        });
      }
    } catch (_) {
      // Allow protected handlers to return standard 401 on malformed tokens
    }
  }
  next();
};


/**
 * Soft Authentication Guard (optionalAuth):
 * - If Authorization header with Bearer token is present:
 *   Attempts token verification. If valid, attaches req.user.
 *   If token is missing, expired (TokenExpiredError), malformed (JsonWebTokenError),
 *   or invalid signature, softly sets req.user = null and continues without error.
 * - If no Authorization header: sets req.user = null and continues.
 */
const optionalAuth = async (req, res, next) => {
  req.user = null;
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return next();
  }

  const rawToken = authHeader.split(' ')[1];
  if (!rawToken || !rawToken.trim()) {
    return next();
  }

  try {
    const decoded = verifyToken(rawToken.trim());
    if (decoded && decoded.id) {
      if (decoded.id === 'master_admin_id') {
        req.user = {
          _id: 'master_admin_id',
          id: 'master_admin_id',
          role: 'admin',
          name: 'Dr. A. Sardar',
          email: 'admin@asmaths.com',
          tokenVersion: 0,
          mustChangePassword: false,
        };
      } else {
        const user = await User.findById(decoded.id).select('-password');
        if (user) {
          const tokenV = decoded.tokenVersion ?? 0;
          const currentV = user.tokenVersion ?? 0;
          if (tokenV >= currentV) {
            req.user = user;
          }
        }
      }
    }
  } catch (_) {
    // Soft fail silently on TokenExpiredError, JsonWebTokenError, invalid signature, etc.
    req.user = null;
  }

  next();
};

module.exports = {
  optionalAuth,
  protect,
  authorize,
  requireAdmin,
  requireStudent,
  requireAdminOnly,
  requireTeacherOrAdmin,
  requireRole: authorize,
  verifyRoleSegregation,
};
