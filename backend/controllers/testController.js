const mongoose = require('mongoose');
const ClassTest = require('../models/ClassTest');
const Content = require('../models/Content');
const TestSubmission = require('../models/TestSubmission');

exports.createTest = async (req, res) => {
  try {
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
