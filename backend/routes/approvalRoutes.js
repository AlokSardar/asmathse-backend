const express = require('express');
const router = express.Router();
const {
  getPendingApprovals,
  approveStudent,
  rejectStudent,
} = require('../controllers/authController');

// GET /api/approvals & /api/approvals/pending
router.get('/', getPendingApprovals);
router.get('/pending', getPendingApprovals);

// PUT /api/approvals/:id -> handle approve OR reject based on req.body
router.put('/:id', (req, res, next) => {
  const action = (req.body?.action || req.body?.status || '').toLowerCase();
  if (action === 'reject' || action === 'rejected' || action === 'delete') {
    return rejectStudent(req, res, next);
  }
  return approveStudent(req, res, next);
});

// Explicit action routes
router.put('/:id/approve', approveStudent);
router.post('/:id/approve', approveStudent);
router.put('/:id/reject', rejectStudent);
router.post('/:id/reject', rejectStudent);

// DELETE /api/approvals/:id & DELETE /api/approvals/:id/reject
router.delete('/:id', rejectStudent);
router.delete('/:id/reject', rejectStudent);

module.exports = router;
