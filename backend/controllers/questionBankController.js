const mongoose = require('mongoose');
const Content = require('../models/Content');
const ClassTest = require('../models/ClassTest');
const Syllabus = require('../models/Syllabus');
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
      { type: { $in: ['question', 'questions', 'pyq', 'pyqs', 'questionbank', 'mcq'] } },
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

  // 3. Subject Filter & Unassigned Bucket Behavior (Amendment 6)
  if (subject && String(subject).toLowerCase() !== 'all') {
    const sLower = String(subject).toLowerCase().trim();
    if (sLower === 'unassigned') {
      andClauses.push({
        $or: [
          { subject: null },
          { subject: { $exists: false } },
          { subject: '' },
          { subject: /unassigned/i },
        ],
      });
    } else {
      andClauses.push({
        subject: new RegExp(`^${escapeRegex(subject.trim())}$`, 'i'),
      });
    }
  }

  // 4. Topic Filter
  if (topic && String(topic).toLowerCase() !== 'all') {
    const tLower = String(topic).toLowerCase().trim();
    if (tLower === 'unassigned') {
      andClauses.push({
        $or: [
          { topic: null },
          { topic: { $exists: false } },
          { topic: '' },
          { topic: /unassigned/i },
        ],
      });
    } else {
      andClauses.push({
        topic: new RegExp(`^${escapeRegex(topic.trim())}$`, 'i'),
      });
    }
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
      source,
      search,
      page = 1,
      limit = 20,
      sortBy = 'newest',
    } = req.query;

    const questionQuery = { ...baseCohortQuery };
    const specificAndClauses = [...(questionQuery.$and || [])];

    // Source Filter
    if (source && String(source).toLowerCase() !== 'all') {
      const s = String(source).toLowerCase().trim();
      if (s === 'pyq') {
        specificAndClauses.push({
          $or: [
            { source: /^pyq/i },
            { importSource: 'PYQ Manager' },
            { pyqYear: { $exists: true, $ne: null } },
          ],
        });
      } else if (s === 'ai_import' || s === 'ai-import' || s === 'ai') {
        specificAndClauses.push({
          $or: [
            { source: /ai import/i },
            { importSource: 'AI Import' },
          ],
        });
      } else if (s === 'seed') {
        specificAndClauses.push({
          $or: [
            { source: /^seed$/i },
            { importSource: 'Seed' },
          ],
        });
      } else if (s === 'original' || s === 'manual') {
        specificAndClauses.push({
          $or: [
            { source: /^original$/i },
            { source: /^manual$/i },
            { importSource: 'Manual' },
            { source: { $exists: false } },
            { source: null },
          ],
        });
      }
    }

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

    // Unsolved Status Filter (steps empty/null and finalAnswer empty/null)
    if (req.query.unsolved === 'true' || req.query.status === 'unsolved') {
      specificAndClauses.push({
        $and: [
          { $or: [{ finalAnswer: { $exists: false } }, { finalAnswer: null }, { finalAnswer: '' }] },
          { $or: [{ steps: { $exists: false } }, { steps: null }, { steps: { $size: 0 } }] },
        ],
      });
    }

    // Unverified Status Filter (isVerified is false, null, or not set)
    if (req.query.unverified === 'true' || req.query.status === 'unverified') {
      specificAndClauses.push({
        $or: [
          { isVerified: false },
          { isVerified: { $exists: false } },
          { isVerified: null },
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

    // Execute paginated search, total count, dimension query, and tests lookup in parallel
    const [rawQuestions, totalCount, allCohortQuestions, activeClassTests] = await Promise.all([
      Content.find(questionQuery)
        .sort(sortConfig)
        .skip(skipNum)
        .limit(limitNum)
        .lean(),
      Content.countDocuments(questionQuery),
      Content.find(baseCohortQuery)
        .select('qType type difficulty marks fullMarks source importSource pyqYear steps finalAnswer isVerified')
        .lean(),
      ClassTest.find({ isDeleted: { $ne: true } })
        .select('title id testId questions examDate')
        .lean(),
    ]);

    // Compute live dimension counts for filter chips
    const counts = {
      types: { mcq: 0, subjective: 0, true_false: 0, fill_blank: 0 },
      difficulties: { easy: 0, medium: 0, hard: 0 },
      marks: {},
      sources: { all: allCohortQuestions.length, ai_import: 0, pyq: 0, original: 0, seed: 0 },
      unsolvedCount: 0,
      unverifiedCount: 0,
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

      // Source counts
      let srcCat = 'original';
      if (q.source === 'PYQ' || q.importSource === 'PYQ Manager' || q.pyqYear) srcCat = 'pyq';
      else if (String(q.source || '').includes('AI Import') || q.importSource === 'AI Import') srcCat = 'ai_import';
      else if (q.importSource === 'Seed' || q.source === 'Seed') srcCat = 'seed';
      counts.sources[srcCat] = (counts.sources[srcCat] || 0) + 1;

      // Unsolved count
      const isUnsolved = !q.finalAnswer && (!q.steps || q.steps.length === 0);
      if (isUnsolved) counts.unsolvedCount++;

      // Unverified count
      if (!q.isVerified) counts.unverifiedCount++;
    });

    const userRole = String(req.user?.role || '').toLowerCase();
    const isTeacherOrAdmin = userRole === 'teacher' || userRole === 'admin' || req.user?.id === 'master_admin_id';

    const sanitizedQuestions = rawQuestions.map((q) => {
      let qSource = 'Original';
      if (q.source === 'PYQ' || q.importSource === 'PYQ Manager' || q.pyqYear) qSource = 'PYQ';
      else if (String(q.source || '').includes('AI Import') || q.importSource === 'AI Import') qSource = 'AI Import';
      else if (q.importSource === 'Seed' || q.source === 'Seed') qSource = 'Seed';

      // Dynamic ClassTest lookup (Amendment 3)
      const qMatches = (activeClassTests || []).filter((t) => {
        if (!Array.isArray(t.questions)) return false;
        return t.questions.some((tq) => {
          if (!tq) return false;
          if (tq.id && (tq.id === q.id || tq.id === q.customId || String(tq.id) === String(q._id))) return true;
          if (tq.customId && (tq.customId === q.customId || tq.customId === q.id)) return true;
          if (tq.questionText && q.questionText && tq.questionText.trim() === q.questionText.trim()) return true;
          return false;
        });
      });

      const doc = {
        _id: q._id,
        id: q.id || String(q._id),
        customId: q.customId || q.id || String(q._id),
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
        source: qSource,
        importSource: q.importSource || 'Manual',
        importSessionId: q.importSessionId || null,
        contentHash: q.contentHash || null,
        duplicate_of: q.duplicate_of || null,
        pyqYear: q.pyqYear || (q.examYear ? Number(q.examYear) : null),
        pyqExam: q.pyqExam || q.examName || '',
        solutionHidden: Boolean(q.solutionHidden),
        solutionLanguage: q.solutionLanguage || 'english',
        graphicSvg: q.graphicSvg || '',
        rubric: q.rubric || null,
        isVerified: Boolean(q.isVerified),
        verifiedBy: q.verifiedBy || null,
        verifiedAt: q.verifiedAt || null,
        testsUsedCount: qMatches.length,
        testsUsedIn: qMatches.map((t) => ({ id: t.id || t.testId, title: t.title, date: t.examDate })),
        createdAt: q.createdAt,
        updatedAt: q.updatedAt,
      };

      // Server-side field stripping for student safety (Amendment 4)
      if (userRole === 'student' || !isTeacherOrAdmin) {
        if (q.solutionHidden) {
          delete doc.steps;
          delete doc.finalAnswer;
          delete doc.graphicSvg;
          delete doc.explanation;
        } else {
          doc.finalAnswer = q.finalAnswer || '';
          doc.steps = q.steps || [];
        }
      } else {
        // Teacher / Admin receives full answer keys & verification details
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
 * @desc    Get Available Cohort Metadata & Structured Taxonomy Tree
 * @route   GET /api/content/question-bank/meta
 * @access  Private (Teacher, Admin)
 */
exports.getQuestionBankMeta = async (req, res) => {
  try {
    assertDevOrTestDatabase();

    const baseCohortQuery = buildCohortQuery(req);

    // Retrieve all cohort questions and syllabus modules
    const [allQuestions, distinctSubjects, distinctTopics, totalQuestions] = await Promise.all([
      Content.find(baseCohortQuery)
        .select('subject topic source importSource pyqYear')
        .lean(),
      Content.distinct('subject', baseCohortQuery),
      Content.distinct('topic', baseCohortQuery),
      Content.countDocuments(baseCohortQuery),
    ]);

    const targetCourse = req.query.course || 'Engineering';
    const syllabusList = await Syllabus.find({
      course: new RegExp(`^${escapeRegex(targetCourse)}$`, 'i'),
      isDeleted: { $ne: true },
    }).select('subjectName modules').lean();

    // Construct Taxonomy Tree with source breakdown per subject
    const subjectMap = new Map();
    let unassignedCount = 0;

    // Seed syllabus subjects & topics with 0 count
    syllabusList.forEach((s) => {
      const sName = s.subjectName?.trim();
      if (!sName) return;
      if (!subjectMap.has(sName)) {
        subjectMap.set(sName, {
          name: sName,
          count: 0,
          sources: { aiImport: 0, pyq: 0, original: 0, seed: 0 },
          topicsMap: {},
        });
      }
      const entry = subjectMap.get(sName);
      (s.modules || []).forEach((m) => {
        (m.topics || []).forEach((top) => {
          const tName = top?.trim();
          if (tName && entry.topicsMap[tName] === undefined) {
            entry.topicsMap[tName] = 0;
          }
        });
      });
    });

    // Populate actual question counts & source breakdowns
    allQuestions.forEach((q) => {
      const sName = q.subject?.trim();
      const tName = q.topic?.trim();

      if (!sName || sName.toLowerCase() === 'unassigned' || !tName) {
        unassignedCount++;
        return;
      }

      if (!subjectMap.has(sName)) {
        subjectMap.set(sName, {
          name: sName,
          count: 0,
          sources: { aiImport: 0, pyq: 0, original: 0, seed: 0 },
          topicsMap: {},
        });
      }

      const sObj = subjectMap.get(sName);
      sObj.count++;

      let src = 'original';
      if (q.source === 'PYQ' || q.importSource === 'PYQ Manager' || q.pyqYear) src = 'pyq';
      else if (String(q.source || '').includes('AI Import') || q.importSource === 'AI Import') src = 'aiImport';
      else if (q.importSource === 'Seed' || q.source === 'Seed') src = 'seed';
      sObj.sources[src] = (sObj.sources[src] || 0) + 1;

      sObj.topicsMap[tName] = (sObj.topicsMap[tName] || 0) + 1;
    });

    const subjectsTree = Array.from(subjectMap.values())
      .map((s) => ({
        name: s.name,
        count: s.count,
        sources: s.sources,
        topics: Object.entries(s.topicsMap)
          .map(([name, count]) => ({ name, count }))
          .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
      }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

    const cleanSubjects = distinctSubjects.filter((s) => s && String(s).trim().length > 0).sort();
    const cleanTopics = distinctTopics.filter((t) => t && String(t).trim().length > 0).sort();

    return res.status(200).json({
      success: true,
      data: {
        cohort: {
          course: req.query.course || 'Engineering',
          branch: req.query.branch || 'CSE',
          semester: req.query.semester || 'Semester 1',
          classLevel: req.query.classLevel || null,
        },
        subjects: subjectsTree,
        topics: cleanTopics,
        flatSubjects: cleanSubjects,
        totalQuestions,
        unassignedCount,
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

/**
 * @desc    Add subject or topic directly to cohort taxonomy
 * @route   PATCH /api/content/question-bank/meta
 * @access  Private (Teacher, Admin)
 */
exports.patchQuestionBankMeta = async (req, res) => {
  try {
    assertDevOrTestDatabase();
    const { course, branch, semester, classLevel, subject, topic } = req.body;
    if (!subject && !topic) {
      return res.status(400).json({ success: false, message: 'Subject or topic is required' });
    }

    const syllabusQuery = {
      course: new RegExp(`^${escapeRegex(course || 'Engineering')}$`, 'i'),
      isDeleted: { $ne: true },
    };
    if (subject) syllabusQuery.subjectName = new RegExp(`^${escapeRegex(subject.trim())}$`, 'i');

    let syllabus = await Syllabus.findOne(syllabusQuery);
    if (syllabus) {
      if (topic) {
        if (!syllabus.modules || syllabus.modules.length === 0) {
          syllabus.modules = [{ id: 'MOD-1', moduleNumber: 1, title: 'General Topics', topics: [topic.trim()] }];
        } else {
          if (!syllabus.modules[0].topics.includes(topic.trim())) {
            syllabus.modules[0].topics.push(topic.trim());
          }
        }
        await syllabus.save();
      }
    } else if (subject) {
      const newSyllabus = new Syllabus({
        subjectName: subject.trim(),
        subjectCode: `SUB-${Date.now().toString().slice(-4)}`,
        course: course || 'Engineering',
        branch: branch || 'CSE',
        semester: semester || 'Semester 1',
        classLevel: classLevel || null,
        modules: topic ? [{ id: 'MOD-1', moduleNumber: 1, title: 'General Topics', topics: [topic.trim()] }] : [],
      });
      await newSyllabus.save();
    }

    return res.status(200).json({
      success: true,
      message: `Taxonomy updated successfully with ${subject || ''} ${topic || ''}`.trim(),
    });
  } catch (err) {
    console.error('patchQuestionBankMeta error:', err);
    return res.status(err.statusCode || 500).json({ success: false, message: err.message });
  }
};
