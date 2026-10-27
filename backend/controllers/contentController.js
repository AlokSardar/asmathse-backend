const mongoose = require('mongoose');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Content = require('../models/Content');
const ClassTest = require('../models/ClassTest');
const Notification = require('../models/Notification');
const { generateAnswerKeyForQuestionPaper, streamAnswerKeyForQuestionPaper } = require('../services/geminiService');

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Helper to construct safe ID query (supports id, testId, and _id)
const buildIdQuery = (targetId) => {
  const orConditions = [{ id: targetId }, { testId: targetId }];
  if (mongoose.Types.ObjectId.isValid(targetId)) {
    orConditions.push({ _id: targetId });
  }
  return { $or: orConditions };
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
    const { course, board, branch, semester, classLevel, class: queryClass, subject, type, resourceType, academicYear, academic_year } = req.query;
    const query = {};

    const rawCourse = String(course || board || req.query.stream || '').trim().toLowerCase();
    const isIcse = rawCourse.includes('icse') || rawCourse.includes('isc') || (board && /icse/i.test(String(board)));
    const isCbse = !isIcse && (rawCourse.includes('cbse') || rawCourse.includes('school') || (board && /cbse/i.test(String(board))) || (classLevel && /class/i.test(String(classLevel))) || (queryClass && /class/i.test(String(queryClass))));
    const isSchool = isIcse || isCbse || (classLevel && /class/i.test(String(classLevel))) || (queryClass && /class/i.test(String(queryClass)));
    const isJee = !isSchool && (rawCourse.includes('jee') || rawCourse.includes('iit'));
    const isBsc = !isSchool && !isJee && (rawCourse.includes('bsc') || rawCourse.includes('b.sc') || rawCourse.includes('science'));
    const isEng = !isSchool && !isJee && !isBsc && (rawCourse.includes('eng') || rawCourse.includes('btech') || rawCourse.includes('makaut'));

    if (isSchool) {
      const schoolBoard = isIcse ? 'icse' : (isCbse ? 'cbse' : (board ? String(board).toLowerCase() : null));
      const schoolClauses = [];

      if (schoolBoard === 'icse') {
        schoolClauses.push({
          $or: [
            { board: /^icse$/i },
            { course: /^icse$/i },
            { stream: /^icse$/i },
            { board: /icse/i },
            { course: /icse/i },
            { stream: /icse/i }
          ]
        });
      } else if (schoolBoard === 'cbse') {
        schoolClauses.push({
          $or: [
            { board: /^cbse$/i },
            { course: /^cbse$/i },
            { stream: /^cbse$/i },
            { board: /cbse/i },
            { course: /cbse/i },
            { stream: /cbse/i }
          ]
        });
      } else {
        schoolClauses.push({
          $or: [
            { board: /cbse|icse|school/i },
            { course: /cbse|icse|school/i },
            { stream: /cbse|icse|school/i },
            { classLevel: /class/i },
            { class: /class/i }
          ]
        });
      }

      // 2. Exact Class Filtering: matches "Class 9", "9", 9, class_name, className, classNumber
      const targetClass = classLevel || queryClass || req.query.class_name || req.query.className;
      if (targetClass) {
        const strVal = String(targetClass).trim();
        const numLevel = parseInt(strVal.replace(/[^0-9]/g, ''), 10);
        const classConditions = [
          { classLevel: new RegExp(`^${escapeRegex(strVal)}$`, 'i') },
          { class: new RegExp(`^${escapeRegex(strVal)}$`, 'i') },
          { class_name: new RegExp(`^${escapeRegex(strVal)}$`, 'i') },
          { className: new RegExp(`^${escapeRegex(strVal)}$`, 'i') },
          { classLevel: /all/i },
          { class: /all/i },
          { class_name: /all/i }
        ];

        if (!isNaN(numLevel) && numLevel > 0) {
          // Exact numeric data type matching in MongoDB Atlas
          classConditions.push(
            { classLevel: numLevel },
            { class: numLevel },
            { class_name: numLevel },
            { className: numLevel },
            { classNumber: numLevel }
          );
          // Word boundary regex matching for "Class 9", "9", "9th", "Class 9th"
          const numRegex = new RegExp(`(^|\\b|class\\s*)${numLevel}(th)?($|\\b)`, 'i');
          classConditions.push(
            { classLevel: numRegex },
            { class: numRegex },
            { class_name: numRegex },
            { className: numRegex }
          );
        }
        schoolClauses.push({ $or: classConditions });
      }

      // 3. Exact Subject Filtering: matches "Mathematics", "Maths", "Both"
      if (subject) {
        const subStr = String(subject).trim();
        const subConditions = [
          { subject: new RegExp(`^${escapeRegex(subStr)}$`, 'i') },
          { subject: /all/i },
          { subject: null },
          { subject: { $exists: false } },
          { subject: '' }
        ];
        if (/math/i.test(subStr) || /both/i.test(subStr)) {
          subConditions.push({ subject: /math/i });
          subConditions.push({ subject: /both/i });
        }
        schoolClauses.push({ $or: subConditions });
      }

      query.$and = schoolClauses;

    } else if (isJee) {
      query.$or = [
        { course: /jee|iit|^all$/i },
        { stream: /jee|iit/i },
        { course: null }
      ];
    } else if (isBsc) {
      const bscClauses = [
        {
          $or: [
            { course: /bsc|b\.sc|science|^all$/i },
            { stream: /bsc/i },
            { course: null }
          ]
        }
      ];
      if (branch) {
        const isHon = /hon|major/i.test(branch);
        bscClauses.push({
          $or: [
            { branch: isHon ? /hon|major/i : /gen|pass/i },
            { branch: /all/i },
            { branch: null }
          ]
        });
      }
      if (semester !== undefined && semester !== null && semester !== '') {
        const cleanSem = String(semester).replace(/[^0-9]/g, '');
        bscClauses.push({
          $or: [
            { semester: cleanSem },
            { semester: Number(cleanSem) },
            { semester: /all/i },
            { semester: null }
          ]
        });
      }
      query.$and = bscClauses;

    } else if (isEng || course) {
      const engClauses = [
        {
          $or: [
            { course: /engineering|btech|b\.tech|makaut|^all$/i },
            { course: null },
            { course: { $exists: false } },
            { course: '' },
            { course: /all/i }
          ]
        },
        {
          board: { $nin: [/^cbse$/i, /^icse$/i] }
        }
      ];

      if (branch) {
        const b = branch.trim();
        const branchConditions = [
          new RegExp(`^${escapeRegex(b)}$`, 'i'),
          /common/i,
          /^all/i,
          /unified/i
        ];
        if (/cse|computer/i.test(b)) branchConditions.push(/cse|computer|comp/i);
        else if (/it|information/i.test(b)) branchConditions.push(/it|information|info/i);
        else if (/ece|electronic/i.test(b)) branchConditions.push(/ece|electronic|comm/i);
        else if (/ee|electrical/i.test(b)) branchConditions.push(/ee|electrical/i);
        else if (/me|mech/i.test(b)) branchConditions.push(/me|mech/i);
        else if (/ce|civil/i.test(b)) branchConditions.push(/ce|civil/i);

        const branchClauses = [
          ...branchConditions.map(r => ({ branch: r })),
          ...branchConditions.map(r => ({ stream: r })),
          { isCommonFirstYear: true }
        ];
        engClauses.push({ $or: branchClauses });
      }

      if (semester !== undefined && semester !== null && semester !== '') {
        const cleanSem = String(semester).replace(/[^0-9]/g, '');
        const semNum = Number(cleanSem);
        const semConditions = [
          { semester: cleanSem },
          { semester: String(semester) },
          { semester: new RegExp(`^${escapeRegex(String(semester))}$`, 'i') },
          { semester: /all/i },
          { semester: null },
          { semester: { $exists: false } }
        ];
        if (!isNaN(semNum) && semNum > 0) {
          semConditions.push({ semester: semNum });
        }
        if (semNum === 1 || semNum === 2) {
          semConditions.push({ branch: /common/i });
          semConditions.push({ isCommonFirstYear: true });
        }
        engClauses.push({ $or: semConditions });
      }

      query.$and = engClauses;
    }

    const targetYear = academicYear || academic_year;
    if (targetYear && targetYear !== 'all') {
      const yearConditions = [
        { academicYear: targetYear },
        { academic_year: targetYear },
        { academicYear: { $exists: false } },
        { academicYear: null },
        { academicYear: '' }
      ];
      if (query.$and) {
        query.$and.push({ $or: yearConditions });
      } else if (query.$or) {
        query.$and = [{ $or: query.$or }, { $or: yearConditions }];
        delete query.$or;
      } else {
        query.$or = yearConditions;
      }
    }

    if (type) {
      const normType = String(type).trim().toLowerCase();
      let typeClause;
      if (normType === 'syllabus' || normType === 'curriculum') {
        typeClause = { type: { $in: [/^syllabus$/i, /^curriculum$/i] } };
      } else if (normType === 'materials' || normType === 'material' || normType === 'notes') {
        typeClause = { type: { $in: [/^materials?$/i, /^notes?$/i, /^study_materials?$/i, /^textbooks?$/i, /^lecture$/i] } };
      } else if (normType === 'pyq' || normType === 'pyqs') {
        typeClause = { type: { $in: [/^pyqs?$/i, /^previous_year$/i, /^pyq_solution$/i] } };
      } else if (normType === 'assignment' || normType === 'assignments') {
        typeClause = { type: { $in: [/^assignments?$/i, /^homework$/i, /^problem_set$/i] } };
      } else if (normType === 'classtest' || normType === 'classtests') {
        typeClause = { type: { $in: [/^classtests?$/i, /^test$/i, /^exam$/i] } };
      } else {
        typeClause = { type: new RegExp(`^${escapeRegex(type)}$`, 'i') };
      }
      if (query.$and) {
        query.$and.push(typeClause);
      } else {
        Object.assign(query, typeClause);
      }
    }

    if (resourceType) {
      if (query.$and) {
        query.$and.push({ resourceType });
      } else {
        query.resourceType = resourceType;
      }
    }

    console.log('[ALL_CONTENT_FETCH_QUERY]', JSON.stringify({
      incomingQuery: req.query,
      mongoFilter: query
    }, null, 2));

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

    // ── 2. Multipart File Upload (req.file) ─────────────────────────────
    else if (req.file) {
      try {
        const diskPath = req.file.path;
        const fileBuffer = fs.readFileSync(diskPath);
        uploadedBuffer = fileBuffer;
        uploadedDiskPath = diskPath;

        fileHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');

        // Check MongoDB for existing identical file
        const duplicateItem = await Content.findOne({ fileHash });
        if (duplicateItem && duplicateItem.filePath && fs.existsSync(path.join(uploadsDir, duplicateItem.filePath))) {
          console.log(`[UPLOAD REUSE] Duplicate file detected (${fileHash.substring(0, 8)}). Reusing existing file: ${duplicateItem.title}`);
          filePath = duplicateItem.filePath;
          fileUrl = duplicateItem.fileUrl;
          resourceType = duplicateItem.resourceType || resourceType;
          // Remove duplicate file on disk to save storage
          try { fs.unlinkSync(diskPath); } catch (_) {}
        } else {
          filePath = path.basename(diskPath);
          fileUrl = `/uploads/${filePath}`;
          const ext = path.extname(req.file.originalname).toLowerCase();
          if (ext === '.pdf') {
            resourceType = 'pdf';
            uploadedMime = 'application/pdf';
          } else if (['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) {
            resourceType = 'image';
            uploadedMime = ext === '.png' ? 'image/png' : 'image/jpeg';
          } else if (['.doc', '.docx'].includes(ext)) {
            resourceType = 'docx';
            uploadedMime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
          } else {
            resourceType = 'document';
          }
        }
      } catch (err) {
        console.error('Multipart file processing error:', err);
        return res.status(500).json({ message: 'Failed to process uploaded file: ' + err.message });
      }
    }

    // ── 3. Base64 Document File Hashing & Duplicate Handling ───────────
    else if (itemData.fileDataUrl && itemData.fileDataUrl.startsWith('data:')) {
      try {
        const commaIndex = itemData.fileDataUrl.indexOf(',');
        const base64Data = commaIndex !== -1 ? itemData.fileDataUrl.substring(commaIndex + 1) : itemData.fileDataUrl;
        const fileBuffer = Buffer.from(base64Data, 'base64');
        uploadedBuffer = fileBuffer;

        // Calculate SHA-256 hash of the uploaded file
        fileHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');

        // Check MongoDB for duplicate hash — reuse existing file to prevent 409 conflict and save storage
        const duplicateItem = await Content.findOne({ fileHash });
        if (duplicateItem && duplicateItem.filePath && fs.existsSync(path.join(uploadsDir, duplicateItem.filePath))) {
          console.log(`[UPLOAD REUSE] Duplicate file detected (${fileHash.substring(0, 8)}). Reusing existing file: ${duplicateItem.title}`);
          filePath = duplicateItem.filePath;
          fileUrl = duplicateItem.fileUrl;
          resourceType = duplicateItem.resourceType || resourceType;
        } else {
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
        }
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

    const targetAcademicYear = itemData.academicYear || itemData.academic_year || itemData.examYear || '2026-2027';

    // 1. Precise Course / Board Determination
    const rawCourse = String(itemData.course || itemData.board || itemData.targetCourse || '').trim().toLowerCase();
    const rawStream = String(itemData.stream || '').trim().toLowerCase();
    const rawClass = itemData.classLevel || itemData.class || itemData.class_name || itemData.className;

    let course = 'engineering';
    let board = itemData.board || null;
    let isIcse = rawCourse.includes('icse') || rawCourse.includes('isc') || rawStream.includes('icse') || (itemData.board && /icse/i.test(itemData.board));
    let isCbse = !isIcse && (rawCourse.includes('cbse') || rawCourse.includes('school') || rawStream.includes('cbse') || (itemData.board && /cbse/i.test(itemData.board)) || (rawClass && /class/i.test(rawClass)));
    let isSchool = isIcse || isCbse || (rawClass && /class/i.test(rawClass));
    let isJee = !isSchool && (rawCourse.includes('jee') || rawCourse.includes('iit') || rawStream.includes('jee'));
    let isBsc = !isSchool && !isJee && (rawCourse.includes('bsc') || rawCourse.includes('science') || rawStream.includes('bsc'));
    let isEng = !isSchool && !isJee && !isBsc;

    if (isIcse) {
      course = 'icse';
      board = itemData.board || 'ICSE';
    } else if (isCbse || isSchool) {
      course = 'cbse';
      board = itemData.board || 'CBSE';
      isCbse = true;
    } else if (isJee) {
      course = 'jee';
    } else if (isBsc) {
      course = 'bsc';
    } else {
      course = 'engineering';
    }

    // 2. Exact Hierarchical Path Metadata Binding (Strict Isolation to Prevent Cross-Contamination)
    let branch = null;
    let stream = null;
    let semester = null;
    let classLevel = null;
    let targetClass = null;
    let subject = itemData.subject || (isSchool ? 'Mathematics' : (isJee ? 'JEE Mathematics' : 'Engineering Mathematics'));
    let isCommon1stYr = false;

    if (isSchool) {
      branch = null; // Explicitly null to prevent cross-contamination as CSE
      stream = board;
      semester = null; // Explicitly null to prevent cross-contamination as Sem 1
      classLevel = itemData.classLevel || itemData.class || itemData.class_name || itemData.className || 'Class 9';
      targetClass = classLevel;
      subject = itemData.subject || 'Mathematics';
      isCommon1stYr = false;
    } else if (isJee) {
      board = null;
      branch = itemData.branch || 'JEE';
      stream = 'JEE';
      semester = null;
      classLevel = itemData.classLevel || itemData.class || itemData.class_name || 'JEE Mains & Advanced';
      targetClass = classLevel;
      subject = itemData.subject || 'JEE Mathematics';
      isCommon1stYr = false;
    } else if (isBsc) {
      board = null;
      branch = itemData.branch || itemData.stream || 'BSc (Honours) (Major)';
      stream = branch;
      semester = itemData.semester !== undefined && itemData.semester !== null && itemData.semester !== '' ? itemData.semester : 1;
      classLevel = null;
      targetClass = null;
      subject = itemData.subject || 'Mathematics';
      isCommon1stYr = false;
    } else {
      board = null;
      branch = itemData.branch || itemData.stream || 'CSE';
      stream = itemData.stream || itemData.branch || 'CSE';
      semester = itemData.semester !== undefined && itemData.semester !== null && itemData.semester !== '' ? itemData.semester : 1;
      classLevel = null;
      targetClass = null;
      subject = itemData.subject || 'Engineering Mathematics';
      isCommon1stYr = Boolean(
        itemData.isCommonFirstYear ||
        /common/i.test(branch) ||
        /common/i.test(stream) ||
        (Number(semester) <= 2 && (/common/i.test(branch || '') || /common/i.test(stream || '')))
      );
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
      academicYear: targetAcademicYear,
      academic_year: targetAcademicYear,
      course,
      board,
      branch,
      stream,
      semester,
      classLevel,
      class: targetClass,
      class_name: targetClass,
      className: targetClass,
      classNumber: isSchool && targetClass ? (parseInt(String(targetClass).replace(/[^0-9]/g, ''), 10) || null) : null,
      subject,
      targetAudience: itemData.targetAudience || itemData.deploymentTarget || 'all',
      deploymentTarget: itemData.deploymentTarget || itemData.targetAudience || 'all',
      isCommonFirstYear: isCommon1stYr,
    };

    // Check if this is an update vs new creation
    const existingRecord = await Content.findOne({ $or: [{ id }, ...(testId ? [{ testId }] : [])] });

    // Retain existing answerKey or save provided answerKey without blocking upload modal
    payload.answerKey = itemData.answerKey || existingRecord?.answerKey || null;
    payload.publishedResults = itemData.publishedResults !== undefined ? itemData.publishedResults : (existingRecord?.publishedResults || false);

    console.log('[TEACHER_UPLOAD_PAYLOAD]', JSON.stringify({
      title: payload.title,
      type: payload.type,
      board: payload.board,
      course: payload.course,
      classLevel: payload.classLevel,
      class: payload.class,
      class_name: payload.class_name,
      classNumber: payload.classNumber,
      subject: payload.subject,
      stream: payload.stream,
      branch: payload.branch,
      semester: payload.semester
    }, null, 2));

    // Upsert by custom id or testId
    const saved = await Content.findOneAndUpdate(
      { $or: [{ id }, ...(testId ? [{ testId }] : [])] },
      { $set: payload },
      { new: true, upsert: true, runValidators: false }
    );

    // Bidirectional sync: if this is a class test, also synchronize to ClassTest collection
    if (isClassTest) {
      try {
        const ctDoc = {
          title: saved.title,
          course: saved.course,
          board: saved.board,
          branch: saved.branch,
          stream: saved.stream || saved.branch,
          semester: saved.semester,
          classLevel: saved.classLevel,
          class: saved.class || saved.classLevel,
          class_name: saved.class_name || saved.classLevel,
          classNumber: saved.classNumber,
          subject: saved.subject,
          academicYear: targetAcademicYear,
          academic_year: targetAcademicYear,
          durationMinutes: Number(saved.duration) || 45,
          examDate: saved.examDate ? new Date(saved.examDate) : new Date(),
          questionPaperUrl: saved.fileUrl || saved.filePath || '',
          targetAudience: saved.targetAudience || 'all',
          deploymentTarget: saved.deploymentTarget || 'all',
          targetStudentEmails: Array.isArray(saved.targetStudentEmails) ? saved.targetStudentEmails : [],
          isCommonFirstYear: isCommon1stYr,
          isOnlineTest: Boolean(saved.isOnlineTest),
          questions: Array.isArray(saved.questions) ? saved.questions : [],
          fullMarks: saved.fullMarks || saved.marks || 50,
        };
        await ClassTest.findOneAndUpdate(
          { $or: [{ id: saved.id }, { testId: saved.testId || saved.id }, { title: saved.title }] },
          { $set: ctDoc },
          { upsert: true, new: true }
        ).catch(() => null);
      } catch (ctErr) {
        console.warn('ClassTest synchronization notice:', ctErr.message);
      }
    }

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
      const rawC = String(item.course || item.board || item.targetCourse || '').trim().toLowerCase();
      const rawCl = item.classLevel || item.class;
      const isCbse = rawC.includes('cbse') || rawC.includes('school') || (rawCl && /class/i.test(rawCl));
      
      const normalized = { ...item };
      if (isCbse) {
        normalized.course = 'cbse';
        normalized.board = 'CBSE';
        normalized.stream = 'CBSE';
        normalized.branch = null;
        normalized.semester = null;
        normalized.classLevel = item.classLevel || item.class || 'Class 9';
        normalized.class = normalized.classLevel;
      }
      return {
        updateOne: {
          filter: { id },
          update: { 
            $set: { 
              ...normalized, 
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
    if (incomingKey.status === 'locked') {
      item.status = 'available';
      item.isPublished = true;

      // Dispatch real-time student notification
      try {
        await Notification.create({
          id: `notif_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
          title: 'Class Test Available',
          message: `Official question paper and evaluation rubric finalized for "${item.title}". You can now start the test!`,
          type: 'classtest',
          resourceType: item.resourceType || 'document',
          course: item.course,
          branch: item.branch,
          semester: item.semester,
          classLevel: item.classLevel,
          subject: item.subject,
          contentId: item.testId || item.id,
        });
      } catch (notifErr) {
        console.warn('Locked test notification notice:', notifErr.message);
      }
    }

    await item.save();

    const questionCount = Array.isArray(updatedKey.questions) ? updatedKey.questions.length : 0;
    console.log(`🔒 [ANSWER KEY UPDATED]: Test "${item.title}" (Status: ${updatedKey.status}, Questions: ${questionCount})`);
    res.json({ success: true, answerKey: item.answerKey, item });
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

    const customPrompt = req.body?.customPrompt || '';

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
      customPrompt,
      pages: req.body?.pages || req.body?.files || [],
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

// @desc    Live Streaming Gemini Vision Answer Key Generation
// @route   POST /api/content/:id/generate-answer-key-stream
// @access  Public
const generateAnswerKeyStream = async (req, res) => {
  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const sendEvent = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const targetId = req.params.id;
    const item = await Content.findOne(buildIdQuery(targetId));
    if (!item) {
      sendEvent('error', { message: 'Test not found in database' });
      return res.end();
    }

    sendEvent('status', { stage: 'init', message: `Test "${item.title}" verified. Resolving document pages...`, percent: 10 });

    let fileBuffer = null;
    let fileMime = 'application/pdf';

    const incomingDataUrl = req.body?.fileDataUrl || (req.body?.file && typeof req.body.file === 'string' && req.body.file.startsWith('data:') ? req.body.file : null);
    if (incomingDataUrl && incomingDataUrl.startsWith('data:')) {
      try {
        const matches = incomingDataUrl.match(/^data:([A-Za-z0-9-+/]+);base64,(.+)$/);
        if (matches && matches.length === 3) {
          fileMime = matches[1];
          fileBuffer = Buffer.from(matches[2], 'base64');
          console.log(`[GENERATE STREAM]: Used incoming fileDataUrl (${fileBuffer.length} bytes)`);
        }
      } catch (_) {}
    }

    if (!fileBuffer && item.fileDataUrl && item.fileDataUrl.startsWith('data:')) {
      try {
        const matches = item.fileDataUrl.match(/^data:([A-Za-z0-9-+/]+);base64,(.+)$/);
        if (matches && matches.length === 3) {
          fileMime = matches[1];
          fileBuffer = Buffer.from(matches[2], 'base64');
        }
      } catch (_) {}
    }

    if (!fileBuffer) {
      const candidates = [
        item.fileUrl,
        item.filePath,
        item.fileName ? path.join(uploadsDir, item.fileName) : null,
      ].filter(Boolean);

      for (const cand of candidates) {
        let cleanName = null;
        if (cand.includes('/uploads/')) {
          cleanName = cand.substring(cand.indexOf('/uploads/') + '/uploads/'.length);
        } else if (cand.startsWith('uploads/')) {
          cleanName = cand.replace('uploads/', '');
        } else if (!cand.startsWith('http://') && !cand.startsWith('https://')) {
          cleanName = path.basename(cand);
        }

        const candidateLocalPath = cleanName
          ? path.join(uploadsDir, cleanName)
          : (fs.existsSync(cand) ? cand : null);

        if (candidateLocalPath && fs.existsSync(candidateLocalPath)) {
          fileBuffer = fs.readFileSync(candidateLocalPath);
          const ext = path.extname(candidateLocalPath).toLowerCase();
          fileMime = ext === '.pdf' ? 'application/pdf' : (ext === '.png' ? 'image/png' : 'image/jpeg');
          break;
        }
      }
    }

    const questionText = req.body?.questionText || item.questionText || item.description || item.desc || '';
    const customPrompt = req.body?.customPrompt || '';

    sendEvent('status', { stage: 'connecting', message: 'Connecting to Gemini Multimodal Engine...', percent: 25 });

    const newKey = await streamAnswerKeyForQuestionPaper({
      title: item.title,
      course: item.course || 'engineering',
      branch: item.branch || '',
      classLevel: item.classLevel || '',
      subject: item.subject || 'Mathematics',
      marks: item.marks || item.fullMarks || 50,
      fileBuffer,
      fileMime,
      textContent: questionText,
      customPrompt,
      pages: req.body?.pages || req.body?.files || [],
      onProgress: (prog) => {
        sendEvent('status', prog);
      },
      onQuestion: (qData) => {
        sendEvent('question', qData);
      },
    });

    item.answerKey = { ...newKey, updatedAt: new Date() };
    await item.save();

    console.log(`[GENERATE STREAM]: Answer key generated and saved for "${item.title}" (${newKey.questions.length} questions)`);
    sendEvent('complete', { success: true, answerKey: item.answerKey });
    res.end();
  } catch (err) {
    console.error('Error in generateAnswerKeyStream:', err);
    sendEvent('error', { message: err.message || 'Streaming generation failed' });
    res.end();
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
  generateAnswerKeyStream,
};
