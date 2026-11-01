const multer = require('multer');
const path = require('path');
const { uploadBufferToCloudinary } = require('../services/cloudinaryService');

/**
 * In-memory storage for direct Cloudinary streaming
 * Eliminates disk I/O and prevents orphan temporary files
 */
const storage = multer.memoryStorage();

/**
 * File filter to validate acceptable academic content formats
 */
const fileFilter = (req, file, cb) => {
  const allowedExtensions = [
    '.pdf', '.png', '.jpg', '.jpeg', '.webp', '.gif',
    '.doc', '.docx', '.webm', '.mp4', '.txt',
  ];
  const ext = path.extname(file.originalname).toLowerCase();

  if (allowedExtensions.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error(`Unsupported file type (${ext}). Allowed types: PDF, PNG, JPG, JPEG, WEBP, DOC, DOCX, MP4, WEBM`));
  }
};

const upload = multer({
  storage,
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB maximum size limit
  },
  fileFilter,
});

/**
 * Middleware that intercepts req.file from multer (memoryStorage)
 * and streams it directly to Cloudinary, attaching `req.fileUrl` and `req.cloudinaryResult`
 */
const streamToCloudinary = (folder = 'as_maths/content') => {
  return async (req, res, next) => {
    if (!req.file) {
      return next();
    }

    try {
      const result = await uploadBufferToCloudinary(req.file.buffer, {
        fileName: req.file.originalname,
        mimeType: req.file.mimetype,
        folder,
      });

      req.fileUrl = result.secure_url;
      req.cloudinaryResult = result;

      // Provide backward compatibility with existing controller expectations
      req.file.path = result.secure_url;
      req.file.url = result.secure_url;
      req.file.secure_url = result.secure_url;

      next();
    } catch (err) {
      console.error('[UPLOAD MIDDLEWARE] Cloudinary streaming failed:', err);
      return res.status(500).json({
        success: false,
        message: 'Failed to upload media to cloud storage: ' + err.message,
      });
    }
  };
};

module.exports = {
  upload,
  streamToCloudinary,
  singleUpload: (fieldName = 'file', folder = 'as_maths/content') => [
    upload.single(fieldName),
    streamToCloudinary(folder),
  ],
};
