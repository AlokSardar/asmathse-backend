const mongoose = require('mongoose');
const ClassTest = require('../models/ClassTest');
const Content = require('../models/Content');
const TestSubmission = require('../models/TestSubmission');
const Notification = require('../models/Notification');

exports.createTest = async (req, res) => {
  try {
    const { title, course, semester, classLevel } = req.body;
    if (title) {
      const candidateTitle = String(title).trim();
      const existing = await ClassTest.findOne({
        title: new RegExp(`^${candidateTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
        ...(course ? { course: new RegExp(`^${String(course).trim()}$`, 'i') } : {})
      });
      if (existing) {
        return res.status(409).json({
          success: false,
          message: 'A test with this name already exists. Please use a unique title.'
        });
      }
    }
    const test = new ClassTest(req.body);
    await test.save();
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
      const activeClass = classLevel || req.query.class || class_name || className;
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
          { classLevel: /all/i },
          { class: /all/i }
        );
        if (numVal !== null) {
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

    res.status(200).json({ success: true, data: mergedTests });
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
    res.status(200).json({ success: true, data: test });
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

    // 2. Mock AI Evaluation Process for handwritten uploads (strictly bypass for disqualified tests)
    if (!isOnlineTest && !isDisqualified) {
      setTimeout(async () => {
        try {
          const aiEvaluatedSubmission = await TestSubmission.findById(submission._id);
          if (aiEvaluatedSubmission) {
            aiEvaluatedSubmission.aiEvaluation = {
              marksAwarded: isDisqualified ? 0 : Math.floor(Math.random() * 15) + 35, // 35-50 marks
              totalMarks: 50,
              feedback: isDisqualified
                ? "Zero marks awarded. Anti-cheat protocol violation detected (Tab switched or window lost focus 3 times)."
                : "Excellent problem-solving approach. The steps in the calculus section were logically sound.",
              mistakes: isDisqualified
                ? ["Strict violation of exam integrity."]
                : ["Minor calculation error in Q3 part (b).", "Forgot to add constant of integration 'C' in Q4."],
              evaluatedAt: new Date()
            };
            aiEvaluatedSubmission.status = 'evaluated';
            await aiEvaluatedSubmission.save();
          }
        } catch (err) {
          console.error("AI Evaluation failed:", err);
        }
      }, 4000);
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
