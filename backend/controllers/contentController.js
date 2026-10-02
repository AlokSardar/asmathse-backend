const mongoose = require('mongoose');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Content = require('../models/Content');
const Notification = require('../models/Notification');
const { generateAnswerKeyForQuestionPaper } = require('../services/geminiService');

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

    const isClassTest = itemData.type === 'classtest' || itemData.type === 'classtests';
    const isAssignment = itemData.type === 'assignment' || itemData.type === 'assignments';
    const isTestItem = isClassTest || isAssignment;

    // Unique Test_ID to strictly isolate test submissions, question papers, and answer keys
    const testId = itemData.testId || (isTestItem ? `TEST_${Date.now()}_${Math.random().toString(36).substr(2, 6).toUpperCase()}` : (itemData.id || `up_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`));
    const id = itemData.id || testId;

    let fileHash = itemData.fileHash || null;
    let fileUrl = itemData.fileUrl || null;
    let filePath = itemData.filePath || null;
    let resourceType = itemData.resourceType || 'document';
    let videoUrl = itemData.videoUrl || null;
    let videoId = itemData.videoId || null;
    let thumbnailUrl = itemData.thumbnailUrl || null;

    let uploadedBuffer = null;
    let uploadedMime = 'application/pdf';
    let uploadedDiskPath = null;

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
        uploadedBuffer = fileBuffer;

        // Calculate SHA-256 hash of the uploaded file
        fileHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');

        // Check MongoDB for exact duplicate hash
        const duplicateItem = await Content.findOne({ fileHash });
        if (duplicateItem && duplicateItem.id !== id && duplicateItem.testId !== testId) {
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
          uploadedMime = 'application/pdf';
        } else if (lowerExt === '.doc' || lowerExt === '.docx') {
          resourceType = 'docx';
          uploadedMime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
        } else if (['.png', '.jpg', '.jpeg', '.webp'].includes(lowerExt)) {
          resourceType = 'image';
          uploadedMime = lowerExt === '.png' ? 'image/png' : 'image/jpeg';
        } else {
          resourceType = 'document';
        }

        const safeDiskName = `${Date.now()}_${fileHash.substring(0, 10)}${ext}`;
        const diskPath = path.join(uploadsDir, safeDiskName);
        fs.writeFileSync(diskPath, fileBuffer);
        uploadedDiskPath = diskPath;

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
      testId: isTestItem ? testId : (itemData.testId || null),
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
    const existingRecord = await Content.findOne({ $or: [{ id }, ...(testId ? [{ testId }] : [])] });

    // ── Pre-Computed Step-by-Step LaTeX Answer Key (Google Gemini API) ──
    if (isTestItem && (!existingRecord || !existingRecord.answerKey || !existingRecord.answerKey.solutionSet?.length)) {
      try {
        const generatedKey = await generateAnswerKeyForQuestionPaper({
          title: itemData.title,
          course: itemData.course,
          branch: itemData.branch,
          classLevel: itemData.classLevel,
          subject: itemData.subject || 'Mathematics',
          marks: itemData.marks || itemData.fullMarks || 50,
          fileBuffer: uploadedBuffer,
          fileMime: uploadedMime,
          textContent: itemData.questionText || itemData.description || '',
          localPath: uploadedDiskPath,
        });
        payload.answerKey = generatedKey;
      } catch (keyErr) {
        console.warn('Answer key generation notice:', keyErr.message);
      }
    }

    // Upsert by custom id or testId
    const saved = await Content.findOneAndUpdate(
      { $or: [{ id }, ...(testId ? [{ testId }] : [])] },
      { $set: payload },
      { new: true, upsert: true, runValidators: false }
    );

    // ── 3. Automatic Real-Time Notification for Students ─────────────
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

        const notifTitle = isClassTest
          ? 'New Question Paper Uploaded'
          : `New ${label} Published`;
        const notifMsg = isClassTest
          ? `New Question Paper Uploaded for ${saved.title}`
          : `"${saved.title}" is now available for ${streamInfo}${saved.semester ? ` (Sem ${saved.semester})` : ''}.`;

        await Notification.create({
          id: `notif_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
          title: notifTitle,
          message: notifMsg,
          type: saved.type,
          resourceType: saved.resourceType,
          course: saved.course,
          branch: saved.branch,
          semester: saved.semester,
          classLevel: saved.classLevel,
          subject: saved.subject,
          contentId: saved.testId || saved.id,
        });
        console.log(`📢 [REAL-TIME NOTIFICATION DISPATCHED]: "${notifTitle}: ${notifMsg}"`);
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

// @desc    Get pre-computed LaTeX answer key for a test
// @route   GET /api/content/:id/answer-key
// @access  Public
const getAnswerKey = async (req, res) => {
  try {
    const targetId = req.params.id;
    const item = await Content.findOne(buildIdQuery(targetId));
    if (!item) {
      return res.status(404).json({ message: 'Test not found' });
    }
    res.json({
      testId: item.testId || item.id,
      title: item.title,
      marks: item.marks || item.fullMarks || 50,
      answerKey: item.answerKey || { questions: [], status: 'draft' },
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Update or lock LaTeX answer key (enforced questions[] schema)
// @route   PUT /api/content/:id/answer-key
// @access  Public
const updateAnswerKey = async (req, res) => {
  try {
    const targetId = req.params.id;
    const incomingKey = req.body; // full answerKey object

    const item = await Content.findOne(buildIdQuery(targetId));
    if (!item) {
      return res.status(404).json({ message: 'Test not found' });
    }

    const currentKey = item.answerKey || {};
    const updatedKey = {
      ...currentKey,
      ...incomingKey,
      generatedBy: incomingKey.generatedBy || currentKey.generatedBy || 'Google Gemini API',
      questions: incomingKey.questions || currentKey.questions || [],
      status: incomingKey.status || currentKey.status || 'draft',
      lockedAt: incomingKey.status === 'locked' ? new Date() : (incomingKey.status === 'draft' ? null : currentKey.lockedAt),
      updatedAt: new Date(),
    };

    item.answerKey = updatedKey;
    await item.save();

    const questionCount = Array.isArray(updatedKey.questions) ? updatedKey.questions.length : 0;
    console.log(`\uD83D\uDD12 [ANSWER KEY UPDATED]: Test "${item.title}" (Status: ${updatedKey.status}, Questions: ${questionCount})`);
    res.json({ success: true, answerKey: item.answerKey });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    On-demand Gemini Vision answer key generation for a specific test
// @route   POST /api/content/:id/generate-answer-key
// @access  Public
const generateAnswerKey = async (req, res) => {
  try {
    const targetId = req.params.id;
    const item = await Content.findOne(buildIdQuery(targetId));
    if (!item) {
      return res.status(404).json({ message: 'Test not found' });
    }

    // Dynamic file resolution for this exact Test_ID
    let fileBuffer = null;
    let fileMime = 'application/pdf';

    // 1. Direct payload fileDataUrl passed from frontend request body (most immediate & fresh)
    const incomingDataUrl = req.body?.fileDataUrl || (req.body?.file && typeof req.body.file === 'string' && req.body.file.startsWith('data:') ? req.body.file : null);
    if (incomingDataUrl && incomingDataUrl.startsWith('data:')) {
      try {
        const matches = incomingDataUrl.match(/^data:([A-Za-z0-9-+/]+);base64,(.+)$/);
        if (matches && matches.length === 3) {
          fileMime = matches[1];
          fileBuffer = Buffer.from(matches[2], 'base64');
          console.log(`[GENERATE KEY]: Used fresh question paper fileDataUrl from request body (${fileBuffer.length} bytes, MIME: ${fileMime})`);
        }
      } catch (e) {
        console.warn('Could not decode fileDataUrl from req.body:', e.message);
      }
    }

    // 2. Load file buffer from disk if stored locally
    if (!fileBuffer && item.filePath) {
      try {
        const fullPath = path.isAbsolute(item.filePath) ? item.filePath : path.join(uploadsDir, item.filePath);
        if (fs.existsSync(fullPath)) {
          fileBuffer = fs.readFileSync(fullPath);
          const ext = path.extname(fullPath).toLowerCase();
          fileMime = ext === '.pdf' ? 'application/pdf' : (ext === '.png' ? 'image/png' : 'image/jpeg');
          console.log(`[GENERATE KEY]: Loaded question paper from disk (${fullPath}, ${fileBuffer.length} bytes)`);
        }
      } catch (diskErr) {
        console.warn('Could not read question paper from disk:', diskErr.message);
      }
    }

    // 3. Stored base64 fileDataUrl in MongoDB
    if (!fileBuffer && item.fileDataUrl && item.fileDataUrl.startsWith('data:')) {
      try {
        const matches = item.fileDataUrl.match(/^data:([A-Za-z0-9-+/]+);base64,(.+)$/);
        if (matches && matches.length === 3) {
          fileMime = matches[1];
          fileBuffer = Buffer.from(matches[2], 'base64');
          console.log(`[GENERATE KEY]: Decoded file from item.fileDataUrl in DB (${fileBuffer.length} bytes)`);
        }
      } catch (decodeErr) {
        console.warn('Could not decode item.fileDataUrl:', decodeErr.message);
      }
    }

    // 4. Remote HTTP/HTTPS URL
    if (!fileBuffer && item.fileUrl && (item.fileUrl.startsWith('http://') || item.fileUrl.startsWith('https://'))) {
      try {
        const resp = await fetch(item.fileUrl);
        if (resp.ok) {
          const ab = await resp.arrayBuffer();
          fileBuffer = Buffer.from(ab);
          const cType = resp.headers.get('content-type');
          if (cType) fileMime = cType;
          console.log(`[GENERATE KEY]: Fetched question paper from remote URL (${item.fileUrl}, ${fileBuffer.length} bytes)`);
        }
      } catch (urlErr) {
        console.warn('Could not fetch file from URL:', urlErr.message);
      }
    }

    const questionText = item.questionText || req.body?.questionText || item.description || '';

    if (!fileBuffer && (!questionText || questionText.trim().length === 0)) {
      return res.status(400).json({
        message: 'No question paper file (PDF/Image) found for this test. Please attach an actual question paper before generating the answer key.'
      });
    }

    const newKey = await generateAnswerKeyForQuestionPaper({
      title: item.title,
      course: item.course || 'engineering',
      branch: item.branch || '',
      classLevel: item.classLevel || '',
      subject: item.subject || 'Mathematics',
      marks: item.marks || item.fullMarks || 50,
      fileBuffer,
      fileMime,
      textContent: questionText,
    });

    item.answerKey = { ...newKey, updatedAt: new Date() };
    await item.save();

    const questionCount = Array.isArray(newKey.questions) ? newKey.questions.length : 0;
    console.log(`[GENERATE KEY]: Answer key generated dynamically for "${item.title}" — ${questionCount} questions via ${newKey.generatedBy}`);
    res.json({ success: true, answerKey: item.answerKey });
  } catch (error) {
    console.error('Error generating dynamic answer key:', error);
    res.status(500).json({ message: error.message || 'Failed to generate answer key with Gemini API' });
  }
};

module.exports = {
  getAllContent,
  getContentById,
  saveContent,
  batchSyncContent,
  deleteContent,
  clearAllContent,
  getAnswerKey,
  updateAnswerKey,
  generateAnswerKey,
};
