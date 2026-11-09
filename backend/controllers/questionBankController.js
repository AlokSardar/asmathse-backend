const mongoose = require('mongoose');
const Content = require('../models/Content');
const { assertDevOrTestDatabase } = require('../utils/dbGuard');

// Escape helper for safe regex construction
function escapeRegex(str) {
  return String(str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Normalization helper for Question Types
function normalizeQType(val) {
  const s = String(val || '').toLowerCase().trim();
  if (s === 'mcq' || s.includes('choice')) return 'mcq';
  if (s === 'true_false' || s === 'true-false' || s.includes('true') || s.includes('false')) return 'true_false';
  if (s === 'fill_blank' || s === 'fill-blank' || s.includes('fill') || s.includes('blank')) return 'fill_blank';
  return 'subjective';
}

/**
 * Build Cohort-Scoped Base Query with Teacher Role Scoping
 */
function buildCohortQuery(req) {
  const {
    course,
    board,
    branch,
    stream,
    semester,
    classLevel,
    class: queryClass,
    subject,
    topic,
  } = req.query;

  const user = req.user;
  const userRole = String(user?.role || '').toLowerCase();
  const isAdmin = userRole === 'admin' || user?.id === 'master_admin_id';

  // 1. Teacher Scope Validation
  if (userRole === 'teacher' && user?.id !== 'master_admin_id') {
    const teacherCourse = String(user?.targetCourse || user?.course || '').toLowerCase().trim();
    const teacherBranch = String(user?.branch || user?.stream || '').toLowerCase().trim();

    const reqCourse = String(course || board || '').toLowerCase().trim();
    if (reqCourse && teacherCourse && !reqCourse.includes(teacherCourse) && !teacherCourse.includes(reqCourse)) {
      const err = new Error('Forbidden: Teachers cannot access question bank outside their assigned course');
      err.statusCode = 403;
      throw err;
    }

    const reqBranch = String(branch || stream || '').toLowerCase().trim();
    if (reqBranch && teacherBranch && !reqBranch.includes('all') && reqBranch !== teacherBranch) {
      const err = new Error('Forbidden: Teachers cannot access question bank outside their assigned branch');
      err.statusCode = 403;
      throw err;
    }
  }

  const query = {
    isDeleted: { $ne: true },
    $or: [
      { type: { $in: ['question', 'questions', 'pyq', 'pyqs', 'questionbank'] } },
      { questionText: { $exists: true, $ne: null } },
    ],
  };

  const andClauses = [];

  // 2. Stream / Course Matching
  const effectiveCourse = userRole === 'teacher' && user?.id !== 'master_admin_id'
    ? (user?.targetCourse || user?.course || course)
    : course;

  const rawCourse = String(effectiveCourse || board || '').trim().toLowerCase();
  const isSchool = rawCourse.includes('cbse') || rawCourse.includes('icse') || rawCourse.includes('school');
  const isBsc = !isSchool && (rawCourse.includes('bsc') || rawCourse.includes('b.sc') || rawCourse.includes('science'));
  const isEng = !isSchool && !isBsc && (rawCourse.includes('eng') || rawCourse.includes('btech') || rawCourse === 'engineering');

  if (isSchool) {
    const targetBoard = rawCourse.includes('icse') ? 'ICSE' : 'CBSE';
    andClauses.push({
      $or: [
        { board: new RegExp(`^${targetBoard}$`, 'i') },
        { course: new RegExp(`^${targetBoard}$`, 'i') },
      ],
    });

    const targetClass = classLevel || queryClass || semester;
    if (targetClass && String(targetClass).toLowerCase() !== 'all') {
      const numMatch = String(targetClass).match(/\d+/);
      const classNum = numMatch ? numMatch[0] : targetClass;
      andClauses.push({
        $or: [
          { classLevel: new RegExp(`class\\s*${classNum}`, 'i') },
          { classLevel: targetClass },
          { class: new RegExp(`class\\s*${classNum}`, 'i') },
          { class: targetClass },
          { classNumber: Number(classNum) },
          { semester: new RegExp(`class\\s*${classNum}`, 'i') },
          { semester: targetClass },
        ],
      });
    }
  } else if (isBsc) {
    andClauses.push({
      $or: [
        { course: /bsc|b\.sc/i },
        { stream: /bsc/i },
      ],
    });

    const effectiveBranch = userRole === 'teacher' && user?.id !== 'master_admin_id'
      ? (user?.branch || user?.stream || branch)
      : branch;

    if (effectiveBranch && String(effectiveBranch).toLowerCase() !== 'all') {
      const isHonours = /honour|major/i.test(effectiveBranch);
      andClauses.push({
        $or: [
          { branch: isHonours ? /honour|major/i : /general|pass/i },
          { stream: isHonours ? /honour|major/i : /general|pass/i },
        ],
      });
    }

    if (semester && String(semester).toLowerCase() !== 'all') {
      const semMatch = String(semester).match(/\d+/);
      const semNum = semMatch ? semMatch[0] : semester;
      andClauses.push({
        $or: [
          { semester: new RegExp(`semester\\s*${semNum}`, 'i') },
          { semester: String(semNum) },
          { semester: Number(semNum) },
        ],
      });
    }
  } else if (effectiveCourse && String(effectiveCourse).toLowerCase() !== 'all') {
    // Engineering default / specific course
    andClauses.push({
      $or: [
        { course: /engineering|btech|b\.tech|^all$/i },
        { board: /engineering/i },
        { isCommon: true },
        { course: null },
        { course: { $exists: false } },
      ],
    });

    const effectiveBranch = userRole === 'teacher' && user?.id !== 'master_admin_id'
      ? (user?.branch || user?.stream || branch)
      : branch;

    if (effectiveBranch && String(effectiveBranch).toLowerCase() !== 'all') {
      const b = effectiveBranch.trim();
      andClauses.push({
        $or: [
          { branch: new RegExp(`^${escapeRegex(b)}$`, 'i') },
          { stream: new RegExp(`^${escapeRegex(b)}$`, 'i') },
          { isCommon: true },
          { isCommonFirstYear: true },
          { branch: /all\s*branches|common/i },
        ],
      });
    }

    if (semester && String(semester).toLowerCase() !== 'all') {
      const semMatch = String(semester).match(/\d+/);
      const semNum = semMatch ? semMatch[0] : semester;
      andClauses.push({
        $or: [
          { semester: new RegExp(`semester\\s*${semNum}`, 'i') },
          { semester: String(semNum) },
          { semester: Number(semNum) },
          { isCommon: true },
        ],
      });
    }
  }

  // 3. Subject Filter
  if (subject && String(subject).toLowerCase() !== 'all') {
    andClauses.push({
      subject: new RegExp(`^${escapeRegex(subject.trim())}$`, 'i'),
    });
  }

  // 4. Topic Filter
  if (topic && String(topic).toLowerCase() !== 'all') {
    andClauses.push({
      topic: new RegExp(`^${escapeRegex(topic.trim())}$`, 'i'),
    });
  }

  if (andClauses.length > 0) {
    query.$and = andClauses;
  }

  return query;
}

/**
 * @desc    Get Paginated Question Bank with Multi-Dimension Filtering & Live Counts
 * @route   GET /api/content/question-bank
 * @access  Private (Teacher, Admin)
 */
exports.getQuestionBank = async (req, res) => {
  try {
    assertDevOrTestDatabase();

    const baseCohortQuery = buildCohortQuery(req);

    // Filter params specific to Question attributes
    const {
      type,
      qType,
      difficulty,
      marks,
      search,
      page = 1,
      limit = 20,
      sortBy = 'newest',
    } = req.query;

    const questionQuery = { ...baseCohortQuery };
    const specificAndClauses = [...(questionQuery.$and || [])];

    // Type Filter
    const targetType = type || qType;
    if (targetType && String(targetType).toLowerCase() !== 'all') {
      const norm = normalizeQType(targetType);
      if (norm === 'mcq') {
        specificAndClauses.push({
          $or: [{ qType: /^mcq$/i }, { type: /^mcq$/i }, { isOnlineTest: true }],
        });
      } else if (norm === 'true_false') {
        specificAndClauses.push({
          $or: [{ qType: /true.?false|t.?f/i }, { type: /true.?false/i }],
        });
      } else if (norm === 'fill_blank') {
        specificAndClauses.push({
          $or: [{ qType: /fill|blank/i }, { type: /fill|blank/i }],
        });
      } else {
        // subjective
        specificAndClauses.push({
          $or: [
            { qType: /^subjective$/i },
            { type: /^subjective$/i },
            { qType: { $exists: false } },
            { qType: null },
          ],
        });
      }
    }

    // Difficulty Filter
    if (difficulty && String(difficulty).toLowerCase() !== 'all') {
      specificAndClauses.push({
        difficulty: new RegExp(`^${escapeRegex(difficulty.trim())}$`, 'i'),
      });
    }

    // Marks Filter
    if (marks && String(marks).toLowerCase() !== 'all') {
      const numMarks = Number(marks);
      const strMarks = String(marks).trim();
      specificAndClauses.push({
        $or: [
          { marks: numMarks },
          { marks: strMarks },
          { fullMarks: numMarks },
        ],
      });
    }

    // Search Filter (Problem Statement or Formula)
    if (search && String(search).trim()) {
      const cleanSearch = String(search).trim();
      const escaped = escapeRegex(cleanSearch);
      specificAndClauses.push({
        $or: [
          { questionText: new RegExp(escaped, 'i') },
          { title: new RegExp(escaped, 'i') },
          { topic: new RegExp(escaped, 'i') },
          { subject: new RegExp(escaped, 'i') },
        ],
      });
    }

    if (specificAndClauses.length > 0) {
      questionQuery.$and = specificAndClauses;
    }

    // Sorting definition
    let sortConfig = { createdAt: -1, _id: -1 };
    if (sortBy === 'oldest') sortConfig = { createdAt: 1, _id: 1 };
    else if (sortBy === 'marks_high') sortConfig = { marks: -1, createdAt: -1 };
    else if (sortBy === 'marks_low') sortConfig = { marks: 1, createdAt: -1 };
    else if (sortBy === 'difficulty') sortConfig = { difficulty: 1, createdAt: -1 };
    else if (sortBy === 'alphabetical') sortConfig = { title: 1, topic: 1 };

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const skipNum = (pageNum - 1) * limitNum;

    // Execute paginated search and total count in parallel
    const [rawQuestions, totalCount, allCohortQuestions] = await Promise.all([
      Content.find(questionQuery)
        .sort(sortConfig)
        .skip(skipNum)
        .limit(limitNum)
        .lean(),
      Content.countDocuments(questionQuery),
      // Query items for dynamic dimension counts (across cohort without specific type/diff/marks filter)
      Content.find(baseCohortQuery).select('qType type difficulty marks fullMarks').lean(),
    ]);

    // Compute live dimension counts for filter chips
    const counts = {
      types: { mcq: 0, subjective: 0, true_false: 0, fill_blank: 0 },
      difficulties: { easy: 0, medium: 0, hard: 0 },
      marks: {},
      totalCohort: allCohortQuestions.length,
    };

    allCohortQuestions.forEach((q) => {
      // Type counts
      const t = normalizeQType(q.qType || q.type);
      if (counts.types[t] !== undefined) counts.types[t]++;

      // Difficulty counts
      const d = String(q.difficulty || '').toLowerCase();
      if (d === 'easy') counts.difficulties.easy++;
      else if (d === 'medium') counts.difficulties.medium++;
      else if (d === 'hard') counts.difficulties.hard++;

      // Marks counts
      const m = q.marks !== undefined && q.marks !== null ? String(q.marks) : (q.fullMarks ? String(q.fullMarks) : null);
      if (m) {
        counts.marks[m] = (counts.marks[m] || 0) + 1;
      }
    });

    // Strip sensitive answer keys if non-privileged
    const userRole = String(req.user?.role || '').toLowerCase();
    const isTeacherOrAdmin = userRole === 'teacher' || userRole === 'admin' || req.user?.id === 'master_admin_id';

    const sanitizedQuestions = rawQuestions.map((q) => {
      const doc = {
        _id: q._id,
        id: q.id || String(q._id),
        title: q.title,
        type: q.type || 'question',
        qType: q.qType || (q.options?.length > 0 ? 'MCQ' : 'Subjective'),
        course: q.course,
        branch: q.branch,
        semester: q.semester,
        classLevel: q.classLevel,
        subject: q.subject || 'Mathematics',
        topic: q.topic || 'General Mathematics',
        difficulty: q.difficulty || 'Medium',
        marks: Number(q.marks || q.fullMarks || 4),
        questionText: q.questionText || q.title || '',
        options: Array.isArray(q.options) ? q.options : [],
        isCommon: Boolean(q.isCommon || q.isCommonFirstYear),
        yearTag: q.examYear ? `${q.examYear} PYQ` : (q.academicYear || null),
        createdAt: q.createdAt,
        updatedAt: q.updatedAt,
      };

      if (isTeacherOrAdmin) {
        doc.correctOption = q.correctOption ?? 0;
        doc.finalAnswer = q.finalAnswer || '';
        doc.steps = q.steps || [];
        doc.explanation = q.explanation || (q.steps?.length > 0 ? q.steps[0] : '');
      }

      return doc;
    });

    return res.status(200).json({
      success: true,
      data: sanitizedQuestions,
      pagination: {
        total: totalCount,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.ceil(totalCount / limitNum) || 1,
      },
      counts,
    });
  } catch (err) {
    console.error('getQuestionBank error:', err);
    return res.status(err.statusCode || 500).json({
      success: false,
      message: err.message || 'Failed to retrieve question bank items.',
    });
  }
};

/**
 * @desc    Get Available Cohort Metadata (Subjects, Topics, Total Counts)
 * @route   GET /api/content/question-bank/meta
 * @access  Private (Teacher, Admin)
 */
exports.getQuestionBankMeta = async (req, res) => {
  try {
    assertDevOrTestDatabase();

    const baseCohortQuery = buildCohortQuery(req);

    // Retrieve distinct subjects and topics for the specified cohort
    const [subjects, topics, totalQuestions] = await Promise.all([
      Content.distinct('subject', baseCohortQuery),
      Content.distinct('topic', baseCohortQuery),
      Content.countDocuments(baseCohortQuery),
    ]);

    const cleanSubjects = subjects.filter((s) => s && String(s).trim().length > 0).sort();
    const cleanTopics = topics.filter((t) => t && String(t).trim().length > 0).sort();

    return res.status(200).json({
      success: true,
      data: {
        cohort: {
          course: req.query.course || 'Engineering',
          branch: req.query.branch || 'CSE',
          semester: req.query.semester || 'Semester 1',
          classLevel: req.query.classLevel || null,
        },
        subjects: cleanSubjects,
        topics: cleanTopics,
        totalQuestions,
      },
      cohort: {
        course: req.query.course || 'Engineering',
        branch: req.query.branch || 'CSE',
        semester: req.query.semester || 'Semester 1',
        classLevel: req.query.classLevel || null,
      },
      subjects: cleanSubjects,
      topics: cleanTopics,
      totalQuestionsInCohort: totalQuestions,
    });
  } catch (err) {
    console.error('getQuestionBankMeta error:', err);
    return res.status(err.statusCode || 500).json({
      success: false,
      message: err.message || 'Failed to retrieve question bank metadata.',
    });
  }
};
