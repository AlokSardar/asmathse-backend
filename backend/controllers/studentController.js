const Content = require('../models/Content');
const Assignment = require('../models/Assignment');
const Submission = require('../models/Submission');

// @desc    Get content based on student's stream and semester
// @route   GET /api/student/content
// @access  Private/Student
const getStudentContent = async (req, res) => {
  try {
    const { stream, semester } = req.user; // Retrieved from auth middleware
    const contents = await Content.find({ stream, semester });
    res.json(contents);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get assignments for the student
// @route   GET /api/student/assignments
// @access  Private/Student
const getStudentAssignments = async (req, res) => {
  try {
    const { stream, semester } = req.user;
    const assignments = await Assignment.find({ stream, semester });
    res.json(assignments);
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
