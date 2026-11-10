const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');
const Content = require('../models/Content');
const MaterialDownload = require('../models/MaterialDownload');
const { dbGuard } = require('../utils/dbGuard');
const { normalizeCohortItem } = require('../utils/cohortNormalize');

// Ensure local uploads/materials directory exists on the filesystem (Amendment 2)
const materialsDir = path.join(__dirname, '..', 'uploads', 'materials');
if (!fs.existsSync(materialsDir)) {
  fs.mkdirSync(materialsDir, { recursive: true });
}

/**
 * Helper: Extract YouTube video ID
 */
function extractYouTubeId(url = '') {
  if (!url) return null;
  const match = url.match(
    /(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=))([\w-]{11})/
  );
  return match ? match[1] : null;
}

/**
 * 1. GET /api/materials — Query materials with server-side cohort & type filters
 */
exports.getMaterials = async (req, res) => {
  try {
    const user = req.user || {};
    const isStudent = user.role === 'student';
    const isTeacher = user.role === 'teacher';

    const {
      course,
      branch,
      semester,
      classLevel,
      subject,
      materialType,
      visibility,
      search,
      page = 1,
      limit = 12,
      sortBy = 'newest',
    } = req.query;

    const query = {
      type: { $in: ['material', 'materials', /^material/i] },
      isDeleted: { $ne: true },
    };

    const isEducator = user && (user.role === 'admin' || user.role === 'teacher');
    // Role-based visibility enforcement (Amendment 1)
    if (!isEducator) {
      query.visibility = 'published';
    } else if (visibility && visibility !== 'all') {
      query.visibility = visibility;
    }

    // Cohort Filters
    if (course && course !== 'ALL') {
      query.course = new RegExp(`^${course}$`, 'i');
    }

    if (branch && branch !== 'ALL') {
      query.$or = [
        { branch: new RegExp(`^${branch}$`, 'i') },
        { branch: /all/i },
        { isCommon: true },
        { isCommonFirstYear: true },
      ];
    }

    if (semester && semester !== 'ALL') {
      const cleanSem = String(semester).replace(/[^0-9]/g, '');
      const semConds = [
        { semester: semester },
        { semester: `Semester ${cleanSem}` },
        { semester: cleanSem },
        { semester: Number(cleanSem) },
        { semester: new RegExp(`semester\\s*0*${cleanSem}(\\b|$)`, 'i') },
        { isCommon: true },
      ];
      if (query.$or) {
        query.$and = [{ $or: query.$or }, { $or: semConds }];
        delete query.$or;
      } else {
        query.$or = semConds;
      }
    }

    if (classLevel && classLevel !== 'ALL') {
      const classConds = [
        { classLevel: classLevel },
        { class: classLevel },
        { class_name: classLevel },
        { semester: classLevel },
      ];
      if (query.$or) {
        query.$and = [{ $or: query.$or }, { $or: classConds }];
        delete query.$or;
      } else {
        query.$or = classConds;
      }
    }

    if (subject && subject.trim()) {
      const subRegex = new RegExp(subject.trim(), 'i');
      if (query.$and) {
        query.$and.push({ subject: subRegex });
      } else {
        query.subject = subRegex;
      }
    }

    // Material Type Filter (Amendment 6 — includes syllabus)
    if (materialType && materialType !== 'all') {
      query.materialType = materialType;
    }

    // Full-Text / Keyword Search
    if (search && search.trim()) {
      const sRegex = new RegExp(search.trim(), 'i');
      const searchCond = {
        $or: [
          { title: sRegex },
          { topic: sRegex },
          { description: sRegex },
          { topicTags: sRegex },
        ],
      };
      if (query.$and) {
        query.$and.push(searchCond);
      } else {
        query.$and = [searchCond];
      }
    }

    // Teacher Scoping Lock Enforcement
    if (isTeacher && user.targetCourse && !user.isMasterAdmin) {
      if (!query.course) {
        query.course = new RegExp(`^${user.targetCourse}$`, 'i');
      }
    }

    // Sorting Options
    let sortObj = { publishedAt: -1, createdAt: -1 };
    if (sortBy === 'oldest') {
      sortObj = { publishedAt: 1, createdAt: 1 };
    } else if (sortBy === 'most_downloaded') {
      sortObj = { downloadCount: -1, createdAt: -1 };
    } else if (sortBy === 'file_size') {
      sortObj = { fileSize: -1, createdAt: -1 };
    }

    const pageNum = Math.max(1, parseInt(page, 10));
    const pageLimit = Math.max(1, Math.min(100, parseInt(limit, 10)));
    const skip = (pageNum - 1) * pageLimit;

    const [materials, totalCount] = await Promise.all([
      Content.find(query).sort(sortObj).skip(skip).limit(pageLimit).lean(),
      Content.countDocuments(query),
    ]);

    // Aggregate counts for filter chips
    const baseCohortQuery = {
      type: { $in: ['material', 'materials', /^material/i] },
      isDeleted: { $ne: true },
    };
    if (isStudent) baseCohortQuery.visibility = 'published';
    if (course && course !== 'ALL') baseCohortQuery.course = new RegExp(`^${course}$`, 'i');

    const countsAggregation = await Content.aggregate([
      { $match: baseCohortQuery },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          lecture_notes: {
            $sum: { $cond: [{ $eq: ['$materialType', 'lecture_notes'] }, 1, 0] },
          },
          formula_sheet: {
            $sum: { $cond: [{ $eq: ['$materialType', 'formula_sheet'] }, 1, 0] },
          },
          video_lecture: {
            $sum: { $cond: [{ $eq: ['$materialType', 'video_lecture'] }, 1, 0] },
          },
          pyq_booklet: {
            $sum: { $cond: [{ $eq: ['$materialType', 'pyq_booklet'] }, 1, 0] },
          },
          assignment: {
            $sum: { $cond: [{ $eq: ['$materialType', 'assignment'] }, 1, 0] },
          },
          syllabus: {
            $sum: { $cond: [{ $eq: ['$materialType', 'syllabus'] }, 1, 0] },
          },
          other: {
            $sum: { $cond: [{ $eq: ['$materialType', 'other'] }, 1, 0] },
          },
          published: {
            $sum: { $cond: [{ $eq: ['$visibility', 'published'] }, 1, 0] },
          },
          draft: {
            $sum: { $cond: [{ $eq: ['$visibility', 'draft'] }, 1, 0] },
          },
          archived: {
            $sum: { $cond: [{ $eq: ['$visibility', 'archived'] }, 1, 0] },
          },
        },
      },
    ]);

    const counts = countsAggregation[0] || {
      total: 0,
      lecture_notes: 0,
      formula_sheet: 0,
      video_lecture: 0,
      pyq_booklet: 0,
      assignment: 0,
      syllabus: 0,
      other: 0,
      published: 0,
      draft: 0,
      archived: 0,
    };

    return res.status(200).json({
      success: true,
      data: materials,
      pagination: {
        total: totalCount,
        page: pageNum,
        limit: pageLimit,
        totalPages: Math.max(1, Math.ceil(totalCount / pageLimit)),
      },
      counts: {
        byType: {
          lecture_notes: counts.lecture_notes || 0,
          formula_sheet: counts.formula_sheet || 0,
          video_lecture: counts.video_lecture || 0,
          pyq_booklet: counts.pyq_booklet || 0,
          assignment: counts.assignment || 0,
          syllabus: counts.syllabus || 0,
          other: counts.other || 0,
        },
        byVisibility: {
          published: counts.published || 0,
          draft: counts.draft || 0,
          archived: counts.archived || 0,
        },
        total: counts.total || 0,
      },
    });
  } catch (error) {
    console.error('getMaterials error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * 2. POST /api/materials — Upload and target new study material
 * Avoids storing base64 binary in MongoDB (Amendment 2)
 */
exports.uploadMaterial = async (req, res) => {
  try {
    dbGuard('POST /api/materials');

    const user = req.user || {};
    let {
      title,
      materialType = 'lecture_notes',
      course = 'Engineering',
      branch,
      semester,
      classLevel,
      subject = 'Applied Mathematics',
      topic = '',
      description = '',
      topicTags = [],
      visibility = 'draft',
      fileUrl = '',
      fileDataUrl = '',
      fileName = '',
      fileSize = 0,
      pageCount = 1,
      duration = '',
      formulaPreview = '',
      videoUrl = '',
      thumbnailUrl = '',
    } = req.body || {};

    if (!title || !String(title).trim()) {
      return res.status(400).json({ success: false, message: 'Title is required.' });
    }

    // If file was sent via multipart (req.file) or base64: save to local disk
    if (req.file && req.file.buffer) {
      const ext = path.extname(req.file.originalname) || '.pdf';
      const safeName = `mat_${Date.now()}_${Math.random().toString(36).substring(2, 7)}${ext}`;
      const diskPath = path.join(materialsDir, safeName);
      fs.writeFileSync(diskPath, req.file.buffer);
      fileUrl = `/uploads/materials/${safeName}`;
      fileName = req.file.originalname;
      fileSize = req.file.size;
    } else if (fileDataUrl && fileDataUrl.startsWith('data:')) {
      // Decode base64 and write strictly to filesystem — NEVER store base64 in MongoDB
      const matches = fileDataUrl.match(/^data:([A-Za-z-+/]+);base64,(.+)$/);
      if (matches) {
        const buffer = Buffer.from(matches[2], 'base64');
        const ext = fileName && path.extname(fileName) ? path.extname(fileName) : '.pdf';
        const safeName = `mat_${Date.now()}_${Math.random().toString(36).substring(2, 7)}${ext}`;
        const diskPath = path.join(materialsDir, safeName);
        fs.writeFileSync(diskPath, buffer);
        fileUrl = `/uploads/materials/${safeName}`;
        fileSize = buffer.length;
      }
    }

    // Video handling (Amendment 4)
    if (materialType === 'video_lecture' && videoUrl) {
      const ytId = extractYouTubeId(videoUrl);
      if (ytId && !thumbnailUrl) {
        thumbnailUrl = `https://img.youtube.com/vi/${ytId}/hqdefault.jpg`;
      }
    }

    // Normalize topicTags
    if (typeof topicTags === 'string') {
      topicTags = topicTags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
    }

    // Cohort Normalization (Amendment 3)
    const normalizedItem = normalizeCohortItem({
      course,
      branch,
      semester,
      classLevel,
      subject,
      title,
      type: 'material',
    });

    const isPublished = visibility === 'published';

    const newMaterial = new Content({
      title: title.trim(),
      type: 'material',
      materialType,
      course: normalizedItem.course,
      branch: normalizedItem.branch,
      semester: normalizedItem.semester,
      classLevel: normalizedItem.classLevel,
      subject: normalizedItem.subject,
      isCommon: normalizedItem.isCommon,
      topic: topic.trim(),
      description: description.trim(),
      topicTags,
      visibility: isPublished ? 'published' : 'draft',
      publishedAt: isPublished ? new Date() : null,
      fileUrl,
      fileName: fileName || path.basename(fileUrl || ''),
      fileSize: Number(fileSize) || 0,
      pageCount: Number(pageCount) || 1,
      duration: duration || '',
      formulaPreview: formulaPreview || '',
      videoUrl: videoUrl || '',
      thumbnailUrl: thumbnailUrl || '', // Kept under 50KB / relative path
      uploadedBy: user._id || user.id || 'faculty_admin',
      isDeleted: false,
      downloadCount: 0,
    });

    await newMaterial.save();

    return res.status(201).json({
      success: true,
      message: `Study material "${newMaterial.title}" saved successfully.`,
      data: newMaterial,
    });
  } catch (error) {
    console.error('uploadMaterial error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * 3. PATCH /api/materials/:id — Update metadata
 */
exports.updateMaterial = async (req, res) => {
  try {
    dbGuard('PATCH /api/materials/:id');

    const { id } = req.params;
    const material = await Content.findById(id);
    if (!material || material.isDeleted) {
      return res.status(404).json({ success: false, message: 'Material not found.' });
    }

    const updatable = [
      'title',
      'materialType',
      'topic',
      'description',
      'topicTags',
      'formulaPreview',
      'duration',
      'videoUrl',
      'course',
      'branch',
      'semester',
      'classLevel',
      'subject',
    ];

    updatable.forEach((field) => {
      if (req.body[field] !== undefined) {
        material[field] = req.body[field];
      }
    });

    if (req.body.visibility && ['draft', 'published', 'archived'].includes(req.body.visibility)) {
      material.visibility = req.body.visibility;
      if (req.body.visibility === 'published' && !material.publishedAt) {
        material.publishedAt = new Date();
      }
    }

    await material.save();
    return res.status(200).json({ success: true, data: material });
  } catch (error) {
    console.error('updateMaterial error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * 4. PATCH /api/materials/:id/visibility — Toggle draft / published / archived
 */
exports.updateVisibility = async (req, res) => {
  try {
    dbGuard('PATCH /api/materials/:id/visibility');

    const { id } = req.params;
    const { visibility } = req.body;

    if (!['draft', 'published', 'archived'].includes(visibility)) {
      return res.status(400).json({ success: false, message: 'Invalid visibility value.' });
    }

    const material = await Content.findById(id);
    if (!material || material.isDeleted) {
      return res.status(404).json({ success: false, message: 'Material not found.' });
    }

    material.visibility = visibility;
    if (visibility === 'published' && !material.publishedAt) {
      material.publishedAt = new Date();
    }

    await material.save();
    return res.status(200).json({
      success: true,
      message: `Material visibility updated to ${visibility}.`,
      data: material,
    });
  } catch (error) {
    console.error('updateVisibility error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * 5. DELETE /api/materials/:id — Soft-delete
 */
exports.deleteMaterial = async (req, res) => {
  try {
    dbGuard('DELETE /api/materials/:id');

    const { id } = req.params;
    const material = await Content.findById(id);
    if (!material) {
      return res.status(404).json({ success: false, message: 'Material not found.' });
    }

    material.isDeleted = true;
    await material.save();

    return res.status(200).json({
      success: true,
      message: `Material "${material.title}" has been deleted.`,
      id,
    });
  } catch (error) {
    console.error('deleteMaterial error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * 6. GET /api/materials/:id/download — Authenticated download tracking (Amendment 5)
 */
exports.downloadMaterial = async (req, res) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ success: false, message: 'Authentication required to download.' });
    }

    const { id } = req.params;
    const material = await Content.findById(id);
    if (!material || material.isDeleted) {
      return res.status(404).json({ success: false, message: 'Material not found.' });
    }

    // Students can only download published materials
    if (user.role === 'student' && material.visibility !== 'published') {
      return res.status(403).json({ success: false, message: 'This material is not yet published.' });
    }

    // Increment download count on material
    material.downloadCount = (material.downloadCount || 0) + 1;
    await material.save();

    // Log lightweight download event (capped / TTL 90 days, Amendment 5)
    try {
      await MaterialDownload.create({
        materialId: material._id,
        userId: user._id || user.id,
        role: user.role || 'student',
        downloadedAt: new Date(),
      });
    } catch (logErr) {
      console.warn('MaterialDownload logging notice:', logErr.message);
    }

    // Return target file link or redirect
    return res.status(200).json({
      success: true,
      fileUrl: material.fileUrl || material.videoUrl,
      downloadCount: material.downloadCount,
    });
  } catch (error) {
    console.error('downloadMaterial error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * 7. Safe Migration / Seeder (Amendment 3)
 */
exports.seedInitialMaterials = async () => {
  try {
    const devGuardOk = () => {
      try {
        dbGuard('seedInitialMaterials');
        return true;
      } catch {
        return false;
      }
    };

    if (!devGuardOk()) {
      console.log('Skipping seedInitialMaterials in production environment.');
      return;
    }

    const LEGACY_SEED = [
      {
        title: 'Complete Lecture Notes: Matrices, Eigenvalues & Cayley-Hamilton Theorem',
        course: 'Engineering',
        branch: 'CSE',
        semester: 'Semester 1',
        subject: 'Applied Mathematics',
        materialType: 'lecture_notes',
        topic: 'Linear Algebra',
        topicTags: ['Matrices', 'Eigenvalues', 'Cayley-Hamilton'],
        description: 'Comprehensive lecture notes covering characteristic equations, eigenvalues, eigenvectors, and matrix inversion using Cayley-Hamilton.',
        fileSize: 3565158,
        pageCount: 32,
        formulaPreview: '$\\int_0^\\infty e^{-x} x^{n-1} dx = \\Gamma(n)$',
        visibility: 'published',
        downloadCount: 142,
        fileUrl: '/uploads/materials/sample_matrices_notes.pdf',
      },
      {
        title: 'Master Formula Handbook: Beta-Gamma Functions & Evolutes',
        course: 'Engineering',
        branch: 'CSE',
        semester: 'Semester 1',
        subject: 'Applied Mathematics',
        materialType: 'formula_sheet',
        topic: 'Integral Calculus',
        topicTags: ['Beta-Gamma', 'Formulas', 'Evolutes'],
        description: 'Essential formula reference sheet for Euler integrals, duplication formulas, and curvature envelopes.',
        fileSize: 1887436,
        pageCount: 16,
        formulaPreview: 'B(m, n) = \\frac{\\Gamma(m)\\Gamma(n)}{\\Gamma(m+n)}',
        visibility: 'published',
        downloadCount: 289,
        fileUrl: '/uploads/materials/sample_formula_handbook.pdf',
      },
      {
        title: 'Recorded Masterclass: Multivariable Maxima, Minima & Lagrange Multipliers',
        course: 'Engineering',
        branch: 'CSE',
        semester: 'Semester 1',
        subject: 'Applied Mathematics',
        materialType: 'video_lecture',
        topic: 'Multivariable Calculus',
        topicTags: ['Optimization', 'Lagrange Multipliers', 'Critical Points'],
        description: 'Full 65-minute high definition recorded lecture on constrained optimization and saddle point classification.',
        duration: '65 Min HD',
        videoUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        thumbnailUrl: 'https://img.youtube.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
        visibility: 'published',
        downloadCount: 318,
      },
      {
        title: 'MAKAUT & University 10-Year Solved Papers (BS-M101 & BS-M201)',
        course: 'Engineering',
        branch: 'CSE',
        semester: 'Semester 1',
        subject: 'Applied Mathematics',
        materialType: 'pyq_booklet',
        topic: 'Solved PYQ',
        topicTags: ['PYQ', 'MAKAUT', 'Solved Papers'],
        description: 'Comprehensive 10-year question booklet with step-by-step LaTeX model answers for semester examinations.',
        fileSize: 5452595,
        pageCount: 68,
        visibility: 'published',
        downloadCount: 512,
        fileUrl: '/uploads/materials/sample_pyq_booklet.pdf',
      },
      {
        title: 'B.Sc Honours Real Analysis: Metric Spaces & Uniform Convergence Notes',
        course: 'B.Sc',
        branch: 'Mathematics Honours',
        semester: 'Semester 1',
        subject: 'Real Analysis',
        materialType: 'lecture_notes',
        topic: 'Real Analysis',
        topicTags: ['Metric Spaces', 'Sequences', 'Convergence'],
        description: 'In-depth analysis of open sets, compact spaces, Cauchy sequences, and Weierstrass M-test.',
        fileSize: 2936012,
        pageCount: 44,
        visibility: 'published',
        downloadCount: 97,
        fileUrl: '/uploads/materials/sample_real_analysis.pdf',
      },
      {
        title: 'CBSE Class 9 Complete Notes: Number Systems, Polynomials & Euclidean Geometry',
        course: 'CBSE',
        classLevel: 'Class 9',
        subject: 'Mathematics',
        materialType: 'lecture_notes',
        topic: 'Foundational Algebra',
        topicTags: ['Class 9', 'Polynomials', 'Number Systems'],
        description: 'Complete chapter-wise theory, solved NCERT exemplar questions, and revision flashcards.',
        fileSize: 4194304,
        pageCount: 52,
        visibility: 'published',
        downloadCount: 204,
        fileUrl: '/uploads/materials/sample_cbse9_notes.pdf',
      },
    ];

    let seededCount = 0;
    let skippedCount = 0;

    for (const item of LEGACY_SEED) {
      const existing = await Content.findOne({
        title: item.title,
        course: item.course,
        type: { $in: ['material', 'materials'] },
      });

      if (existing) {
        skippedCount++;
        continue;
      }

      const normalized = normalizeCohortItem({
        course: item.course,
        branch: item.branch,
        semester: item.semester,
        classLevel: item.classLevel,
        subject: item.subject,
        title: item.title,
        type: 'material',
      });

      await Content.create({
        ...item,
        type: 'material',
        course: normalized.course,
        branch: normalized.branch,
        semester: normalized.semester,
        classLevel: normalized.classLevel,
        subject: normalized.subject,
        isCommon: normalized.isCommon,
        publishedAt: new Date(),
        isDeleted: false,
      });

      seededCount++;
    }

    console.log(`[SEED_MATERIALS] Migration complete: ${seededCount} seeded, ${skippedCount} skipped.`);
  } catch (err) {
    console.warn('[SEED_MATERIALS] Warning during initial seed:', err.message);
  }
};
