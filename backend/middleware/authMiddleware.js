const jwt = require('jsonwebtoken');
const User = require('../models/User');

const protect = async (req, res, next) => {
  let token;

  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith('Bearer')
  ) {
    try {
      token = req.headers.authorization.split(' ')[1];
      const secret = process.env.JWT_SECRET || 'asmaths_secret_jwt_key_2026_cluster0';
      const decoded = jwt.verify(token, secret);
      
      if (decoded.id === 'master_admin_id') {
        req.user = { _id: 'master_admin_id', id: 'master_admin_id', role: 'admin', name: 'Dr. A. Sardar', email: 'admin@asmaths.com' };
      } else {
        req.user = await User.findById(decoded.id).select('-password');
      }

      if (!req.user) {
        return res.status(401).json({ message: 'Not authorized: User account not found' });
      }

      next();
      return; // ← IMPORTANT: stop here on success
    } catch (error) {
      console.error(error);
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
    const normalizedRoles = roles.map(r => String(r).toLowerCase());
    if (!normalizedRoles.includes(userRole)) {
      return res.status(403).json({
        message: `Forbidden: Account with role "${userRole}" is not authorized to access this route.`
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
      const secret = process.env.JWT_SECRET || 'asmaths_secret_jwt_key_2026_cluster0';
      const decoded = jwt.verify(token, secret);
      const role = (decoded.role || '').toLowerCase();

      const path = req.originalUrl || req.url || '';
      if (
        role === 'student' &&
        (path.includes('/api/admin') || path.includes('/api/approvals') || path.includes('/approve/') || path.includes('/reject/'))
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

module.exports = {
  protect,
  authorize,
  requireAdmin,
  requireStudent,
  requireAdminOnly,
  requireTeacherOrAdmin,
  requireRole: authorize,
  verifyRoleSegregation,
};
