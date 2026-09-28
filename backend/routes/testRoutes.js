const express = require('express');
const router = express.Router();
const { createTest, getTests, submitAndEvaluate } = require('../controllers/testController');

router.post('/create', createTest); // Should ideally be protected for admin
router.get('/', getTests); // Fetch tests by stream/sem
router.post('/submit', submitAndEvaluate); // Submit and trigger AI evaluation

module.exports = router;
