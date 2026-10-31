const express = require('express');
const router = express.Router();
const { createTest, getTests, getTestById, submitAndEvaluate, deleteTest, clearAllTests } = require('../controllers/testController');

router.post('/create', createTest); // Should ideally be protected for admin
router.get('/', getTests); // Fetch tests by stream/sem
router.delete('/', clearAllTests); // Permanently clear all tests
router.get('/:id', getTestById); // Fetch single test by ID
router.delete('/:id', deleteTest); // Permanently delete single test
router.post('/submit', submitAndEvaluate); // Submit and trigger AI evaluation

module.exports = router;
