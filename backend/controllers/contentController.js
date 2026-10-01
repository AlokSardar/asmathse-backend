const mongoose = require('mongoose');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Content = require('../models/Content');
const Notification = require('../models/Notification');

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Helper to construct safe ID query
const buildIdQuery = (targetId) => {
  if (mongoose.Types.ObjectId.isValid(targetId)) {
    return { $or: [{ id: targetId }, { _id: targetId }] };
  }
  return { id: targetId };
};

// Helper: Extract YouTube Video ID
const extractYouTubeVideoId = (url) => {
  if (!url || typeof url !== 'string') return null;
  const regExp = /(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=))([\w-]{11})/;
  const match = url.trim().match(regExp);
  return (match && match[1]) ? match[1] : null;
};

const escapeRegex = (str) => {
  if (typeof str !== 'string') return '';
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
};

// @desc    Get all academic content (with optional filters)
// @route   GET /api/content
// @access  Public
const getAllContent = async (req, res) => {
  try {
    const { course, branch, semester, classLevel, subject, type, resourceType } = req.query;
    const query = {};

    if (course) {
      query.course = new RegExp(`^${escapeRegex(course)}$`, 'i');
    }

    if (branch) {
      if (course === 'bsc') {
        const isHonours = /honour|major/i.test(branch);
        query.branch = isHonours ? /honour|major/i : /general|pass/i;
      } else if (course === 'jee') {
        // Unified JEE matches all JEE materials
      } else {
        query.branch = new RegExp(`^${escapeRegex(branch)}$`, 'i');
      }
    }

    if (semester !== undefined && semester !== null && semester !== '') {
      query.semester = { $in: [Number(semester), String(semester)] };
    }

    if (classLevel && course !== 'jee') {
      query.classLevel = new RegExp(`^${escapeRegex(classLevel)}$`, 'i');
    }

    if (subject && course !== 'jee') {
      query.subject = new RegExp(`^${escapeRegex(subject)}$`, 'i');
    }

    if (type) query.type = new RegExp(`^${escapeRegex(type)}$`, 'i');
    if (resourceType) query.resourceType = resourceType;

    const items = await Content.find(query).sort({ uploadedAt: -1, createdAt: -1 });
    res.json(items);
  } catch (error) {
    console.error('Error fetching content:', error);
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get single content item
// @route   GET /api/content/:id
// @access  Public
const getContentById = async (req, res) => {
  try {
    const item = await Content.findOne(buildIdQuery(req.params.id));
    if (!item) {
      return res.status(404).json({ message: 'Content item not found' });
    }
    res.json(item);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Create or upsert content item with File Hashing & Free Tier Local Storage
// @route   POST /api/content
// @access  Public
const saveContent = async (req, res) => {
  try {
    const itemData = req.body;
    if (!itemData.title) {
      return res.status(400).json({ message: 'Title is required' });
    }

    const id = itemData.id || `up_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    let fileHash = itemData.fileHash || null;
    let fileUrl = itemData.fileUrl || null;
    let filePath = itemData.filePath || null;
    let resourceType = itemData.resourceType || 'document';
    let videoUrl = itemData.videoUrl || null;
    let videoId = itemData.videoId || null;
    let thumbnailUrl = itemData.thumbnailUrl || null;

    // ── 1. YouTube Video Resource Handling ─────────────────────────────
    if (resourceType === 'youtube' || videoUrl) {
      resourceType = 'youtube';
      const extractedId = extractYouTubeVideoId(videoUrl);
      if (!extractedId) {
        return res.status(400).json({
          message: 'Error: Please enter a valid YouTube video URL (e.g., https://www.youtube.com/watch?v=... or https://youtu.be/...)',
        });
      }
      videoId = extractedId;
      thumbnailUrl = `https://img.youtube.com/vi/${extractedId}/hqdefault.jpg`;
      fileUrl = null;
      fileHash = null;
    }

    // ── 2. Document File Hashing & Duplicate Prevention ────────────────
    else if (itemData.fileDataUrl && itemData.fileDataUrl.startsWith('data:')) {
      try {
        const commaIndex = itemData.fileDataUrl.indexOf(',');
        const base64Data = commaIndex !== -1 ? itemData.fileDataUrl.substring(commaIndex + 1) : itemData.fileDataUrl;
        const fileBuffer = Buffer.from(base64Data, 'base64');

        // Calculate SHA-256 hash of the uploaded file
        fileHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');

        // Check MongoDB for exact duplicate hash
        const duplicateItem = await Content.findOne({ fileHash });
        if (duplicateItem && duplicateItem.id !== id) {
          console.warn(`[UPLOAD ABORTED] Duplicate file detected. Hash: ${fileHash}, Existing: ${duplicateItem.title}`);
          return res.status(409).json({
            message: 'Error: This content already exists / Already uploaded!',
            duplicate: true,
            existingTitle: duplicateItem.title,
            existingId: duplicateItem.id,
          });
        }

        // Save file to backend/uploads on the local file system (avoiding Atlas Free Tier bloat)
        const originalName = itemData.fileName || 'document.pdf';
        const ext = path.extname(originalName) || (originalName.toLowerCase().endsWith('.docx') ? '.docx' : '.pdf');
        
        // Auto-detect specific document resourceType
        const lowerExt = ext.toLowerCase();
        if (lowerExt === '.pdf') {
          resourceType = 'pdf';
        } else if (lowerExt === '.doc' || lowerExt === '.docx') {
          resourceType = 'docx';
        } else if (['.png', '.jpg', '.jpeg', '.webp'].includes(lowerExt)) {
          resourceType = 'image';
        } else {
          resourceType = 'document';
        }

        const safeDiskName = `${Date.now()}_${fileHash.substring(0, 10)}${ext}`;
        const diskPath = path.join(uploadsDir, safeDiskName);
        fs.writeFileSync(diskPath, fileBuffer);

        filePath = safeDiskName;
        fileUrl = `/uploads/${safeDiskName}`;
      } catch (err) {
        console.error('File hashing/saving error:', err);
        return res.status(500).json({ message: 'Failed to process file upload: ' + err.message });
      }
    } else if (itemData.fileName) {
      // Determine resourceType from existing fileName
      const lower = itemData.fileName.toLowerCase();
      if (lower.endsWith('.pdf')) resourceType = 'pdf';
      else if (lower.endsWith('.doc') || lower.endsWith('.docx')) resourceType = 'docx';
      else if (lower.endsWith('.png') || lower.endsWith('.jpg') || lower.endsWith('.jpeg')) resourceType = 'image';
    }

    const payload = {
      ...itemData,
      id,
      resourceType,
      videoUrl,
      videoId,
      thumbnailUrl,
      fileHash,
      fileUrl,
      filePath,
      fileDataUrl: null, // Zero base64 payload stored in MongoDB Atlas free tier!
      uploadedAt: itemData.uploadedAt || new Date(),
    };

    // Check if this is an update vs new creation
    const existingRecord = await Content.findOne({ id });

    // Upsert by custom id
    const saved = await Content.findOneAndUpdate(
      { id },
      { $set: payload },
      { new: true, upsert: true, runValidators: false }
    );

    // ── 3. Automatic Notification Generation for Students ─────────────
    if (!existingRecord) {
      try {
        const typeLabels = {
          syllabus: 'Syllabus Document',
          materials: resourceType === 'youtube' ? 'Video Lecture' : 'Study Material',
          pyq: 'Previous Year Question (PYQ)',
          assignment: 'Assignment Sheet',
          classtest: 'Class Test & Exam Paper',
        };
        const label = typeLabels[saved.type] || 'Academic Update';
        const streamInfo = saved.branch || saved.classLevel || saved.course?.toUpperCase() || 'All Batches';

        await Notification.create({
          id: `notif_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
          title: `New ${label} Published`,
          message: `"${saved.title}" is now available for ${streamInfo}${saved.semester ? ` (Sem ${saved.semester})` : ''}.`,
          type: saved.type,
          resourceType: saved.resourceType,
          course: saved.course,
          branch: saved.branch,
          semester: saved.semester,
          classLevel: saved.classLevel,
          subject: saved.subject,
          contentId: saved.id,
        });
      } catch (notifErr) {
        console.warn('Auto notification generation notice:', notifErr.message);
      }
    }

    res.status(201).json(saved);
  } catch (error) {
    console.error('Error saving content to MongoDB Atlas:', error);
    res.status(500).json({ message: error.message });
  }
};

// @desc    Batch sync multiple content items
// @route   POST /api/content/batch
// @access  Public
const batchSyncContent = async (req, res) => {
  try {
    const { items } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      return res.json({ count: 0, message: 'No items provided' });
    }

    const ops = items.map((item) => {
      const id = item.id || `up_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
      return {
        updateOne: {
          filter: { id },
          update: { 
            $set: { 
              ...item, 
              id, 
              uploadedAt: item.uploadedAt || new Date() 
            } 
          },
          upsert: true,
        },
      };
    });

    const result = await Content.bulkWrite(ops);
    res.json({
      success: true,
      upsertedCount: result.upsertedCount,
      modifiedCount: result.modifiedCount,
      matchedCount: result.matchedCount,
    });
  } catch (error) {
    console.error('Error in batchSyncContent:', error);
    res.status(500).json({ message: error.message });
  }
};

// @desc    Delete content item & local file
// @route   DELETE /api/content/:id
// @access  Public
const deleteContent = async (req, res) => {
  try {
    const targetId = req.params.id;
    const item = await Content.findOne(buildIdQuery(targetId));
    if (!item) {
      return res.status(404).json({ message: 'Content item not found' });
    }

    // Clean up file on disk if stored locally
    if (item.filePath) {
      try {
        const fullDiskPath = path.join(uploadsDir, item.filePath);
        if (fs.existsSync(fullDiskPath)) {
          fs.unlinkSync(fullDiskPath);
        }
      } catch (fileErr) {
        console.warn('Notice: Local file cleanup:', fileErr.message);
      }
    }

    await Content.deleteOne({ _id: item._id });

    // Clean up associated notifications
    await Notification.deleteMany({ contentId: item.id }).catch(() => {});

    res.json({ success: true, message: 'Item and file permanently deleted' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Clear all content items
// @route   DELETE /api/content
// @access  Public
const clearAllContent = async (req, res) => {
  try {
    await Content.deleteMany({});
    await Notification.deleteMany({});
    res.json({ success: true, message: 'All content cleared from MongoDB Atlas' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  getAllContent,
  getContentById,
  saveContent,
  batchSyncContent,
  deleteContent,
  clearAllContent,
};
