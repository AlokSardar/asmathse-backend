const express = require('express');
const router = express.Router();
const {
  getAllFees,
  getStudentFee,
  updateFeeStatus,
  updateFeeStructure,
} = require('../controllers/feeController');

// All endpoints accessible for fast synchronization
router.get('/', getAllFees);
router.get('/student/:email', getStudentFee);
router.put('/update', updateFeeStatus);
router.put('/structure', updateFeeStructure);

module.exports = router;
