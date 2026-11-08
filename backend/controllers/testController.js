const { verifyToken } = require('../config/jwt');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const ClassTest = require('../models/ClassTest');
const Content = require('../models/Content');
const TestSubmission = require('../models/TestSubmission');
const Notification = require('../models/Notification');

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
      const decoded = verifyToken(token);
      const decodedRole = String(decoded.role || '').toLowerCase();
      if (decodedRole === 'admin' || decodedRole === 'teacher' || decoded.id === 'master_admin_id') {
        return true;
      }
    } catch (_) {}
  }
  return false;
};

exports.createTest = async (req, res) => {
  try {
    const ALL_ENGINEERING_STREAMS = ['CSE', 'ECE', 'ME', 'EE', 'CE', 'IT'];
    const body = { ...req.body };
    const { title, course, branch, semester, classLevel } = body;

    const rawCourse = String(course || body.board || 'Engineering').trim();
    if (/cbse/i.test(rawCourse)) {
      const rawCl = String(classLevel || body.class || semester || 'Class 9').trim();
      const m = rawCl.match(/(9|10|11|12)/);
      const normCl = m ? `Class ${m[1]}` : rawCl;
      body.course = 'CBSE';
      body.board = 'CBSE';
      body.branch = branch || 'CBSE Standard';
      body.semester = normCl;
      body.classLevel = normCl;
      body.class = normCl;
    } else if (/icse|isc/i.test(rawCourse)) {
      const rawCl = String(classLevel || body.class || semester || 'Class 9').trim();
      const m = rawCl.match(/(9|10|11|12)/);
      const normCl = m ? `Class ${m[1]}` : rawCl;
      body.course = 'ICSE';
      body.board = 'ICSE';
      body.branch = branch || 'ICSE / ISC';
      body.semester = normCl;
      body.classLevel = normCl;
      body.class = normCl;
    } else if (/engineering|b\.?tech/i.test(rawCourse)) {
      body.course = 'Engineering';
      const semMatch = String(semester || '1').match(/([1-8])/);
      body.semester = semMatch ? `Semester ${semMatch[1]}` : 'Semester 1';
      const isAllBranches =
        /all\s*branches|common|^all$/i.test(String(branch || body.stream || '').trim()) ||
        body.isCommon === true ||
        body.isCommonFirstYear === true;
      if (isAllBranches) {
        body.branch = 'All Branches';
        body.stream = 'All Branches';
        body.isCommon = true;
        body.isCommonFirstYear = body.semester === 'Semester 1';
        body.targetBranches = [];
        body.streamMappings = [];
        for (const streamCode of ALL_ENGINEERING_STREAMS) {
          body.targetBranches.push(streamCode);
          body.streamMappings.push({
            course: 'Engineering',
            branch: streamCode,
            stream: streamCode,
            semester: body.semester,
          });
        }
      } else {
        body.branch = branch || body.stream || 'CSE';
        body.stream = body.branch;
        body.targetBranches = [body.branch];
      }
    }

    if (title) {
      const candidateTitle = String(title).trim();
      const existing = await ClassTest.findOne({
        title: new RegExp(`^${candidateTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
        ...(body.course ? { course: new RegExp(`^${String(body.course).trim()}$`, 'i') } : {})
      });
      if (existing) {
        const isSameId =
          (body.id && String(existing.id) === String(body.id)) ||
          (body.testId && String(existing.testId) === String(body.testId));
        if (isSameId) {
          const updated = await ClassTest.findByIdAndUpdate(existing._id, { $set: body }, { new: true });
          return res.status(200).json({ success: true, data: updated });
        }
        return res.status(409).json({
          success: false,
          message: 'A test with this name already exists. Please use a unique title.'
        });
      }
    }
    const test = new ClassTest(body);
    await test.save();

    // Automatic Real-Time Targeted Notification for Students
    try {
      const notifId = `notif_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
      await Notification.create({
        id: notifId,
        title: 'New Class Test Published',
        message: `"${test.title}" is now live for ${test.branch || 'All Batches'} (${test.semester || 'All Semesters'}).`,
        type: 'classtest',
        course: test.course,
        branch: test.branch,
        targetBranches: test.targetBranches,
        semester: test.semester,
        classLevel: test.classLevel,
        subject: test.subject,
        contentId: test.id || test.testId || String(test._id),
      });
      console.log(`📢 [REAL-TIME NOTIFICATION DISPATCHED]: New Class Test Published: "${test.title}"`);
    } catch (notifErr) {
      console.warn('Auto notification generation notice in createTest:', notifErr.message);
    }

    res.status(201).json({ success: true, data: test });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

exports.getTests = async (req, res) => {
  try {
    const { stream, semester, branch, course, board, classLevel, class_name, className, subject, academicYear, academic_year } = req.query;
    const rawCourse = String(course || board || stream || '').trim().toLowerCase();
    const isIcse = rawCourse.includes('icse') || rawCourse.includes('isc') || (board && /icse/i.test(String(board)));
    const isCbse = !isIcse && (rawCourse.includes('cbse') || rawCourse.includes('school') || (board && /cbse/i.test(String(board))) ||
      (classLevel && /class/i.test(String(classLevel))) ||
      (req.query.class && /class/i.test(String(req.query.class))) ||
      (class_name && /class/i.test(String(class_name))) ||
      (className && /class/i.test(String(className))));
    const isSchool = isIcse || isCbse;

    let query = {};

    if (isSchool) {
      const activeClass =
        classLevel ||
        req.query.class ||
        class_name ||
        className ||
        (semester && /class|9|10|11|12/i.test(String(semester)) ? semester : null);
      const numLevel = activeClass ? String(activeClass).replace(/[^0-9]/g, '') : '';
      const numVal = numLevel ? Number(numLevel) : null;
      const targetBoard = isIcse ? 'icse' : 'cbse';
      const boardRegex = targetBoard === 'icse' ? /^icse$/i : /^cbse$/i;

      const schoolConditions = [
        { board: boardRegex },
        { course: boardRegex },
        { stream: boardRegex }
      ];

      const classConditions = [];
      if (activeClass) {
        classConditions.push(
          { classLevel: new RegExp(`^${activeClass}$`, 'i') },
          { class: new RegExp(`^${activeClass}$`, 'i') },
          { class_name: new RegExp(`^${activeClass}$`, 'i') },
          { className: new RegExp(`^${activeClass}$`, 'i') },
          { semester: new RegExp(`^${activeClass}$`, 'i') },
          { classLevel: /all/i },
          { class: /all/i },
          { semester: /all/i }
        );
        if (numVal !== null) {
          classConditions.push(
            { classLevel: numVal },
            { class: numVal },
            { class_name: numVal },
            { className: numVal },
            { semester: numVal },
            { classNumber: numVal },
            { classLevel: numLevel },
            { class: numLevel },
            { class_name: numLevel },
            { className: numLevel },
            { semester: numLevel },
            { classLevel: new RegExp(`(^|\\b|class\\s*)${numLevel}(th)?($|\\b)`, 'i') },
            { class: new RegExp(`(^|\\b|class\\s*)${numLevel}(th)?($|\\b)`, 'i') },
            { class_name: new RegExp(`(^|\\b|class\\s*)${numLevel}(th)?($|\\b)`, 'i') },
            { className: new RegExp(`(^|\\b|class\\s*)${numLevel}(th)?($|\\b)`, 'i') },
            { semester: new RegExp(`(^|\\b|class\\s*)${numLevel}(th)?($|\\b)`, 'i') }
          );
        }
      }

      const subjectConditions = [];
      const activeSub = subject || 'Mathematics';
      if (activeSub) {
        subjectConditions.push(
          { subject: new RegExp(`^${activeSub}$`, 'i') },
          { subject: /all/i }
        );
        if (/math/i.test(activeSub) || /^both$/i.test(activeSub)) {
          subjectConditions.push(
            { subject: /math/i },
            { subject: /both/i }
          );
        }
      }

      const schoolAndClauses = [{ $or: schoolConditions }];
      if (classConditions.length > 0) schoolAndClauses.push({ $or: classConditions });
      if (subjectConditions.length > 0) schoolAndClauses.push({ $or: subjectConditions });

      query.$and = schoolAndClauses;

    } else {
      const andClauses = [];
      if (course) {
        if (/bsc|b\.sc|science/i.test(course)) {
          andClauses.push({ $or: [{ course: /bsc|b\.sc|science/i }, { stream: /bsc/i }] });
        } else if (/jee|iit/i.test(course)) {
          andClauses.push({ $or: [{ course: /jee|iit/i }, { stream: /jee/i }] });
        } else {
          andClauses.push({
            $or: [
              { course: /engineering|btech|b\.tech|makaut|^all$/i },
              { board: /engineering/i },
              { isCommon: true },
              { targetScope: 'engineering_first_year_common' },
              { course: null },
              { course: { $exists: false } }
            ]
          });
          andClauses.push({ board: { $nin: [/^cbse$/i, /^icse$/i] } });
        }
      }

      const targetBranch = branch || stream;
      if (targetBranch) {
        if (course === 'bsc') {
          const isHonours = /honour|major/i.test(targetBranch);
          andClauses.push({
            $or: [
              { branch: isHonours ? /honour|major/i : /general|pass/i },
              { stream: isHonours ? /honour|major/i : /general|pass/i }
            ]
          });
        } else if (course === 'jee') {
          // Unified JEE matches all JEE tests
        } else {
          const b = targetBranch.trim();
          const branchConditions = [
            new RegExp(`^${b}$`, 'i'),
            /common/i,
            /^all/i,
            /unified/i
          ];
          if (/cse|computer/i.test(b)) {
            branchConditions.push(/cse|computer|comp/i);
          } else if (/it|information/i.test(b)) {
            branchConditions.push(/it|information|info/i);
          } else if (/ece|electronic/i.test(b)) {
            branchConditions.push(/ece|electronic|comm/i);
          } else if (/ee|electrical/i.test(b)) {
            branchConditions.push(/ee|electrical/i);
          } else if (/me|mech/i.test(b)) {
            branchConditions.push(/me|mech/i);
          } else if (/ce|civil/i.test(b)) {
            branchConditions.push(/ce|civil/i);
          } else if (/ai|ds|data/i.test(b)) {
            branchConditions.push(/ai|ds|data/i);
          }
          andClauses.push({
            $or: [
              ...branchConditions.map(r => ({ branch: r })),
              ...branchConditions.map(r => ({ stream: r })),
              ...branchConditions.map(r => ({ targetBranches: r })),
              { isCommonFirstYear: true },
              { isCommon: true },
              { targetScope: 'engineering_first_year_common' }
            ]
          });
        }
      }

      if (semester !== undefined && semester !== null && semester !== '') {
        const cleanSem = String(semester).replace(/[^0-9]/g, '');
        const semNum = Number(cleanSem);
        const semConditions = [
          { semester: cleanSem },
          { semester: String(semester) },
          { semester: new RegExp(`^${String(semester)}$`, 'i') },
          { semester: /all/i },
          { semester: null },
          { semester: { $exists: false } }
        ];
        if (!isNaN(semNum) && semNum > 0) {
          semConditions.push({ semester: semNum });
          semConditions.push({ semester: `Semester ${semNum}` });
          semConditions.push({ semester: new RegExp(`semester\\s*0*${semNum}(\\b|$)`, 'i') });
        }
        if (semNum === 1 || semNum === 2) {
          semConditions.push({ branch: /common/i });
          semConditions.push({ isCommonFirstYear: true });
          semConditions.push({ isCommon: true });
          semConditions.push({ targetScope: 'engineering_first_year_common' });
        }
        andClauses.push({ $or: semConditions });
      }

      if (classLevel && course !== 'jee') {
        const numLevel = String(classLevel).replace(/[^0-9]/g, '');
        if (numLevel) {
          andClauses.push({ classLevel: new RegExp(`${numLevel}`, 'i') });
        } else {
          andClauses.push({ classLevel: new RegExp(`^${classLevel}$`, 'i') });
        }
      }

      if (subject && course !== 'jee') {
        if (/math/i.test(subject)) {
          andClauses.push({ subject: /math/i });
        } else {
          andClauses.push({ subject: new RegExp(`^${subject}$`, 'i') });
        }
      }

      if (andClauses.length > 0) {
        query.$and = andClauses;
      }
    }

    const allowDrafts = Boolean(req.query.includeDrafts === 'true' && isAuthorizedAdmin(req));
    const draftConditions = [];
    if (req.query.status) {
      const qStatus = String(req.query.status).trim().toLowerCase();
      if (qStatus === 'draft') {
        if (!allowDrafts) {
          draftConditions.push({ _id: null }); // block unauthorized draft requests
        } else {
          draftConditions.push({ $or: [{ status: 'draft' }, { isDraft: true }] });
        }
      } else {
        draftConditions.push({ status: req.query.status, isDraft: { $ne: true } });
      }
    } else if (!allowDrafts) {
      draftConditions.push({
        status: { $ne: 'draft' },
        isDraft: { $ne: true }
      });
    }

    if (draftConditions.length > 0) {
      if (query.$and && Array.isArray(query.$and)) {
        query.$and.push(...draftConditions);
      } else {
        query.$and = draftConditions;
      }
    }

    const [classTests, contentTests] = await Promise.all([
      ClassTest.find(query).sort({ examDate: -1, createdAt: -1 }).catch(() => []),
      Content.find({
        ...query,
        type: { $in: ['classtest', 'classtests', 'test'] }
      }).sort({ examDate: -1, createdAt: -1 }).catch(() => [])
    ]);

    // Deduplicate combined test records by title and id
    const seen = new Set();
    const mergedTests = [];

    [...classTests, ...contentTests].forEach(t => {
      const normTitle = String(t.title || '').trim().toLowerCase();
      const testId = String(t.testId || t.id || t._id || normTitle);
      if (!seen.has(normTitle) && !seen.has(testId)) {
        seen.add(normTitle);
        seen.add(testId);
        mergedTests.push(t);
      }
    });

    const isAdmin = isAuthorizedAdmin(req);
    const sanitizedTests = mergedTests.map(t => {
      const doc = t.toObject ? t.toObject() : { ...t };
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

    res.status(200).json({ success: true, data: sanitizedTests });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

exports.getTestById = async (req, res) => {
  try {
    const targetId = req.params.id;
    const orConditions = [{ id: targetId }, { testId: targetId }];
    if (mongoose.Types.ObjectId.isValid(targetId)) {
      orConditions.push({ _id: targetId });
    }
    const query = { $or: orConditions };
    let test = await ClassTest.findOne(query);
    if (!test) {
      test = await Content.findOne({ ...query, type: { $in: ['classtest', 'classtests', 'test'] } });
    }
    if (!test) {
      return res.status(404).json({ success: false, message: 'Test not found' });
    }
    const isDraft = test.status === 'draft' || test.isDraft === true;
    const isAdmin = isAuthorizedAdmin(req);
    if (isDraft && !isAdmin) {
      return res.status(404).json({ success: false, message: 'Test not found or currently unavailable' });
    }

    const doc = test.toObject ? test.toObject() : { ...test };
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

    res.status(200).json({ success: true, data: doc });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

exports.submitAndEvaluate = async (req, res) => {
  try {
    const {
      testId,
      answerSheetUrl,
      cheatDetected,
      strikes = 0,
      submittedDueToViolation = false,
      violationReason = '',
      answers = [],
      isOnlineTest = false,
      score,
      totalMarks = 50,
      studentName,
      studentEmail,
    } = req.body;

    const studentId = req.user ? req.user.id : (req.body.studentId || '000000000000000000000000');

    // Reject submissions against draft tests
    const testDoc = await ClassTest.findOne({ $or: [{ id: testId }, { testId }, ...(mongoose.Types.ObjectId.isValid(testId) ? [{ _id: testId }] : [])] })
      || await Content.findOne({ $or: [{ id: testId }, { testId }, ...(mongoose.Types.ObjectId.isValid(testId) ? [{ _id: testId }] : [])] });
    if (testDoc && (testDoc.status === 'draft' || testDoc.isDraft === true)) {
      return res.status(400).json({ success: false, message: 'Cannot submit to an unpublished draft test.' });
    }
    const isDisqualified = cheatDetected || submittedDueToViolation || strikes >= 3;

    // 1. Save initial submission
    const submission = new TestSubmission({
      test: testId,
      student: studentId,
      answerSheetUrl: answerSheetUrl || '',
      cheatDetected: isDisqualified,
      strikes,
      submittedDueToViolation: isDisqualified,
      violationReason: isDisqualified ? (violationReason || 'Anti-cheat protocol violation: 3 strikes exceeded / focus lost.') : null,
      answers,
      isOnlineTest: Boolean(isOnlineTest),
      studentName,
      studentEmail,
      status: isDisqualified ? 'disqualified' : (isOnlineTest ? 'evaluated' : 'evaluating'),
      aiEvaluation: isOnlineTest ? {
        marksAwarded: isDisqualified ? 0 : (typeof score === 'number' ? score : 0),
        totalMarks: totalMarks,
        feedback: isDisqualified
          ? `Disqualified: Anti-cheat protocol violation detected (${strikes} strikes recorded). Test locked with zero marks.`
          : 'Online exam auto-evaluated successfully.',
        mistakes: isDisqualified ? ['Strict violation of online examination integrity.'] : [],
        evaluatedAt: new Date()
      } : undefined
    });
    await submission.save();

    // 2. Handwritten uploads remain pending teacher review or genuine AI OCR evaluation
    if (!isOnlineTest && !isDisqualified) {
      submission.status = 'submitted';
      await submission.save();
    }

    res.status(200).json({ 
      success: true, 
      message: isDisqualified 
        ? 'Test auto-submitted and locked due to anti-cheat violation.' 
        : 'Test submitted successfully.', 
      submissionId: submission._id,
      isDisqualified,
      submission
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

// @desc    Delete a class test permanently
// @route   DELETE /api/tests/:id
// @access  Public
exports.deleteTest = async (req, res) => {
  try {
    const targetId = req.params.id;
    if (!targetId) {
      return res.status(400).json({ success: false, message: 'Test ID is required' });
    }

    const deleteOr = [{ id: targetId }, { testId: targetId }];
    if (mongoose.Types.ObjectId.isValid(targetId)) {
      deleteOr.push({ _id: new mongoose.Types.ObjectId(targetId) });
    }
    const idQuery = { $or: deleteOr };

    const [classTestItem, contentItem] = await Promise.all([
      ClassTest.findOne(idQuery).catch(() => null),
      Content.findOne(idQuery).catch(() => null)
    ]);

    const allIds = new Set([targetId]);
    const allTitles = new Set();
    const allTestIds = new Set([targetId]);

    if (classTestItem) {
      if (classTestItem.id) allIds.add(String(classTestItem.id));
      if (classTestItem._id) allIds.add(String(classTestItem._id));
      if (classTestItem.testId) allTestIds.add(String(classTestItem.testId));
      if (classTestItem.title) allTitles.add(String(classTestItem.title));
    }

    if (contentItem) {
      if (contentItem.id) allIds.add(String(contentItem.id));
      if (contentItem._id) allIds.add(String(contentItem._id));
      if (contentItem.testId) allTestIds.add(String(contentItem.testId));
      if (contentItem.title) allTitles.add(String(contentItem.title));
    }

    const finalOr = [];
    allIds.forEach(idVal => {
      finalOr.push({ id: idVal });
      if (mongoose.Types.ObjectId.isValid(idVal)) {
        finalOr.push({ _id: new mongoose.Types.ObjectId(idVal) });
      }
    });
    allTestIds.forEach(tId => {
      finalOr.push({ testId: tId });
    });
    allTitles.forEach(t => {
      finalOr.push({ title: t });
    });

    const finalFilter = { $or: finalOr };

    // Execute permanent deletion on MongoDB Atlas
    const [delTest, delContent] = await Promise.all([
      ClassTest.deleteMany(finalFilter),
      Content.deleteMany(finalFilter),
      TestSubmission.deleteMany({
        $or: [
          { testId: { $in: Array.from(allTestIds).concat(Array.from(allIds)) } }
        ]
      }).catch(() => null),
      Notification.deleteMany({
        $or: [
          { contentId: { $in: Array.from(allIds) } },
          { title: { $in: Array.from(allTitles) } }
        ]
      }).catch(() => null)
    ]);

    res.json({
      success: true,
      message: 'Class test permanently deleted from MongoDB Atlas',
      deletedClassTests: delTest?.deletedCount || 0,
      deletedContent: delContent?.deletedCount || 0
    });
  } catch (err) {
    console.error('Delete test error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
};

// @desc    Clear all class tests permanently
// @route   DELETE /api/tests
// @access  Public
exports.clearAllTests = async (req, res) => {
  try {
    await Promise.all([
      ClassTest.deleteMany({}),
      Content.deleteMany({ type: { $in: ['classtest', 'classtests', 'test'] } }),
      TestSubmission.deleteMany({}),
      Notification.deleteMany({ type: { $in: ['test', 'classtest'] } }).catch(() => null)
    ]);
    res.json({ success: true, message: 'All class tests permanently cleared from MongoDB Atlas' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

// @desc    Purge dummy / debug tests and deduplicate twin copies
// @route   POST /api/tests/cleanup-dummy
// @access  Public
exports.cleanupDummyTests = async (req, res) => {
  try {
    const dummyPatterns = [
      /^test$/i,
      /^test\s*\d+$/i,
      /^test_for_final_exam/i,
      /final\s*(test|design\s*test)/i,
      /debug/i,
      /dummy/i,
      /sample\s*test/i,
      /demo\s*test/i,
      /^q\s*check$/i,
      /^path\s*check$/i,
      /^ff$/i,
      /^fr$/i,
      /^kaka$/i,
      /^hijibiji$/i,
      /^arnab$/i,
      /^ganesh$/i,
      /^pramila$/i,
      /^suman_test$/i
    ];

    const dummyQuery = {
      $or: [
        ...dummyPatterns.map(p => ({ title: p })),
        { title: { $exists: false } },
        { title: '' },
        { title: null }
      ]
    };

    // 1. Permanently delete all tests matching dummy/debug patterns
    const [matchingContent, matchingClassTests] = await Promise.all([
      Content.find({
        type: { $in: ['classtest', 'classtests', 'test'] },
        ...dummyQuery
      }).lean(),
      ClassTest.find(dummyQuery).lean()
    ]);

    const allDummyIds = new Set();
    const allDummyTitles = new Set();
    const allDummyTestIds = new Set();

    [...matchingContent, ...matchingClassTests].forEach(item => {
      if (item._id) allDummyIds.add(String(item._id));
      if (item.id) allDummyIds.add(String(item.id));
      if (item.testId) allDummyTestIds.add(String(item.testId));
      if (item.title) allDummyTitles.add(item.title);
    });

    let deletedDummyCount = 0;
    if (allDummyIds.size > 0 || allDummyTitles.size > 0) {
      const deleteFilter = {
        $or: [
          ...Array.from(allDummyIds).map(idVal => {
            const cond = [{ id: idVal }];
            if (mongoose.Types.ObjectId.isValid(idVal)) {
              cond.push({ _id: new mongoose.Types.ObjectId(idVal) });
            }
            return cond;
          }).flat(),
          ...Array.from(allDummyTestIds).map(tId => ({ testId: tId })),
          ...Array.from(allDummyTitles).map(t => ({ title: t }))
        ]
      };

      const [delC, delCT] = await Promise.all([
        Content.deleteMany(deleteFilter),
        ClassTest.deleteMany(deleteFilter),
        TestSubmission.deleteMany({
          $or: [
            { testId: { $in: Array.from(allDummyTestIds).concat(Array.from(allDummyIds)) } },
            { testTitle: { $in: Array.from(allDummyTitles) } }
          ]
        }).catch(() => null),
        Notification.deleteMany({
          $or: [
            { contentId: { $in: Array.from(allDummyIds) } },
            { title: { $in: Array.from(allDummyTitles) } }
          ]
        }).catch(() => null)
      ]);
      deletedDummyCount = (delC.deletedCount || 0) + (delCT.deletedCount || 0);
    }

    // 2. Twin / Duplicate Copy Deduplication on Remaining Verified Tests
    const remainingContentTests = await Content.find({
      type: { $in: ['classtest', 'classtests', 'test'] }
    }).sort({ createdAt: -1, uploadedAt: -1 });

    const seenTests = new Map();
    const duplicateIdsToDelete = [];

    remainingContentTests.forEach(testDoc => {
      const normTitle = String(testDoc.title || '').trim().toLowerCase();
      const groupKey = `${testDoc.course || ''}_${testDoc.semester || testDoc.classLevel || ''}_${normTitle}`;
      if (seenTests.has(groupKey)) {
        duplicateIdsToDelete.push(testDoc._id);
      } else {
        seenTests.set(groupKey, testDoc);
      }
    });

    if (duplicateIdsToDelete.length > 0) {
      await Content.deleteMany({ _id: { $in: duplicateIdsToDelete } });
    }

    const remainingClassTests = await ClassTest.find({}).sort({ createdAt: -1, examDate: -1 });
    const seenClassTests = new Map();
    const duplicateClassTestIdsToDelete = [];

    remainingClassTests.forEach(testDoc => {
      const normTitle = String(testDoc.title || '').trim().toLowerCase();
      const groupKey = `${testDoc.course || ''}_${testDoc.semester || testDoc.classLevel || ''}_${normTitle}`;
      if (seenClassTests.has(groupKey)) {
        duplicateClassTestIdsToDelete.push(testDoc._id);
      } else {
        seenClassTests.set(groupKey, testDoc);
      }
    });

    if (duplicateClassTestIdsToDelete.length > 0) {
      await ClassTest.deleteMany({ _id: { $in: duplicateClassTestIdsToDelete } });
    }

    const totalCleaned = deletedDummyCount + duplicateIdsToDelete.length + duplicateClassTestIdsToDelete.length;

    res.json({
      success: true,
      message: `Cleaned up ${totalCleaned} dummy and duplicate test entries from MongoDB Atlas.`,
      deletedDummyCount,
      deletedDuplicatesCount: duplicateIdsToDelete.length + duplicateClassTestIdsToDelete.length,
      cleanedTitles: Array.from(allDummyTitles)
    });
  } catch (err) {
    console.error('Error cleaning dummy tests:', err);
    res.status(500).json({ success: false, error: err.message });
  }
};

exports.getTestAnswerKey = async (req, res) => {
  try {
    const targetId = req.params.id;
    const orConditions = [{ id: targetId }, { testId: targetId }];
    if (mongoose.Types.ObjectId.isValid(targetId)) {
      orConditions.push({ _id: targetId });
    }
    const query = { $or: orConditions };
    let item = await ClassTest.findOne(query) || await Content.findOne(query);
    if (!item) {
      return res.status(404).json({ success: false, message: 'Test not found' });
    }

    const isAdmin = isAuthorizedAdmin(req);
    if (!isAdmin && item.publishedResults !== true) {
      return res.status(403).json({ success: false, message: 'Answer key is restricted to teachers until official results are published.' });
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
      success: true,
      testId: item.testId || item.id,
      title: item.title,
      marks: item.marks || item.fullMarks || 50,
      answerKey: answerKey || { questions: [], status: 'draft' },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

exports.updateTestAnswerKey = async (req, res) => {
  try {
    if (!isAuthorizedAdmin(req)) {
      return res.status(403).json({ success: false, message: 'Unauthorized: Teacher or admin credentials required to update answer keys.' });
    }

    const targetId = req.params.id;
    const incomingKey = req.body;

    const orConditions = [{ id: targetId }, { testId: targetId }];
    if (mongoose.Types.ObjectId.isValid(targetId)) {
      orConditions.push({ _id: targetId });
    }
    const query = { $or: orConditions };

    let item = await ClassTest.findOne(query) || await Content.findOne(query);
    if (!item) {
      return res.status(404).json({ success: false, message: 'Test not found' });
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
    }

    await item.save();

    res.json({ success: true, answerKey: item.answerKey, item });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};
