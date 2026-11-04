const express = require('express');
const router = express.Router();
const aiController = require('../controllers/aiController');

// Multimodal document extraction using Google Gemini API
router.post('/extract-paper', aiController.extractQuestionsFromDocument);

// Bulk append verified questions to Central Question Bank
router.post('/push-to-question-bank', aiController.pushQuestionsToBank);

module.exports = router;
