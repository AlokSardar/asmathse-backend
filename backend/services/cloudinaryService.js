const cloudinary = require('cloudinary').v2;
const fs = require('fs');
const path = require('path');
const stream = require('stream');

// Ensure local uploads fallback directory exists
const uploadsDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

/**
 * Configure Cloudinary with environment variables
 */
const cloudName = process.env.CLOUDINARY_CLOUD_NAME || process.env.CLOUD_NAME;
const apiKey = process.env.CLOUDINARY_API_KEY || process.env.API_KEY;
const apiSecret = process.env.CLOUDINARY_API_SECRET || process.env.API_SECRET;

if (cloudName && apiKey && apiSecret) {
  cloudinary.config({
    cloud_name: cloudName,
    api_key: apiKey,
    api_secret: apiSecret,
    secure: true,
  });
} else if (process.env.CLOUDINARY_URL) {
  // Automatically parsed by cloudinary SDK
}

/**
 * Check if Cloudinary credentials are fully configured
 */
const isCloudinaryConfigured = () => {
  return Boolean(
    (cloudName && apiKey && apiSecret) || process.env.CLOUDINARY_URL
  );
};

/**
 * Determine Cloudinary resource_type based on file extension and MIME type
 */
const getResourceType = (filename = '', mimeType = '') => {
  const ext = path.extname(filename).toLowerCase();
  const mime = String(mimeType).toLowerCase();

  if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.bmp', '.ico'].includes(ext) || mime.startsWith('image/')) {
    return 'image';
  }
  if (['.mp4', '.webm', '.mov', '.avi', '.mkv'].includes(ext) || mime.startsWith('video/')) {
    return 'video';
  }
  if (ext === '.pdf' || mime === 'application/pdf') {
    // Cloudinary supports 'auto' or 'image' for PDF (allows page previews and direct viewing)
    return 'auto';
  }
  // Documents like docx, xlsx, pptx, zip
  return 'raw';
};

/**
 * Upload a Buffer directly to Cloudinary using upload_stream
 * Falls back to local disk storage if Cloudinary is not configured or fails
 */
const uploadBufferToCloudinary = (buffer, options = {}) => {
  return new Promise((resolve, reject) => {
    const folder = options.folder || 'as_maths/content';
    const resourceType = options.resource_type || getResourceType(options.fileName, options.mimeType);
    const fileName = options.fileName || `file_${Date.now()}`;
    const ext = path.extname(fileName) || '.pdf';
    const baseName = path.basename(fileName, ext).replace(/[^a-zA-Z0-9_-]/g, '_');

    // If Cloudinary is not configured, fall back gracefully to local disk
    if (!isCloudinaryConfigured()) {
      try {
        const safeDiskName = `${Date.now()}_${Math.random().toString(36).substr(2, 6)}${ext}`;
        const targetPath = path.join(uploadsDir, safeDiskName);
        fs.writeFileSync(targetPath, buffer);
        return resolve({
          success: true,
          secure_url: `/uploads/${safeDiskName}`,
          url: `/uploads/${safeDiskName}`,
          public_id: safeDiskName,
          resource_type: resourceType,
          bytes: buffer.length,
          isFallback: true,
        });
      } catch (err) {
        return reject(err);
      }
    }

    const uploadOptions = {
      folder,
      resource_type: resourceType,
      public_id: `${baseName}_${Date.now()}`,
      use_filename: true,
      unique_filename: true,
      overwrite: false,
      ...options,
    };

    const uploadStream = cloudinary.uploader.upload_stream(
      uploadOptions,
      (error, result) => {
        if (error) {
          console.warn('[CLOUDINARY] Upload error, engaging local fallback:', error.message);
          // Graceful fallback to local disk
          try {
            const safeDiskName = `${Date.now()}_${Math.random().toString(36).substr(2, 6)}${ext}`;
            const targetPath = path.join(uploadsDir, safeDiskName);
            fs.writeFileSync(targetPath, buffer);
            return resolve({
              success: true,
              secure_url: `/uploads/${safeDiskName}`,
              url: `/uploads/${safeDiskName}`,
              public_id: safeDiskName,
              resource_type: resourceType,
              bytes: buffer.length,
              isFallback: true,
              warning: error.message,
            });
          } catch (writeErr) {
            return reject(new Error('Cloudinary upload and local fallback both failed: ' + writeErr.message));
          }
        }

        resolve({
          success: true,
          secure_url: result.secure_url,
          url: result.url,
          public_id: result.public_id,
          format: result.format,
          resource_type: result.resource_type,
          bytes: result.bytes,
          width: result.width,
          height: result.height,
        });
      }
    );

    const bufferStream = new stream.PassThrough();
    bufferStream.end(buffer);
    bufferStream.pipe(uploadStream);
  });
};

/**
 * Upload a Base64 string directly to Cloudinary
 * Handles data URLs (data:image/png;base64,...) or raw base64
 */
const uploadBase64ToCloudinary = async (base64String, options = {}) => {
  if (!base64String || typeof base64String !== 'string') {
    throw new Error('Valid base64 string is required for upload');
  }

  let mimeType = options.mimeType || 'application/pdf';
  let cleanBase64 = base64String;

  if (base64String.startsWith('data:')) {
    const matches = base64String.match(/^data:([A-Za-z0-9-+/]+);base64,(.+)$/);
    if (matches && matches.length === 3) {
      mimeType = matches[1];
      cleanBase64 = matches[2];
    }
  }

  const buffer = Buffer.from(cleanBase64, 'base64');
  return uploadBufferToCloudinary(buffer, { ...options, mimeType });
};

/**
 * Upload a file from disk path directly to Cloudinary and clean up temp file
 */
const uploadDiskFileToCloudinary = async (filePath, options = {}) => {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found at path: ${filePath}`);
  }

  const fileName = options.fileName || path.basename(filePath);
  const buffer = fs.readFileSync(filePath);
  const result = await uploadBufferToCloudinary(buffer, { ...options, fileName });

  // Clean up disk file after successful Cloudinary upload
  if (result.secure_url && !result.isFallback && options.cleanup !== false) {
    try {
      fs.unlinkSync(filePath);
    } catch (_) {}
  }

  return result;
};

/**
 * Delete a media file from Cloudinary by public_id
 */
const deleteFromCloudinary = async (publicId, resourceType = 'image') => {
  if (!isCloudinaryConfigured() || !publicId) return null;
  try {
    return await cloudinary.uploader.destroy(publicId, { resource_type: resourceType });
  } catch (err) {
    console.warn('[CLOUDINARY] Destroy failed for ID:', publicId, err.message);
    return null;
  }
};

/**
 * Normalize and resolve media URL for backward compatibility
 * Guarantees legacy `/uploads/...` paths and direct Cloudinary HTTPS URLs both resolve
 */
const resolveMediaUrl = (fileRef) => {
  if (!fileRef || typeof fileRef !== 'string') return null;
  const trimmed = fileRef.trim();
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return trimmed;
  }
  if (trimmed.startsWith('/uploads/') || trimmed.startsWith('uploads/')) {
    return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  }
  return trimmed;
};

module.exports = {
  cloudinary,
  isCloudinaryConfigured,
  uploadBufferToCloudinary,
  uploadBase64ToCloudinary,
  uploadDiskFileToCloudinary,
  deleteFromCloudinary,
  resolveMediaUrl,
  getResourceType,
};
