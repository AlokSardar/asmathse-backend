const express = require('express');
const router = express.Router();
const { upload } = require('../middleware/uploadMiddleware');
const {
  uploadBufferToCloudinary,
  uploadBase64ToCloudinary,
  isCloudinaryConfigured,
} = require('../services/cloudinaryService');

/**
 * @desc    Upload media/document directly to Cloudinary via multipart form
 * @route   POST /api/upload
 * @access  Public / Protected
 */
router.post('/', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file provided in form-data field "file"' });
    }

    const folder = req.body.folder || 'as_maths/general';
    const result = await uploadBufferToCloudinary(req.file.buffer, {
      fileName: req.file.originalname,
      mimeType: req.file.mimetype,
      folder,
    });

    return res.status(200).json({
      success: true,
      url: result.secure_url,
      secure_url: result.secure_url,
      public_id: result.public_id,
      fileName: req.file.originalname,
      fileSize: result.bytes || req.file.size,
      resourceType: result.resource_type,
      isFallback: Boolean(result.isFallback),
    });
  } catch (error) {
    console.error('Universal upload error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to upload file: ' + error.message,
    });
  }
});

/**
 * @desc    Upload media/document directly to Cloudinary via base64 JSON
 * @route   POST /api/upload/base64
 * @access  Public / Protected
 */
router.post('/base64', async (req, res) => {
  try {
    const { base64Data, fileName, folder = 'as_maths/general' } = req.body || {};
    if (!base64Data) {
      return res.status(400).json({ success: false, message: 'base64Data string is required' });
    }

    const result = await uploadBase64ToCloudinary(base64Data, {
      fileName: fileName || `doc_${Date.now()}.pdf`,
      folder,
    });

    return res.status(200).json({
      success: true,
      url: result.secure_url,
      secure_url: result.secure_url,
      public_id: result.public_id,
      fileName: fileName || result.public_id,
      fileSize: result.bytes || 0,
      resourceType: result.resource_type,
      isFallback: Boolean(result.isFallback),
    });
  } catch (error) {
    console.error('Base64 upload error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to process base64 upload: ' + error.message,
    });
  }
});

/**
 * @desc    Status of Cloudinary service configuration
 * @route   GET /api/upload/status
 * @access  Public
 */
router.get('/status', (req, res) => {
  res.json({
    configured: isCloudinaryConfigured(),
    service: isCloudinaryConfigured() ? 'Cloudinary Cloud Storage' : 'Local Disk Fallback',
    timestamp: new Date().toISOString(),
  });
});

module.exports = router;
