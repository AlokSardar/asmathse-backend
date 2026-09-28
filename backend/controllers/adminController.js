const Content = require('../models/Content');
const Assignment = require('../models/Assignment');
const Submission = require('../models/Submission');
const User = require('../models/User');
const Student = require('../models/Student');
const Evaluation = require('../models/Evaluation');

// @desc    Upload new content (Syllabus, PYQ, Solution, Suggestion)
// @route   POST /api/admin/content
// @access  Private/Admin
const uploadContent = async (req, res) => {
  const { title, type, stream, semester, fileUrl } = req.body;
  try {
    const content = await Content.create({
      title,
      type,
      stream,
      semester,
      fileUrl,
      uploadedBy: req.user.id
    });
    res.status(201).json(content);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Create a new assignment
// @route   POST /api/admin/assignments
// @access  Private/Admin
const createAssignment = async (req, res) => {
  const { title, description, stream, semester, questionFileUrl, deadline } = req.body;
  try {
    const assignment = await Assignment.create({
      title,
      description,
      stream,
      semester,
      questionFileUrl,
      deadline,
      createdBy: req.user.id
    });
    res.status(201).json(assignment);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get all students in a specific stream and semester
// @route   GET /api/admin/students/:stream/:semester
// @access  Private/Admin
const getStudents = async (req, res) => {
  const { stream, semester } = req.params;
  try {
    // Include WhatsApp numbers so Admin can message them
    const students = await User.find({ role: 'student', stream, semester: Number(semester) })
                               .select('-password');
    res.json(students);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Evaluate submission and assign marks
// @route   PUT /api/admin/submissions/:id
// @access  Private/Admin
const evaluateSubmission = async (req, res) => {
  const { marksObtained, adminFeedback } = req.body;
  try {
    const submission = await Submission.findById(req.params.id);
    if (!submission) {
      return res.status(404).json({ message: 'Submission not found' });
    }
    submission.status = 'checked';
    submission.marksObtained = marksObtained;
    submission.adminFeedback = adminFeedback;
    await submission.save();
    res.json(submission);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get complete Academic Year Overview & Workspace Data
// @route   GET /api/admin/academic-year-overview
// @access  Public / Admin
const getAcademicYearOverview = async (req, res) => {
  try {
    const requestedYear = req.query.year; // e.g. '2026-2027' or null for all years summary

    // 1. Fetch all students
    const allUsers = await User.find({ role: 'student' }).select('-password').sort({ createdAt: -1 });
    const dedicatedStudents = await Student.find({}).sort({ registrationDate: -1 });

    // Deduplicate students by email
    const studentMap = new Map();
    dedicatedStudents.forEach(s => {
      if (s.email) studentMap.set(s.email.toLowerCase(), s.toObject());
    });
    allUsers.forEach(u => {
      if (u.email && !studentMap.has(u.email.toLowerCase())) {
        studentMap.set(u.email.toLowerCase(), u.toObject());
      }
    });
    const consolidatedStudents = Array.from(studentMap.values());

    // 2. Fetch all content uploads
    const allContents = await Content.find({}).sort({ uploadedAt: -1, createdAt: -1 });

    // 3. Fetch all AI evaluations
    const allEvaluations = await Evaluation.find({}).sort({ submittedAt: -1, createdAt: -1 });

    // Generate list of active academic years
    const activeYears = Array.from({ length: 11 }, (_, i) => `${2026 + i}-${2027 + i}`);

    // Compute metrics for each academic year
    const yearsSummary = activeYears.map(year => {
      const studentsForYear = consolidatedStudents.filter(s => {
        return (s.academicYear === year) || (!s.academicYear && year === '2026-2027');
      });

      const contentForYear = allContents.filter(c => {
        return (c.academicYear === year) || (!c.academicYear && year === '2026-2027');
      });

      const evalsForYear = allEvaluations.filter(e => {
        return (e.academicYear === year) || (!e.academicYear && year === '2026-2027');
      });

      let totalScoreSum = 0;
      let validScoreCount = 0;
      let highestScore = 0;
      let passCount = 0;

      evalsForYear.forEach(ev => {
        const sc = parseFloat(ev.score || ev.marks || 0);
        if (!isNaN(sc) && sc > 0) {
          totalScoreSum += sc;
          validScoreCount++;
          if (sc > highestScore) highestScore = sc;
          if (sc >= 40) passCount++;
        }
      });

      const avgScore = validScoreCount > 0 ? (totalScoreSum / validScoreCount).toFixed(1) : 'N/A';
      const passRate = validScoreCount > 0 ? Math.round((passCount / validScoreCount) * 100) : 0;

      const streamCounts = {
        engineering: studentsForYear.filter(s => (s.stream || '').toLowerCase().includes('eng')).length,
        bsc: studentsForYear.filter(s => (s.stream || '').toLowerCase().includes('bsc')).length,
        cbse: studentsForYear.filter(s => (s.stream || '').toLowerCase().includes('cbse')).length,
        jee: studentsForYear.filter(s => (s.stream || '').toLowerCase().includes('jee')).length,
      };

      return {
        year,
        studentCount: studentsForYear.length,
        contentCount: contentForYear.length,
        evalCount: evalsForYear.length,
        avgScore,
        highestScore: validScoreCount > 0 ? highestScore : 0,
        passRate: validScoreCount > 0 ? `${passRate}%` : 'N/A',
        streamCounts,
      };
    });

    let specificYearData = null;
    if (requestedYear) {
      const year = requestedYear;
      const students = consolidatedStudents.filter(s => (s.academicYear === year) || (!s.academicYear && year === '2026-2027'));
      const contents = allContents.filter(c => (c.academicYear === year) || (!c.academicYear && year === '2026-2027'));
      const evals = allEvaluations.filter(e => (e.academicYear === year) || (!e.academicYear && year === '2026-2027'));

      specificYearData = {
        year,
        students,
        contents,
        evaluations: evals,
      };
    }

    res.json({
      activeYears,
      yearsSummary,
      specificYearData,
    });
  } catch (error) {
    console.error('Error fetching academic year overview:', error);
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  uploadContent,
  createAssignment,
  getStudents,
  evaluateSubmission,
  getAcademicYearOverview,
};
