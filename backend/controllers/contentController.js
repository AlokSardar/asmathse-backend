const mongoose = require('mongoose');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const Content = require('../models/Content');
const ClassTest = require('../models/ClassTest');
const Notification = require('../models/Notification');
const { generateAnswerKeyForQuestionPaper, streamAnswerKeyForQuestionPaper } = require('../services/geminiService');
const { uploadBufferToCloudinary } = require('../services/cloudinaryService');

// Helper: Inspect request credentials for administrator authorization
const isAuthorizedAdmin = (req) => {
  const role = String(req.user?.role || '').toLowerCase();
  if (role === 'admin' || role === 'teacher' || req.user?.id === 'master_admin_id') {
    return true;
  }
  const authHeader = req.headers?.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    try {
      const token = authHeader.split(' ')[1];
      const secret = process.env.JWT_SECRET || 'asmaths_secret_jwt_key_2026_cluster0';
      const decoded = jwt.verify(token, secret);
      const decodedRole = String(decoded.role || '').toLowerCase();
      if (decodedRole === 'admin' || decodedRole === 'teacher' || decoded.id === 'master_admin_id') {
        return true;
      }
    } catch (_) {}
  }
  return false;
};

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Helper: Validate 24-character hexadecimal MongoDB ObjectId
const isValidObjectId = (val) => {
  if (!val) return false;
  const str = String(val).trim();
  return /^[0-9a-fA-F]{24}$/.test(str) && mongoose.Types.ObjectId.isValid(str);
};

