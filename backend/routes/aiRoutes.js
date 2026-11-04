const express = require('express');
const router = express.Router();
const aiController = require('../controllers/aiController');
const aiImportController = require('../controllers/aiImportController');

// ── Production-Grade Multi-Page AI Import Workspace Endpoints ────────────────
// 1. Initialize session & slice pages
router.post('/import-session/init', aiImportController.initImportSession);

// 2. Fetch full session state (resume & cross-page navigation)
router.get('/import-session/:sessionId', aiImportController.getSessionState);

// 3. Asynchronous page-by-page extraction via Gemini Vision OCR
router.post('/import-session/:sessionId/extract-page', aiImportController.extractPage);

// 4. Update individual question item (LaTeX, toggles, marks, duplicate resolution)
router.patch('/import-session/:sessionId/items/:itemId', aiImportController.updateItem);

// 5. Commit selected items to Central Question Bank with ACID/batch persistence
router.post('/import-session/:sessionId/commit', aiImportController.commitSessionToBank);

// 6. Undo last import batch
router.post('/import-session/:sessionId/undo', aiImportController.undoImport);

// ── Legacy Compatibility Endpoints ──────────────────────────────────────────
router.post('/extract-paper', aiController.extractQuestionsFromDocument);
router.post('/push-to-question-bank', aiController.pushQuestionsToBank);

module.exports = router;
