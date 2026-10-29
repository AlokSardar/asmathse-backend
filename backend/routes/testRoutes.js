const express = require('express');
const router = express.Router();
const { createTest, getTests, getTestById, submitAndEvaluate } = require('../controllers/testController');

router.post('/create', createTest); // Should ideally be protected for admin
router.get('/', getTests); // Fetch tests by stream/sem
router.get('/:id', getTestById); // Fetch single test by ID
router.post('/submit', submitAndEvaluate); // Submit and trigger AI evaluation

module.exports = router;
