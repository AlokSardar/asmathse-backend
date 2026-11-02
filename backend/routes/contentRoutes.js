const express = require('express');
const router = express.Router();
const {
  getAllContent,
  getContentById,
  saveContent,
  batchSyncContent,
  deleteContent,
  clearAllContent,
  getAnswerKey,
  updateAnswerKey,
  generateAnswerKey,
  generateAnswerKeyStream,
  extractQuestions,
  bulkDeleteContent,
} = require('../controllers/contentController');

const { upload } = require('../middleware/uploadMiddleware');

router.get('/', getAllContent);
router.post('/', upload.single('file'), saveContent);
router.post('/batch', batchSyncContent);
router.post('/extract-questions', upload.single('file'), extractQuestions);
router.post('/bulk-delete', bulkDeleteContent);
router.delete('/', clearAllContent);
router.get('/:id/answer-key', getAnswerKey);
router.put('/:id/answer-key', updateAnswerKey);
router.post('/:id/generate-answer-key', generateAnswerKey);
router.post('/:id/generate-answer-key-stream', generateAnswerKeyStream);
router.get('/:id', getContentById);
router.delete('/:id', deleteContent);

module.exports = router;
