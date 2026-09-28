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
    const { stream, semester } = req.query;
    const query = {};
    if (stream) query.stream = stream;
    if (semester) query.semester = semester;
    
    const tests = await ClassTest.find(query);
    res.status(200).json({ success: true, data: tests });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

exports.submitAndEvaluate = async (req, res) => {
  try {
    const { testId, answerSheetUrl, cheatDetected } = req.body;
    // Fallback to a mock student ID if req.user is not set by auth middleware yet during frontend testing
    const studentId = req.user ? req.user.id : '000000000000000000000000'; 

    // 1. Save initial submission
    const submission = new TestSubmission({
      test: testId,
      student: studentId,
      answerSheetUrl,
      cheatDetected,
      status: 'evaluating'
    });
    await submission.save();

    // 2. Mock AI Evaluation Process (Simulates Gemini API integration)
    setTimeout(async () => {
      try {
        const aiEvaluatedSubmission = await TestSubmission.findById(submission._id);
        if(aiEvaluatedSubmission) {
          aiEvaluatedSubmission.aiEvaluation = {
            marksAwarded: cheatDetected ? 0 : Math.floor(Math.random() * 15) + 35, // 35-50 marks
            totalMarks: 50,
            feedback: cheatDetected
              ? "Zero marks awarded. Anti-cheat protocol violation detected (Tab switched or window lost focus)."
              : "Excellent problem-solving approach. The steps in the calculus section were logically sound.",
            mistakes: cheatDetected
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
    }, 4000); // 4-second delay to simulate AI processing

    res.status(200).json({ 
      success: true, 
      message: 'Test submitted successfully and sent to AI for evaluation.', 
      submissionId: submission._id 
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};