// Helper to construct safe ID query (supports id, itemId, customId, testId, and _id)
const buildIdQuery = (targetId) => {
  if (!targetId) return { _id: null };
  const strId = String(targetId).trim();
  const orConditions = [
    { id: strId },
    { itemId: strId },
    { customId: strId },
    { testId: strId }
  ];
  if (isValidObjectId(strId)) {
    orConditions.push({ _id: new mongoose.Types.ObjectId(strId) });
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
      // 1. Board / Course matching (exact normalized array + regex fallbacks)
      const targetBoard = isIcse ? 'icse' : (isCbse ? 'cbse' : (board ? String(board).toLowerCase() : 'cbse'));
      const boardValues = targetBoard === 'icse'
        ? ['ICSE', 'icse', 'ISC', 'isc', 'School', 'school', 'All', 'all']
        : ['CBSE', 'cbse', 'School', 'school', 'NCERT', 'ncert', 'All', 'all'];

      const boardClause = {
        $or: [
          { board: { $in: boardValues } },
          { course: { $in: boardValues } },
          { stream: { $in: boardValues } },
          { board: targetBoard === 'icse' ? /icse|isc/i : /cbse|school|ncert/i },
          { course: targetBoard === 'icse' ? /icse|isc/i : /cbse|school|ncert/i },
          { stream: targetBoard === 'icse' ? /icse|isc/i : /cbse|school|ncert/i },
          { board: null, course: null },
          { board: { $exists: false } }
        ]
      };

      // 2. Class Level matching (exact normalized array + numeric pattern)
      const targetClass = classLevel || queryClass || req.query.class_name || req.query.className;
      let classClause = null;
      if (targetClass) {
        const numLevel = parseInt(String(targetClass).replace(/[^0-9]/g, ''), 10);
        const strVal = String(targetClass).trim();
        const classValues = [
          strVal,
          strVal.toLowerCase(),
          'All',
          'all',
          'All Classes',
          'all classes',
          null,
          ''
        ];
        if (!isNaN(numLevel) && numLevel > 0) {
          classValues.push(
            `Class ${numLevel}`,
            `class ${numLevel}`,
            `Class ${numLevel < 10 ? '0' + numLevel : numLevel}`,
            `class ${numLevel < 10 ? '0' + numLevel : numLevel}`,
            String(numLevel),
            numLevel,
            `${numLevel}th`,
            `${numLevel}TH`,
            `Class ${numLevel}th`,
            `class ${numLevel}th`
          );
        }

        const classOrConditions = [
          { class: { $in: classValues } },
          { classLevel: { $in: classValues } },
          { class_name: { $in: classValues } },
          { className: { $in: classValues } },
          { class: null },
          { classLevel: null },
          { class: { $exists: false } },
          { classLevel: { $exists: false } }
        ];
        if (!isNaN(numLevel) && numLevel > 0) {
          classOrConditions.push({ classNumber: numLevel });
          classOrConditions.push({ class: new RegExp(`(^|\\b)0*${numLevel}(\\b|th)`, 'i') });
          classOrConditions.push({ classLevel: new RegExp(`(^|\\b)0*${numLevel}(\\b|th)`, 'i') });
        }
        classClause = { $or: classOrConditions };
      }

      // 3. Subject matching:
      const normSub = String(subject || '').trim().toLowerCase();
      const isBothOrAll = !normSub || normSub === 'both' || normSub === 'all';
      let subjectClause = null;

      if (!isBothOrAll && subject) {
        const subjectValues = [
          subject,
          String(subject).trim(),
          'Both',
          'both',
          'All',
          'all',
          null,
          ''
        ];
        if (normSub.includes('math')) {
          subjectValues.push('Mathematics', 'mathematics', 'Maths', 'maths', 'Math', 'math');
        } else if (normSub.includes('sci')) {
          subjectValues.push('Science', 'science', 'General Science', 'general science');
        }
        const subjectRegex = normSub.includes('math')
          ? /math/i
          : (normSub.includes('sci') ? /sci/i : new RegExp(escapeRegex(String(subject).trim()), 'i'));

        subjectClause = {
          $or: [
            { subject: subjectRegex },
            { subject: { $in: subjectValues } },
            { subject: { $exists: false } },
            { subject: null },
            { subject: '' }
          ]
        };
      }

      const schoolClauses = [boardClause];
      if (classClause) schoolClauses.push(classClause);
      if (subjectClause) schoolClauses.push(subjectClause);

      query.$and = schoolClauses;

    } else if (isJee) {
      query.$or = [
        { course: /jee|iit|^all$/i },
        { stream: /jee|iit/i },
        { course: null },
        { course: { $exists: false } }
      ];
    } else if (isBsc) {
      const bscClauses = [
        {
          $or: [
            { course: /bsc|b\.sc|science|^all$/i },
            { stream: /bsc/i },
            { course: null },
            { course: { $exists: false } }
          ]
        }
      ];
      if (branch) {
        const isHon = /hon|major/i.test(branch);
        bscClauses.push({
          $or: [
            { branch: isHon ? /hon|major/i : /gen|pass/i },
            { branch: /all/i },
            { branch: null },
            { branch: { $exists: false } }
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
            { semester: null },
            { semester: { $exists: false } }
          ]
        });
      }
      query.$and = bscClauses;

    } else if (isEng || course) {
      const cleanSem = semester !== undefined && semester !== null && semester !== '' ? String(semester).replace(/[^0-9]/g, '') : '';
      const semNum = Number(cleanSem);
      const isSem1 = semNum === 1 || cleanSem === '1';

      const engClauses = [
        {
          $or: [
            { course: /engineering|btech|b\.tech|makaut|^all$/i },
            { board: /engineering/i },
            { isCommon: true },
            { targetScope: 'engineering_first_year_common' },
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

      if (isSem1 && branch) {
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
        else if (/ai|ds|data/i.test(b)) branchConditions.push(/ai|ds|data/i);

        const specificMatch = {
          $and: [
            {
              $or: [
                ...branchConditions.map(r => ({ branch: r })),
                ...branchConditions.map(r => ({ stream: r })),
                { branch: null },
                { branch: { $exists: false } },
                { branch: '' },
                { stream: null },
                { stream: { $exists: false } },
                { stream: '' },
                { isCommon: true },
                { isCommonFirstYear: true }
              ]
            },
            {
              $or: [
                { semester: cleanSem },
                { semester: semNum },
                { semester: String(semester) },
                { semester: new RegExp(`^0*${cleanSem}$`, 'i') },
                { semester: /all/i },
                { semester: null },
                { semester: { $exists: false } }
              ]
            }
          ]
        };

        const commonMatch = {
          $or: [
            { isCommon: true },
            { isCommonFirstYear: true },
            { targetScope: 'engineering_first_year_common' },
            { board: 'Engineering', isCommon: true },
            { branch: /common|first\s*year|1st\s*year|all/i },
            { stream: /common|first\s*year|1st\s*year|all/i },
            { type: { $in: ['pyq', 'questionbank', 'practice', 'questions'] } }
          ]
        };

        engClauses.push({ $or: [specificMatch, commonMatch] });
      } else {
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
          else if (/ai|ds|data/i.test(b)) branchConditions.push(/ai|ds|data/i);

          const branchClauses = [
            ...branchConditions.map(r => ({ branch: r })),
            ...branchConditions.map(r => ({ stream: r })),
            { branch: null },
            { branch: { $exists: false } },
            { branch: '' },
            { stream: null },
            { stream: { $exists: false } },
            { stream: '' },
            { isCommonFirstYear: true },
            { isCommon: true },
            { targetScope: 'engineering_first_year_common' }
          ];
          engClauses.push({ $or: branchClauses });
        }

        if (semester !== undefined && semester !== null && semester !== '') {
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
            semConditions.push({ semester: new RegExp(`^0*${semNum}$`, 'i') });
          }
          if (semNum === 1 || semNum === 2) {
            semConditions.push({ branch: /common/i });
            semConditions.push({ isCommonFirstYear: true });
            semConditions.push({ isCommon: true });
            semConditions.push({ targetScope: 'engineering_first_year_common' });
          }
          engClauses.push({ $or: semConditions });
        }
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
      let typeClause = null;
      if (normType === 'syllabus' || normType === 'curriculum') {
        typeClause = { type: { $in: [/^syllabus$/i, /^curriculum$/i] } };
      } else if (normType === 'materials' || normType === 'material' || normType === 'notes') {
        typeClause = { type: { $in: [/^materials?$/i, /^notes?$/i, /^study_materials?$/i, /^textbooks?$/i, /^lecture$/i] } };
      } else if (normType === 'pyq' || normType === 'pyqs' || normType === 'previous_year') {
        typeClause = {
          $or: [
            { type: { $in: [/^pyqs?$/i, /^previous_year$/i, /^pyq_solution$/i] } },
            { isPYQ: true },
            { category: 'pyq' }
          ]
        };
      } else if (['questionbank', 'question_bank', 'question', 'questions', 'qbank', 'practice'].includes(normType)) {
        typeClause = {
          $or: [
            { type: { $in: [/^questionbanks?$/i, /^questions?$/i, /^qbanks?$/i, /^practice$/i, /^pyqs?$/i, /^previous_year$/i] } },
            { category: { $in: ['practice', 'pyq', 'questionbank', 'test_question'] } },
            { isPYQ: { $in: [true, false] } },
            { questionText: { $exists: true, $ne: '' } }
          ]
        };
      } else if (normType === 'assignment' || normType === 'assignments') {
        typeClause = { type: { $in: [/^assignments?$/i, /^homework$/i, /^problem_set$/i] } };
      } else if (normType === 'classtest' || normType === 'classtests') {
        typeClause = { type: { $in: [/^classtests?$/i, /^test$/i, /^exam$/i] } };
      } else if (normType !== 'all') {
        typeClause = { type: new RegExp(`^${escapeRegex(type)}$`, 'i') };
      }
      if (typeClause) {
        if (query.$and) {
          query.$and.push(typeClause);
        } else {
          Object.assign(query, typeClause);
        }
      }
    }

    if (resourceType) {
      if (query.$and) {
        query.$and.push({ resourceType });
      } else {
        query.resourceType = resourceType;
      }
    }

    const allowDrafts = Boolean(req.query.includeDrafts === 'true' && isAuthorizedAdmin(req));
    if (req.query.status) {
      const qStatus = String(req.query.status).trim().toLowerCase();
      if (qStatus === 'draft') {
        if (!allowDrafts) {
          // Explicit status=draft requested without admin credentials: block retrieval
          const unauthorizedBlock = { _id: null };
          if (query.$and) query.$and.push(unauthorizedBlock);
          else query.$and = [unauthorizedBlock];
        } else {
          const statusClause = { $or: [{ status: 'draft' }, { isDraft: true }] };
          if (query.$and) query.$and.push(statusClause);
          else Object.assign(query, statusClause);
        }
      } else {
        const statusClause = { status: req.query.status, isDraft: { $ne: true } };
        if (query.$and) query.$and.push(statusClause);
        else Object.assign(query, statusClause);
      }
    } else if (!allowDrafts) {
      // Exclude draft class tests by default for student queries or unauthenticated requests
      const noDraftClause = {
        $or: [
          { type: { $nin: ['classtest', 'classtests', 'test'] } },
          { status: { $ne: 'draft' }, isDraft: { $ne: true } }
        ]
      };
      if (query.$and) {
        query.$and.push(noDraftClause);
      } else {
        query.$and = [noDraftClause];
      }
    }

    console.log('[ALL_CONTENT_FETCH_QUERY]', JSON.stringify({
      incomingQuery: req.query,
      mongoFilter: query
    }, null, 2));

    const items = await Content.find(query).sort({ uploadedAt: -1, createdAt: -1 });
    const isAdmin = isAuthorizedAdmin(req);

    // Enforce student isolation: Never expose answer keys, solution steps, or marking rubrics before results are published
    const sanitizedItems = items.map(item => {
      const doc = item.toObject ? item.toObject() : { ...item };
      if (!isAdmin && doc.publishedResults !== true) {
        delete doc.answerKey;
        if (Array.isArray(doc.questions)) {
          doc.questions = doc.questions.map(q => {
            if (!q || typeof q !== 'object') return q;
            const { steps, keyFormula, teacherNotes, solution_latex, solution, marking_scheme, partial_credit_guidance, ...safeQ } = q;
            return safeQ;
          });
        }
      }
      return doc;
    });

    res.json(sanitizedItems);
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
    const isAdmin = isAuthorizedAdmin(req);
    const doc = item.toObject ? item.toObject() : { ...item };
    if (!isAdmin && doc.publishedResults !== true) {
      delete doc.answerKey;
      if (Array.isArray(doc.questions)) {
        doc.questions = doc.questions.map(q => {
          if (!q || typeof q !== 'object') return q;
          const { steps, keyFormula, teacherNotes, solution_latex, solution, marking_scheme, partial_credit_guidance, ...safeQ } = q;
          return safeQ;
        });
      }
    }
    res.json(doc);
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

    // Separate custom string ID (such as pyq_..., qb_..., up_...) from MongoDB ObjectId
    const customStringId = 
      (itemData.id && typeof itemData.id === 'string' ? itemData.id.trim() : null) ||
      (itemData.itemId && typeof itemData.itemId === 'string' ? itemData.itemId.trim() : null) ||
      (itemData.customId && typeof itemData.customId === 'string' ? itemData.customId.trim() : null) ||
      (itemData._id && !isValidObjectId(itemData._id) ? String(itemData._id).trim() : null);

    // If _id is a valid 24-char ObjectId, preserve it for existing record matching
    const targetMongoId = isValidObjectId(itemData._id) ? String(itemData._id).trim() : null;

    // Unique Test_ID to strictly isolate test submissions, question papers, and answer keys
    const testId = itemData.testId || (isTestItem ? `TEST_${Date.now()}_${Math.random().toString(36).substr(2, 6).toUpperCase()}` : (customStringId || `up_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`));
    const id = customStringId || testId;
    const itemId = itemData.itemId || customStringId || id;
    const customId = itemData.customId || customStringId || id;

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

    // ── 2. Multipart File Upload (req.file) via Cloudinary Streaming ──
    else if (req.file) {
      try {
        const fileBuffer = req.file.buffer || (req.file.path ? fs.readFileSync(req.file.path) : null);
        uploadedBuffer = fileBuffer;

        if (fileBuffer) {
          fileHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
        }

        // Check MongoDB for existing identical file URL to reuse
        const duplicateItem = fileHash ? await Content.findOne({ fileHash }) : null;
        if (duplicateItem && (duplicateItem.fileUrl || duplicateItem.filePath)) {
          console.log(`[UPLOAD REUSE] Duplicate file detected (${fileHash.substring(0, 8)}). Reusing: ${duplicateItem.title}`);
          filePath = duplicateItem.filePath || duplicateItem.fileUrl;
          fileUrl = duplicateItem.fileUrl || duplicateItem.filePath;
          resourceType = duplicateItem.resourceType || resourceType;
        } else if (fileBuffer) {
          // Stream directly to Cloudinary
          const cloudResult = await uploadBufferToCloudinary(fileBuffer, {
            fileName: req.file.originalname,
            mimeType: req.file.mimetype,
            folder: 'as_maths/content',
          });

          filePath = cloudResult.secure_url;
          fileUrl = cloudResult.secure_url;

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

    // ── 3. Base64 Document File Direct Cloudinary Streaming ───────────
    else if (itemData.fileDataUrl && itemData.fileDataUrl.startsWith('data:')) {
      try {
        const commaIndex = itemData.fileDataUrl.indexOf(',');
        const base64Data = commaIndex !== -1 ? itemData.fileDataUrl.substring(commaIndex + 1) : itemData.fileDataUrl;
        const fileBuffer = Buffer.from(base64Data, 'base64');
        uploadedBuffer = fileBuffer;

        // Calculate SHA-256 hash of the uploaded file
        fileHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');

        // Check MongoDB for duplicate hash with valid URL to reuse
        const duplicateItem = await Content.findOne({ fileHash });
        if (duplicateItem && (duplicateItem.fileUrl || duplicateItem.filePath)) {
          console.log(`[UPLOAD REUSE] Duplicate file detected (${fileHash.substring(0, 8)}). Reusing: ${duplicateItem.title}`);
          filePath = duplicateItem.filePath || duplicateItem.fileUrl;
          fileUrl = duplicateItem.fileUrl || duplicateItem.filePath;
          resourceType = duplicateItem.resourceType || resourceType;
        } else {
          const originalName = itemData.fileName || 'document.pdf';
          const ext = path.extname(originalName) || (originalName.toLowerCase().endsWith('.docx') ? '.docx' : '.pdf');

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

          // Stream directly to Cloudinary
          const cloudResult = await uploadBufferToCloudinary(fileBuffer, {
            fileName: originalName,
            folder: 'as_maths/content',
          });

          filePath = cloudResult.secure_url;
          fileUrl = cloudResult.secure_url;
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
      branch = itemData.branch || itemData.stream || 'CSE';
      stream = itemData.stream || itemData.branch || 'CSE';
      semester = itemData.semester !== undefined && itemData.semester !== null && itemData.semester !== '' ? itemData.semester : 1;
      classLevel = null;
      targetClass = null;
      subject = itemData.subject || 'Engineering Mathematics';

      const isCommonExplicit = Boolean(
        itemData.isCommon === true ||
        itemData.targetScope === 'engineering_first_year_common' ||
        itemData.isCommonFirstYear === true ||
        itemData.branch === 'Common 1st Year' ||
        itemData.stream === 'Common 1st Year' ||
        itemData.targetAudience === 'common_1st_year' ||
        itemData.branch === 'All Branches' ||
        (Number(semester) <= 2 && (itemData.type === 'pyq' || itemData.type === 'questionbank' || /common/i.test(branch || '') || /common/i.test(stream || '')))
      );

      if (isCommonExplicit) {
        board = 'Engineering';
        semester = itemData.semester !== undefined && itemData.semester !== null && itemData.semester !== '' ? itemData.semester : 1;
        branch = itemData.branch || 'Common 1st Year';
        stream = itemData.stream || itemData.branch || 'Common 1st Year';
        isCommon1stYr = true;
      } else {
        board = null;
        isCommon1stYr = false;
      }
    }

    const isEngCommon = Boolean(
      itemData.isCommon === true ||
      itemData.targetScope === 'engineering_first_year_common' ||
      isCommon1stYr
    ) && !isSchool && !isJee && !isBsc;

    const payload = {
      ...itemData,
      id,
      itemId,
      customId,
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
      board: isEngCommon ? 'Engineering' : board,
      isCommon: isEngCommon,
      targetScope: isEngCommon ? 'engineering_first_year_common' : (itemData.targetScope || null),
      branch,
      stream,
      semester: isEngCommon ? 1 : semester,
      classLevel,
      class: targetClass,
      class_name: targetClass,
      className: targetClass,
      classNumber: isSchool && targetClass ? (parseInt(String(targetClass).replace(/[^0-9]/g, ''), 10) || null) : null,
      subject,
      targetAudience: isEngCommon ? 'common_1st_year' : (itemData.targetAudience || itemData.deploymentTarget || 'all'),
      deploymentTarget: isEngCommon ? 'common_1st_year' : (itemData.deploymentTarget || itemData.targetAudience || 'all'),
      isCommonFirstYear: isEngCommon,
    };

    // Guarantee that _id is never set to a custom string ID in the payload.
    // Also delete _id from $set payload so MongoDB never rejects immutable _id mutation during update.
    delete payload._id;

    // Check if this is an update vs new creation
    const matchConditions = [
      { id },
      { itemId: id },
      { customId: id },
      ...(testId ? [{ testId }] : [])
    ];
    if (targetMongoId) {
      matchConditions.unshift({ _id: new mongoose.Types.ObjectId(targetMongoId) });
    }
    const existingRecord = await Content.findOne({ $or: matchConditions });

    // ── Duplicate Test Name Validation & Prevention ─────────────────
    if (isClassTest) {
      const candidateTitle = String(payload.title || '').trim();
      const titleRegex = new RegExp(`^${escapeRegex(candidateTitle)}$`, 'i');

      const courseFilter = payload.course ? { course: new RegExp(`^${escapeRegex(String(payload.course))}$`, 'i') } : {};
      const semFilter = payload.semester !== undefined && payload.semester !== null ? { semester: payload.semester } : {};
      const classFilter = payload.classLevel ? { $or: [{ classLevel: payload.classLevel }, { class: payload.classLevel }] } : {};

      const existingDup = await Content.findOne({
        type: { $in: ['classtest', 'classtests', 'test'] },
        title: titleRegex,
        ...courseFilter,
        ...semFilter,
        ...classFilter
      });

      if (existingDup) {
        const isSelf = String(existingDup.id) === String(id) || 
                       String(existingDup.itemId) === String(itemId) || 
                       String(existingDup.customId) === String(customId) || 
                       String(existingDup._id) === String(id) || 
                       (targetMongoId && String(existingDup._id) === String(targetMongoId)) ||
                       (existingRecord && String(existingDup._id) === String(existingRecord._id)) ||
                       (existingDup.testId && testId && String(existingDup.testId) === String(testId));
        if (!isSelf) {
          return res.status(409).json({
            success: false,
            message: 'A test with this name already exists. Please use a unique title.'
          });
        }
      }
    }

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
      semester: payload.semester,
      isCommon: payload.isCommon,
      targetScope: payload.targetScope,
      isCommonFirstYear: payload.isCommonFirstYear
    }, null, 2));

    // Upsert by custom id, itemId, customId, testId, title, or matched document _id
    const upsertConditions = [
      { id },
      { itemId: id },
      { customId: id },
      ...(testId ? [{ testId }] : []),
      ...(isClassTest && payload.title ? [{ 
        title: new RegExp(`^${escapeRegex(payload.title.trim())}$`, 'i'), 
        type: { $in: ['classtest', 'classtests', 'test'] } 
      }] : [])
    ];
    if (existingRecord) {
      upsertConditions.unshift({ _id: existingRecord._id });
    } else if (targetMongoId) {
      upsertConditions.unshift({ _id: new mongoose.Types.ObjectId(targetMongoId) });
    }

    const upsertFilter = existingRecord ? { _id: existingRecord._id } : { $or: upsertConditions };

    const saved = await Content.findOneAndUpdate(
      upsertFilter,
      { $set: payload },
      { new: true, upsert: true, runValidators: false }
    );

    // Bidirectional sync: if this is a class test, also synchronize to ClassTest collection
    if (isClassTest) {
      try {
        const ctDoc = {
          id: saved.id,
          testId: saved.testId || saved.id,
          title: saved.title,
          course: saved.course,
          board: saved.board,
          isCommon: saved.isCommon,
          targetScope: saved.targetScope,
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
          isCommonFirstYear: saved.isCommonFirstYear,
          isOnlineTest: Boolean(saved.isOnlineTest),
          questions: Array.isArray(saved.questions) ? saved.questions : [],
          fullMarks: saved.fullMarks || saved.marks || 50,
          status: saved.status || (saved.isDraft ? 'draft' : 'available'),
          isDraft: Boolean(saved.isDraft || saved.status === 'draft'),
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

    // ── 3. Automatic Real-Time Notification for Students (Published items only) ──
    const isDraftItem = Boolean(saved.isDraft === true || saved.status === 'draft');
    if (!existingRecord && !isDraftItem) {
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
      const customStringId = 
        (item.id && typeof item.id === 'string' ? item.id.trim() : null) ||
        (item.itemId && typeof item.itemId === 'string' ? item.itemId.trim() : null) ||
        (item.customId && typeof item.customId === 'string' ? item.customId.trim() : null) ||
        (item._id && !isValidObjectId(item._id) ? String(item._id).trim() : null);

      const targetMongoId = isValidObjectId(item._id) ? String(item._id).trim() : null;
      const id = customStringId || `up_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
      const itemId = item.itemId || customStringId || id;
      const customId = item.customId || customStringId || id;
      
      const rawC = String(item.course || item.board || item.targetCourse || '').trim().toLowerCase();
      const rawCl = item.classLevel || item.class;
      const isCbse = rawC.includes('cbse') || rawC.includes('school') || (rawCl && /class/i.test(rawCl));
      
      const normalized = { ...item };
      delete normalized._id; // Guarantee no CastError or immutable _id error

      if (isCbse) {
        normalized.course = 'cbse';
        normalized.board = 'CBSE';
        normalized.stream = 'CBSE';
        normalized.branch = null;
        normalized.semester = null;
        normalized.classLevel = item.classLevel || item.class || 'Class 9';
        normalized.class = normalized.classLevel;
      }

      const orConditions = [
        { id },
        { itemId },
        { customId }
      ];
      if (targetMongoId) {
        orConditions.unshift({ _id: new mongoose.Types.ObjectId(targetMongoId) });
      }

      const isTest = ['classtest', 'classtests', 'test'].includes(String(item.type).toLowerCase());
      if (isTest && item.title) {
        orConditions.push({ title: item.title, course: normalized.course });
      }

      return {
        updateOne: {
          filter: { $or: orConditions },
          update: { 
            $set: { 
              ...normalized, 
              id, 
              itemId,
              customId,
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
    if (!targetId) {
      return res.status(400).json({ success: false, message: 'Target ID is required' });
    }

    const idQuery = buildIdQuery(targetId);

    // Search both Content and ClassTest collections for target item
    const [contentItem, classTestItem] = await Promise.all([
      Content.findOne(idQuery).catch(() => null),
      ClassTest.findOne(idQuery).catch(() => null)
    ]);

    if (!contentItem && !classTestItem) {
      // Direct deletion attempt by ID across collections
      const [delC, delT] = await Promise.all([
        Content.deleteMany(idQuery),
        ClassTest.deleteMany(idQuery).catch(() => ({ deletedCount: 0 }))
      ]);
      if ((delC && delC.deletedCount > 0) || (delT && delT.deletedCount > 0)) {
        return res.json({ success: true, message: 'Item permanently deleted from MongoDB Atlas' });
      }
      return res.status(404).json({ success: false, message: 'Content item not found' });
    }

    // Collect all identifying keys to ensure full cross-collection cascade deletion
    const allIds = new Set([targetId]);
    const allTitles = new Set();
    const allTestIds = new Set();
    const filePathsToClean = new Set();

    if (contentItem) {
      if (contentItem.id) allIds.add(String(contentItem.id));
      if (contentItem.itemId) allIds.add(String(contentItem.itemId));
      if (contentItem.customId) allIds.add(String(contentItem.customId));
      if (contentItem._id) allIds.add(String(contentItem._id));
      if (contentItem.testId) allTestIds.add(String(contentItem.testId));
      if (contentItem.title) allTitles.add(String(contentItem.title));
      if (contentItem.filePath) filePathsToClean.add(contentItem.filePath);
    }

    if (classTestItem) {
      if (classTestItem.id) allIds.add(String(classTestItem.id));
      if (classTestItem.itemId) allIds.add(String(classTestItem.itemId));
      if (classTestItem.customId) allIds.add(String(classTestItem.customId));
      if (classTestItem._id) allIds.add(String(classTestItem._id));
      if (classTestItem.testId) allTestIds.add(String(classTestItem.testId));
      if (classTestItem.title) allTitles.add(String(classTestItem.title));
      if (classTestItem.questionPaperUrl && !classTestItem.questionPaperUrl.startsWith('data:') && !classTestItem.questionPaperUrl.startsWith('http')) {
        filePathsToClean.add(path.basename(classTestItem.questionPaperUrl));
      }
    }

    const deleteOr = [];
    allIds.forEach(idVal => {
      deleteOr.push({ id: idVal });
      deleteOr.push({ itemId: idVal });
      deleteOr.push({ customId: idVal });
      if (isValidObjectId(idVal)) {
        deleteOr.push({ _id: new mongoose.Types.ObjectId(idVal) });
      }
    });
    allTestIds.forEach(tId => {
      deleteOr.push({ testId: tId });
    });

    const isTestItem = (contentItem && ['classtest', 'classtests', 'test'].includes(contentItem.type)) || Boolean(classTestItem);
    if (isTestItem && allTitles.size > 0) {
      allTitles.forEach(t => {
        deleteOr.push({ title: t });
      });
    }

    const finalDeleteFilter = { $or: deleteOr };

    // Execute permanent deletion on MongoDB Atlas
    await Promise.all([
      Content.deleteMany(finalDeleteFilter),
      ClassTest.deleteMany(finalDeleteFilter).catch(() => null),
      Notification.deleteMany({
        $or: [
          { contentId: { $in: Array.from(allIds) } },
          { title: { $in: Array.from(allTitles) } }
        ]
      }).catch(() => null)
    ]);

    // Clean up local disk file if any
    filePathsToClean.forEach(fp => {
      try {
        const fullDiskPath = path.join(uploadsDir, fp);
        if (fs.existsSync(fullDiskPath)) {
          fs.unlinkSync(fullDiskPath);
        }
      } catch (fileErr) {
        console.warn('Notice: Local file cleanup:', fileErr.message);
      }
    });

    res.json({ success: true, message: 'Item and file permanently deleted from MongoDB Atlas' });
  } catch (error) {
    console.error('Delete content error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Clear all content items
// @route   DELETE /api/content
// @access  Public
const clearAllContent = async (req, res) => {
  try {
    await Promise.all([
      Content.deleteMany({}),
      ClassTest.deleteMany({}),
      Notification.deleteMany({})
    ]);
    res.json({ success: true, message: 'All content and class tests permanently cleared from MongoDB Atlas' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Get pre-computed LaTeX answer key for a test
// @route   GET /api/content/:id/answer-key
// @access  Protected (Teachers/Admins; Students only after results published)
const getAnswerKey = async (req, res) => {
  try {
    const targetId = req.params.id;
    let item = await Content.findOne(buildIdQuery(targetId));
    if (!item) {
      item = await ClassTest.findOne(buildIdQuery(targetId));
    }
    if (!item) {
      return res.status(404).json({ message: 'Test not found' });
    }

    const isAdmin = isAuthorizedAdmin(req);
    if (!isAdmin && item.publishedResults !== true) {
      return res.status(403).json({ message: 'Answer key is restricted to teachers until official results are published.' });
    }

    let answerKey = item.answerKey;
    if ((!answerKey || !Array.isArray(answerKey.questions) || answerKey.questions.length === 0) && Array.isArray(item.questions) && item.questions.length > 0) {
      answerKey = {
        generatedBy: 'Class Test Builder',
        status: 'draft',
        questions: item.questions.map((q, idx) => ({
          q_no: q.q_no || q.qNo || (q.title && /^Q\d+/i.test(q.title) ? q.title : `Q${idx + 1}`),
          max_marks: Number(q.marks || q.maxMarks) || 5,
          problem_statement_latex: q.questionText || q.statement || q.text || q.problem_statement_latex || '',
          solution_latex: q.solution_latex || q.solutionText || q.solution || '',
          final_answer_latex: q.finalAnswer || q.correctAnswer || '',
          steps: Array.isArray(q.steps) ? q.steps : [],
          marking_scheme: q.marking_scheme || q.markingScheme || '',
          partial_credit_guidance: q.partial_credit_guidance || '',
          keyFormula: q.keyFormula || '',
          options: Array.isArray(q.options) ? q.options : [],
          qType: q.qType || q.type || (Array.isArray(q.options) && q.options.length > 0 ? 'mcq' : 'descriptive'),
        })),
        updatedAt: new Date(),
      };
    }

    res.json({
      testId: item.testId || item.id,
      title: item.title,
      marks: item.marks || item.fullMarks || 50,
      answerKey: answerKey || { questions: [], status: 'draft' },
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Update or lock LaTeX answer key (enforced questions[] schema)
// @route   PUT /api/content/:id/answer-key
// @access  Protected (Teachers/Admins only)
const updateAnswerKey = async (req, res) => {
  try {
    if (!isAuthorizedAdmin(req)) {
      return res.status(403).json({ message: 'Unauthorized: Teacher or admin credentials required to update answer keys.' });
    }

    const targetId = req.params.id;
    const incomingKey = req.body; // full answerKey object

    let item = await Content.findOne(buildIdQuery(targetId));
    let isClassTestModel = false;
    if (!item) {
      item = await ClassTest.findOne(buildIdQuery(targetId));
      isClassTestModel = Boolean(item);
    }
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
    if (!res.writableEnded) {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }
  };

  // Keepalive heartbeat to prevent reverse proxy (Render, Cloudflare, Nginx) timeout
  const keepaliveTimer = setInterval(() => {
    if (!res.writableEnded) {
      res.write(': keepalive\n\n');
    }
  }, 8000);

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
  } finally {
    clearInterval(keepaliveTimer);
  }
};

// @desc    Live AI Question Extraction from uploaded PDF/image/text using Gemini
// @route   POST /api/content/extract-questions
// @access  Public / Protected
const extractQuestions = async (req, res) => {
  try {
    let fileBuffer = null;
    let fileMime = 'application/pdf';
    let textContent = req.body?.textContent || '';

    if (req.file) {
      fileBuffer = req.file.buffer;
      fileMime = req.file.mimetype || 'application/pdf';
    } else if (req.body?.fileDataUrl && req.body.fileDataUrl.startsWith('data:')) {
      const parts = req.body.fileDataUrl.split(',');
      const mimeMatch = parts[0].match(/:(.*?);/);
      if (mimeMatch) fileMime = mimeMatch[1];
      fileBuffer = Buffer.from(parts[1], 'base64');
    }

    const {
      title = 'Uploaded Source Document',
      course = 'engineering',
      branch = 'CSE',
      subject = 'Mathematics',
      classLevel = '',
      marks = 50,
      customPrompt = ''
    } = req.body || {};

    console.log(`[AI EXTRACT]: Starting AI question extraction for "${title}" (${fileBuffer ? (fileBuffer.length / 1024).toFixed(1) + ' KB' : 'Text'})`);

    const extractionResult = await generateAnswerKeyForQuestionPaper({
      title,
      course,
      branch,
      classLevel,
      subject,
      marks: Number(marks) || 50,
      fileBuffer,
      fileMime,
      textContent,
      customPrompt
    });

    const questions = (extractionResult?.questions || []).map((q, idx) => ({
      id: `ext-${Date.now()}-${idx + 1}`,
      qNo: q.q_no || `Q${idx + 1}`,
      statement: q.problem_statement_latex || q.statement || '',
      marks: Number(q.max_marks || q.marks || 5),
      diff: q.marks <= 2 ? 'Easy' : q.marks <= 5 ? 'Medium' : 'Hard',
      qType: q.marks <= 2 ? 'Short' : q.marks <= 5 ? 'Medium' : 'Long',
      chapter: q.topic || 'Calculus',
      topic: q.subCategory || q.topic || 'General',
      solution: q.solution_latex || '',
      finalAnswer: q.final_answer_latex || '',
      formula: q.formula || '',
      status: 'ready',
      validationResult: 'valid',
      validationIssue: '—',
      validationSuggestion: ''
    }));

    return res.status(200).json({
      success: true,
      count: questions.length,
      questions,
      sourceTitle: title,
      generatedBy: extractionResult.generatedBy || 'Google Gemini API'
    });
  } catch (error) {
    console.error('Error during AI question extraction:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to extract questions with Gemini AI'
    });
  }
};

// @desc    Bulk Delete Content items
// @route   POST /api/content/bulk-delete
// @access  Public / Protected
const bulkDeleteContent = async (req, res) => {
  try {
    const { ids } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ success: false, message: 'Array of ids is required' });
    }

    const query = {
      $or: [
        { id: { $in: ids } },
        { customId: { $in: ids } },
        { itemId: { $in: ids } },
        { _id: { $in: ids.filter(id => mongoose.Types.ObjectId.isValid(id)) } }
      ]
    };

    const result = await Content.deleteMany(query);
    return res.status(200).json({
      success: true,
      deletedCount: result.deletedCount,
      message: `Successfully deleted ${result.deletedCount} items`
    });
  } catch (error) {
    console.error('Error in bulkDeleteContent:', error);
    return res.status(500).json({ success: false, message: error.message });
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
  extractQuestions,
  bulkDeleteContent,
};
