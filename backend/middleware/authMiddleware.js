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

module.exports = { protect, authorize };
