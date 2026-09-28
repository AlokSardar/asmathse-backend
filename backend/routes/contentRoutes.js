const express = require('express');
const router = express.Router();
const {
  getAllContent,
  getContentById,
  saveContent,
  batchSyncContent,
  deleteContent,
  clearAllContent,
} = require('../controllers/contentController');

router.get('/', getAllContent);
router.post('/', saveContent);
router.post('/batch', batchSyncContent);
router.delete('/', clearAllContent);
router.get('/:id', getContentById);
router.delete('/:id', deleteContent);

module.exports = router;
