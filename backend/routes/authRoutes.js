const express = require('express');
const router = express.Router();
const {
  registerUser,
  sendOtp,
  verifyOtp,
  loginUser,
  getUserProfile,
  getAllUsers,
  batchSyncUsers,
  completeOnboarding,
  getPendingApprovals,
  approveStudent,
  rejectStudent,
  updateProfile,
  forgotPassword,
  resetPassword,
} = require('../controllers/authController');
const { protect } = require('../middleware/authMiddleware');

router.post('/register', registerUser);
router.post('/send-otp', sendOtp);
router.post('/verify-otp', verifyOtp);
router.post('/login', loginUser);
router.post('/onboarding', completeOnboarding);
router.put('/onboarding', completeOnboarding);
router.get('/profile', protect, getUserProfile);
router.put('/profile', updateProfile);
router.put('/update-credentials', updateProfile);
router.get('/users', getAllUsers);
router.post('/batch', batchSyncUsers);

// Password Recovery Flow
router.post('/forgot-password', forgotPassword);
router.post('/reset-password/:token', resetPassword);

// Student Registration Approvals
router.get('/pending-approvals', getPendingApprovals);
router.put('/approve/:id', approveStudent);
router.delete('/reject/:id', rejectStudent);

module.exports = router;
