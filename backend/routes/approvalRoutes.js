const express = require('express');
const router = express.Router();
const {
  protect,
  authorize,
  requireAdminOnly,
} = require('../middleware/authMiddleware');
const approvalController = require('../controllers/approvalController');

// All approval routes are strictly restricted to Administrators (teachers get 403 Forbidden)
const adminGuard = requireAdminOnly || [protect, authorize('admin')];

// GET /api/approvals/stats - live badge counts and trend
router.get('/stats', adminGuard, approvalController.getApprovalStats);

// GET /api/approvals & /api/approvals/pending - list with filters and counts
router.get('/', adminGuard, approvalController.getApprovals);
router.get('/pending', adminGuard, (req, res, next) => {
  req.query.status = 'pending';
  return approvalController.getApprovals(req, res, next);
});

// POST /api/approvals/bulk - bulk approve / reject / suspend
router.post('/bulk', adminGuard, approvalController.bulkApprovals);

// Action endpoints:
// Approve
router.patch('/:userId/approve', adminGuard, approvalController.approveStudent);
router.put('/:userId/approve', adminGuard, approvalController.approveStudent);
router.post('/:userId/approve', adminGuard, approvalController.approveStudent);

// Reject
router.patch('/:userId/reject', adminGuard, approvalController.rejectStudent);
router.put('/:userId/reject', adminGuard, approvalController.rejectStudent);
router.post('/:userId/reject', adminGuard, approvalController.rejectStudent);
router.delete('/:userId/reject', adminGuard, approvalController.rejectStudent);
router.delete('/:userId', adminGuard, approvalController.rejectStudent);

// Suspend & Reinstate
router.patch('/:userId/suspend', adminGuard, approvalController.suspendStudent);
router.put('/:userId/suspend', adminGuard, approvalController.suspendStudent);
router.patch('/:userId/reinstate', adminGuard, approvalController.reinstateStudent);
router.put('/:userId/reinstate', adminGuard, approvalController.reinstateStudent);

// General action fallback
router.put('/:userId', adminGuard, (req, res, next) => {
  const action = (req.body?.action || req.body?.status || '').toLowerCase();
  if (action === 'reject' || action === 'rejected' || action === 'delete') {
    return approvalController.rejectStudent(req, res, next);
  }
  if (action === 'suspend' || action === 'suspended') {
    return approvalController.suspendStudent(req, res, next);
  }
  if (action === 'reinstate') {
    return approvalController.reinstateStudent(req, res, next);
  }
  return approvalController.approveStudent(req, res, next);
});

module.exports = router;
