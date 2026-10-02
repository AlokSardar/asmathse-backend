const ClassTest = require('../models/ClassTest');
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
    const { stream, semester, branch, course, classLevel, subject } = req.query;
    const query = {};

    if (course) {
      query.course = new RegExp(`^${course}$`, 'i');
    }

    if (branch) {
      if (course === 'bsc') {
        const isHonours = /honour|major/i.test(branch);
        query.branch = isHonours ? /honour|major/i : /general|pass/i;
      } else if (course === 'jee') {
        // Unified JEE matches all JEE tests
      } else {
        query.branch = new RegExp(`^${branch}$`, 'i');
      }
    } else if (stream) {
      query.$or = [{ stream }, { course: stream }, { branch: stream }];
    }

    if (semester !== undefined && semester !== null && semester !== '') {
      query.semester = { $in: [Number(semester), String(semester)] };
    }

    if (classLevel && course !== 'jee') {
      query.classLevel = new RegExp(`^${classLevel}$`, 'i');
    }

    if (subject && course !== 'jee') {
      query.subject = new RegExp(`^${subject}$`, 'i');
    }
    
    const tests = await ClassTest.find(query).sort({ examDate: -1, createdAt: -1 });
    res.status(200).json({ success: true, data: tests });
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
      status: isOnlineTest ? 'evaluated' : 'evaluating',
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

    // 2. Mock AI Evaluation Process for handwritten uploads
    if (!isOnlineTest) {
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
