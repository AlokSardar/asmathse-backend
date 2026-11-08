const express = require('express');
const router = express.Router();
const {
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
  revertEmailChangeRequest,
} = require('../controllers/accountController');
const { protect, authorize } = require('../middleware/authMiddleware');

// All account endpoints require valid authentication
router.use(protect);

// ── Profile, Security & Preferences (Any authenticated user: Teacher/Admin) ──
router.get('/me', getMyAccount);
router.patch('/profile', updateMyProfile);
router.post('/change-password', changePassword);
router.post('/set-initial-password', setInitialPassword);
router.get('/security-events', getMySecurityEvents);
router.post('/sessions/revoke-others', revokeOtherSessions);
router.post('/email-change-request', requestEmailChange);

// ── Administrative User Management (Admin Only) ──
router.get('/admin/users', authorize('admin'), getAdminUsersList);
router.post('/admin/reset-password', authorize('admin'), adminResetUserPassword);
router.get('/admin/email-requests', authorize('admin'), getPendingEmailChangeRequests);
router.post('/admin/email-requests/:id/approve', authorize('admin'), approveEmailChangeRequest);
router.post('/admin/email-requests/:id/reject', authorize('admin'), rejectEmailChangeRequest);
router.post('/admin/email-requests/:id/revert', authorize('admin'), revertEmailChangeRequest);

module.exports = router;
