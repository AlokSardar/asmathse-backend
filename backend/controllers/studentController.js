const Content = require('../models/Content');
const Assignment = require('../models/Assignment');
const Submission = require('../models/Submission');

const escapeRegex = (str) => {
  if (typeof str !== 'string') return '';
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
};

// @desc    Get content based on student's stream, branch, course and semester
// @route   GET /api/student/content
// @access  Private/Student
const getStudentContent = async (req, res) => {
  try {
    const user = req.user || {};
    const q = req.query || {};

    // Determine active curriculum/board context
    const rawCourse = String(q.course || q.board || user.targetCourse || user.course || user.board || user.stream || '').trim().toLowerCase();
    const isIcse = rawCourse.includes('icse') || rawCourse.includes('isc') || (user.board && /icse/i.test(user.board)) || (q.board && /icse/i.test(q.board));
    const isCbse = !isIcse && (rawCourse.includes('cbse') || rawCourse.includes('school') || (user.board && /cbse/i.test(user.board)) || (q.board && /cbse/i.test(q.board)) ||
      (q.classLevel && /class/i.test(String(q.classLevel))) ||
      (q.class && /class/i.test(String(q.class))) ||
      (q.class_name && /class/i.test(String(q.class_name))) ||
      (q.className && /class/i.test(String(q.className))) ||
      (user.classLevel && /class/i.test(String(user.classLevel))) ||
      (user.class_name && /class/i.test(String(user.class_name))) ||
      (user.class && /class/i.test(String(user.class))) ||
      (user.className && /class/i.test(String(user.className))));
    const isSchool = isIcse || isCbse;
    const isJee = !isSchool && (rawCourse.includes('jee') || rawCourse.includes('iit'));
    const isBsc = !isSchool && !isJee && (rawCourse.includes('bsc') || rawCourse.includes('b.sc') || rawCourse.includes('science'));

    const query = {};

    // 1. Content Type Filter (e.g. syllabus, materials, pyq, assignments)
    const targetType = q.type;
    if (targetType) {
      const normType = String(targetType).trim().toLowerCase();
      if (normType === 'syllabus' || normType === 'curriculum') {
        query.type = { $in: [/^syllabus$/i, /^curriculum$/i] };
      } else if (normType === 'materials' || normType === 'material' || normType === 'notes') {
        query.type = { $in: [/^materials?$/i, /^notes?$/i, /^study_materials?$/i, /^textbooks?$/i, /^lecture$/i] };
      } else if (normType === 'pyq' || normType === 'pyqs') {
        query.type = { $in: [/^pyqs?$/i, /^previous_year$/i, /^pyq_solution$/i] };
      } else if (normType === 'assignment' || normType === 'assignments') {
        query.type = { $in: [/^assignments?$/i, /^homework$/i, /^problem_set$/i] };
      } else if (normType === 'classtest' || normType === 'classtests') {
        query.type = { $in: [/^classtests?$/i, /^test$/i, /^exam$/i] };
      } else {
        query.type = new RegExp(`^${normType}$`, 'i');
      }
    }

    if (isSchool) {
      // Precise School active context: Board, Class Level, Subject (strictly isolated from engineering/semesters)
      const activeClass = q.classLevel || q.class || q.class_name || q.className || user.classLevel || user.class || user.class_name || user.className;
      const activeSubject = q.subject || user.subject || 'Mathematics';
      const targetBoard = isIcse ? 'icse' : 'cbse';

      const schoolClauses = [
        {
          $or: targetBoard === 'icse' ? [
            { board: /^icse$/i },
            { course: /^icse$/i },
            { stream: /^icse$/i }
          ] : [
            { board: /^cbse$/i },
            { course: /^cbse$/i },
            { stream: /^cbse$/i }
          ]
        }
      ];

      if (activeClass) {
        const numLevel = String(activeClass).replace(/[^0-9]/g, '');
        const classConditions = [
          { classLevel: new RegExp(`^${activeClass}$`, 'i') },
          { class: new RegExp(`^${activeClass}$`, 'i') },
          { class_name: new RegExp(`^${activeClass}$`, 'i') },
          { className: new RegExp(`^${activeClass}$`, 'i') },
          { classLevel: /all/i },
          { class: /all/i }
        ];
        if (numLevel) {
          const numVal = Number(numLevel);
          classConditions.push(
            { classLevel: numVal },
            { class: numVal },
            { class_name: numVal },
            { className: numVal },
            { classNumber: numVal },
            { classLevel: numLevel },
            { class: numLevel },
            { class_name: numLevel },
            { className: numLevel },
            { classLevel: new RegExp(`(^|\\b|class\\s*)${numLevel}(th)?($|\\b)`, 'i') },
            { class: new RegExp(`(^|\\b|class\\s*)${numLevel}(th)?($|\\b)`, 'i') },
            { class_name: new RegExp(`(^|\\b|class\\s*)${numLevel}(th)?($|\\b)`, 'i') },
            { className: new RegExp(`(^|\\b|class\\s*)${numLevel}(th)?($|\\b)`, 'i') }
          );
        }
        schoolClauses.push({ $or: classConditions });
      }

      if (activeSubject) {
        const subConditions = [
          { subject: new RegExp(`^${escapeRegex(activeSubject)}$`, 'i') },
          { subject: /all/i },
          { subject: null },
          { subject: { $exists: false } },
          { subject: '' }
        ];
        if (/math/i.test(activeSubject) || /^both$/i.test(activeSubject)) {
          subConditions.push(
            { subject: /math/i },
            { subject: /both/i }
          );
        }
        schoolClauses.push({ $or: subConditions });
      }

      if (query.type) {
        schoolClauses.push({ type: query.type });
        delete query.type;
      }

      query.$and = schoolClauses;

    } else if (isJee) {
      const jeeClauses = [
        {
          $or: [
            { course: /jee|iit|^all$/i },
            { stream: /jee|iit/i },
            { course: null }
          ]
        }
      ];
      if (query.type) {
        jeeClauses.push({ type: query.type });
        delete query.type;
      }
      query.$and = jeeClauses;

    } else if (isBsc) {
      const branch = q.branch || user.branch || user.stream;
      const semester = q.semester !== undefined ? q.semester : user.semester;
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
      if (query.type) {
        bscClauses.push({ type: query.type });
        delete query.type;
      }
      query.$and = bscClauses;

    } else {
      // Engineering
      const branch = q.branch || user.branch || user.stream || 'CSE';
      const semester = q.semester !== undefined ? q.semester : user.semester;
      const engClauses = [
        {
          $or: [
            { course: /engineering|btech|b\.tech|makaut|^all$/i },
            { course: null },
            { course: { $exists: false } }
          ]
        }
      ];

      const cleanSem = semester !== undefined && semester !== null && semester !== '' ? String(semester).replace(/[^0-9]/g, '') : '';
      const semNum = Number(cleanSem);
      const isCommon1stYr = semNum === 1 || semNum === 2;

      if (branch) {
        const branchConds = [
          new RegExp(`^${branch}$`, 'i'),
          /common/i,
          /^all/i,
          /unified/i
        ];
        if (/cse|computer/i.test(branch)) branchConds.push(/cse|computer|comp/i);
        else if (/it|information/i.test(branch)) branchConds.push(/it|information|info/i);
        else if (/ece|electronic/i.test(branch)) branchConds.push(/ece|electronic|comm/i);
        else if (/ee|electrical/i.test(branch)) branchConds.push(/ee|electrical/i);
        else if (/me|mech/i.test(branch)) branchConds.push(/me|mech/i);
        else if (/ce|civil/i.test(branch)) branchConds.push(/ce|civil/i);

        const branchClauses = [
          ...branchConds.map(r => ({ branch: r })),
          ...branchConds.map(r => ({ stream: r }))
        ];
        if (isCommon1stYr) {
          branchClauses.push({ isCommonFirstYear: true });
        }
        engClauses.push({ $or: branchClauses });
      }

      if (cleanSem) {
        const semConditions = [
          { semester: cleanSem },
          { semester: semNum },
          { semester: /all/i },
          { semester: null }
        ];
        if (isCommon1stYr) {
          semConditions.push({ branch: /common/i });
          semConditions.push({ isCommonFirstYear: true });
        }
        engClauses.push({ $or: semConditions });
      }

      if (query.type) {
        engClauses.push({ type: query.type });
        delete query.type;
      }

      query.$and = engClauses;
    }

    console.log('[STUDENT_PORTAL_FETCH_QUERY]', JSON.stringify({
      student: {
        name: user.name,
        email: user.email,
        stream: user.stream,
        board: user.board,
        targetCourse: user.targetCourse,
        classLevel: user.classLevel,
        class: user.class,
        subject: user.subject
      },
      incomingQuery: q,
      mongoFilter: query
    }, null, 2));

    const contents = await Content.find(query).sort({ uploadedAt: -1, createdAt: -1 });
    res.json(contents);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get assignments for the student (unified from Assignment & Content collections)
// @route   GET /api/student/assignments
// @access  Private/Student
const getStudentAssignments = async (req, res) => {
  try {
    const user = req.user || {};
    const rawCourse = String(user.targetCourse || user.course || user.board || user.stream || '').trim().toLowerCase();
    const isIcse = rawCourse.includes('icse') || rawCourse.includes('isc') || (user.board && /icse/i.test(user.board));
    const isCbse = !isIcse && (rawCourse.includes('cbse') || rawCourse.includes('school') || (user.board && /cbse/i.test(user.board)) ||
      (user.classLevel && /class/i.test(String(user.classLevel))) ||
      (user.class_name && /class/i.test(String(user.class_name))) ||
      (user.class && /class/i.test(String(user.class))) ||
      (user.className && /class/i.test(String(user.className))));
    const isSchool = isIcse || isCbse;
    const isJee = !isSchool && (rawCourse.includes('jee') || rawCourse.includes('iit'));
    const isBsc = !isSchool && !isJee && (rawCourse.includes('bsc') || rawCourse.includes('b.sc') || rawCourse.includes('science'));

    if (isSchool) {
      const activeClass = user.classLevel || user.class || user.class_name || user.className;
      const numLevel = activeClass ? String(activeClass).replace(/[^0-9]/g, '') : '';
      const numVal = numLevel ? Number(numLevel) : null;
      const targetBoard = isIcse ? 'icse' : 'cbse';

      const classFilter = [];
      if (activeClass) {
        classFilter.push(
          { classLevel: new RegExp(`^${activeClass}$`, 'i') },
          { class: new RegExp(`^${activeClass}$`, 'i') },
          { class_name: new RegExp(`^${activeClass}$`, 'i') },
          { className: new RegExp(`^${activeClass}$`, 'i') }
        );
        if (numVal !== null) {
          classFilter.push(
            { classNumber: numVal },
            { classLevel: numVal },
            { class_name: numVal },
            { className: numVal },
            { classLevel: new RegExp(`(^|\\b|class\\s*)${numLevel}(th)?($|\\b)`, 'i') },
            { class_name: new RegExp(`(^|\\b|class\\s*)${numLevel}(th)?($|\\b)`, 'i') }
          );
        }
      }

      const boardRegex = targetBoard === 'icse' ? /^icse$/i : /^cbse$/i;
      const contentQuery = {
        type: { $in: ['assignment', 'assignments'] },
        $or: [{ board: boardRegex }, { course: boardRegex }, { stream: boardRegex }]
      };
      if (classFilter.length > 0) {
        contentQuery.$and = [{ $or: classFilter }];
      }

      const [assignments, contentAssignments] = await Promise.all([
        Assignment.find({ $or: [{ stream: boardRegex }, { board: boardRegex }] }).sort({ createdAt: -1 }).catch(() => []),
        Content.find(contentQuery).sort({ uploadedAt: -1 }).catch(() => [])
      ]);

      const map = new Map();
      [...assignments, ...contentAssignments].forEach(a => {
        const id = String(a.id || a._id || a.title);
        if (!map.has(id)) map.set(id, a);
      });

      return res.json(Array.from(map.values()));
    }

    if (isJee) {
      const [assignments, contentAssignments] = await Promise.all([
        Assignment.find({ $or: [{ stream: /jee/i }, { branch: /jee/i }] }).sort({ createdAt: -1 }).catch(() => []),
        Content.find({
          type: { $in: ['assignment', 'assignments'] },
          $or: [{ course: /jee/i }, { stream: /jee/i }, { branch: /jee/i }]
        }).sort({ uploadedAt: -1 }).catch(() => [])
      ]);
      const map = new Map();
      [...assignments, ...contentAssignments].forEach(a => {
        const id = String(a.id || a._id || a.title);
        if (!map.has(id)) map.set(id, a);
      });
      return res.json(Array.from(map.values()));
    }

    if (isBsc) {
      const branch = user.branch || user.stream || 'BSc (Honours) (Major)';
      const isHon = /hon|major/i.test(branch);
      const sem = user.semester ? String(user.semester).replace(/[^0-9]/g, '') : '';
      const contentQuery = {
        type: { $in: ['assignment', 'assignments'] },
        $or: [{ course: /bsc|b\.sc|science/i }, { stream: /bsc/i }],
        branch: isHon ? /hon|major/i : /gen|pass/i
      };
      if (sem) {
        contentQuery.$and = [{ $or: [{ semester: sem }, { semester: Number(sem) }, { semester: /all/i }, { semester: null }] }];
      }
      const [assignments, contentAssignments] = await Promise.all([
        Assignment.find({ $or: [{ stream: /bsc/i }, { branch: isHon ? /hon|major/i : /gen|pass/i }] }).sort({ createdAt: -1 }).catch(() => []),
        Content.find(contentQuery).sort({ uploadedAt: -1 }).catch(() => [])
      ]);
      const map = new Map();
      [...assignments, ...contentAssignments].forEach(a => {
        const id = String(a.id || a._id || a.title);
        if (!map.has(id)) map.set(id, a);
      });
      return res.json(Array.from(map.values()));
    }

    // Engineering Curriculum
    const stream = user.stream || user.branch || 'CSE';
    const branch = user.branch || user.stream || 'CSE';
    const semester = user.semester;
    const cleanSem = semester !== undefined && semester !== null && semester !== '' ? String(semester).replace(/[^0-9]/g, '') : '';
    const semNum = Number(cleanSem);
    const isCommon1stYr = semNum === 1 || semNum === 2;

    const branchConds = [
      new RegExp(`^${branch}$`, 'i'),
      /common/i,
      /^all/i,
      /unified/i
    ];
    if (/cse|computer/i.test(branch)) branchConds.push(/cse|computer|comp/i);
    else if (/it|information/i.test(branch)) branchConds.push(/it|information|info/i);
    else if (/ece|electronic/i.test(branch)) branchConds.push(/ece|electronic|comm/i);
    else if (/ee|electrical/i.test(branch)) branchConds.push(/ee|electrical/i);
    else if (/me|mech/i.test(branch)) branchConds.push(/me|mech/i);
    else if (/ce|civil/i.test(branch)) branchConds.push(/ce|civil/i);

    const branchClauses = [
      ...branchConds.map(r => ({ branch: r })),
      ...branchConds.map(r => ({ stream: r }))
    ];
    if (isCommon1stYr) {
      branchClauses.push({ isCommonFirstYear: true });
    }

    const engContentQuery = {
      type: { $in: ['assignment', 'assignments'] },
      $or: branchClauses,
      board: { $nin: [/^cbse$/i, /^icse$/i] }
    };

    if (cleanSem) {
      const semConditions = [
        { semester: cleanSem },
        { semester: semNum },
        { semester: /all/i },
        { semester: null }
      ];
      if (isCommon1stYr) {
        semConditions.push({ branch: /common/i });
        semConditions.push({ isCommonFirstYear: true });
      }
      engContentQuery.$and = [{ $or: semConditions }];
    }

    const [assignments, contentAssignments] = await Promise.all([
      Assignment.find({
        $or: [{ stream }, { stream: branch }, { branch }],
        ...(cleanSem ? { semester: semNum || cleanSem } : {})
      }).sort({ createdAt: -1 }).catch(() => []),
      Content.find(engContentQuery).sort({ uploadedAt: -1 }).catch(() => [])
    ]);

    const map = new Map();
    [...assignments, ...contentAssignments].forEach(a => {
      const id = String(a.id || a._id || a.title);
      if (!map.has(id)) map.set(id, a);
    });

    res.json(Array.from(map.values()));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Submit an assignment
// @route   POST /api/student/submissions
// @access  Private/Student
const submitAssignment = async (req, res) => {
  const { assignmentId, answerFileUrl } = req.body;
  try {
    // Check if already submitted
    const existingSubmission = await Submission.findOne({
      assignment: assignmentId,
      student: req.user.id
    });
    
    if (existingSubmission) {
      return res.status(400).json({ message: 'Assignment already submitted' });
    }

    const submission = await Submission.create({
      assignment: assignmentId,
      student: req.user.id,
      answerFileUrl
    });
    res.status(201).json(submission);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get my submissions and performance
// @route   GET /api/student/submissions
// @access  Private/Student
const getMySubmissions = async (req, res) => {
  try {
    const submissions = await Submission.find({ student: req.user.id })
                                        .populate('assignment', 'title deadline');
    res.json(submissions);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  getStudentContent,
  getStudentAssignments,
  submitAssignment,
  getMySubmissions
};
