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
} = require('../controllers/contentController');

const multer = require('multer');
const path = require('path');
const fs = require('fs');

const uploadsDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.pdf';
    const safeName = `${Date.now()}_${Math.random().toString(36).substr(2, 8)}${ext}`;
    cb(null, safeName);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
});

router.get('/', getAllContent);
router.post('/', upload.single('file'), saveContent);
router.post('/batch', batchSyncContent);
router.delete('/', clearAllContent);
router.get('/:id/answer-key', getAnswerKey);
router.put('/:id/answer-key', updateAnswerKey);
router.post('/:id/generate-answer-key', generateAnswerKey);
router.get('/:id', getContentById);
router.delete('/:id', deleteContent);

module.exports = router;
