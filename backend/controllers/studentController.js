const Content = require('../models/Content');
const Assignment = require('../models/Assignment');
const Submission = require('../models/Submission');

// @desc    Get content based on student's stream, branch, course and semester
// @route   GET /api/student/content
// @access  Private/Student
const getStudentContent = async (req, res) => {
  try {
    const user = req.user || {};
    const stream = user.stream || user.branch;
    const branch = user.branch || user.stream;
    const semester = user.semester;
    const course = user.course;

    const query = {};
    if (course) {
      query.$or = [
        { course: new RegExp(`^${course}$`, 'i') },
        { course: null },
        { course: { $exists: false } },
        { course: '' }
      ];
    }

    const targetBranch = branch || stream;
    if (targetBranch) {
      const branchConditions = [
        new RegExp(`^${targetBranch}$`, 'i'),
        /common/i,
        /^all/i,
        /unified/i
      ];
      if (/cse|computer/i.test(targetBranch)) branchConditions.push(/cse|computer|comp/i);
      else if (/it|information/i.test(targetBranch)) branchConditions.push(/it|information|info/i);
      else if (/ece|electronic/i.test(targetBranch)) branchConditions.push(/ece|electronic|comm/i);
      else if (/ee|electrical/i.test(targetBranch)) branchConditions.push(/ee|electrical/i);
      else if (/me|mech/i.test(targetBranch)) branchConditions.push(/me|mech/i);
      else if (/ce|civil/i.test(targetBranch)) branchConditions.push(/ce|civil/i);

      const branchClauses = [
        ...branchConditions.map(r => ({ branch: r })),
        ...branchConditions.map(r => ({ stream: r })),
        { isCommonFirstYear: true }
      ];

      if (query.$or) {
        query.$and = [{ $or: query.$or }, { $or: branchClauses }];
        delete query.$or;
      } else {
        query.$or = branchClauses;
      }
    }

    if (semester !== undefined && semester !== null && semester !== '') {
      const cleanSem = String(semester).replace(/[^0-9]/g, '');
      const semConditions = [
        { semester: cleanSem },
        { semester: Number(cleanSem) },
        { semester: /all/i },
        { semester: null },
        { semester: { $exists: false } }
      ];
      if (Number(cleanSem) === 1 || Number(cleanSem) === 2) {
        semConditions.push({ branch: /common/i });
        semConditions.push({ isCommonFirstYear: true });
      }

      if (query.$and) {
        query.$and.push({ $or: semConditions });
      } else if (query.$or) {
        query.$and = [{ $or: query.$or }, { $or: semConditions }];
        delete query.$or;
      } else {
        query.$or = semConditions;
      }
    }

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
    const stream = user.stream || user.branch;
    const branch = user.branch || user.stream;
    const semester = user.semester;

    const [assignments, contentAssignments] = await Promise.all([
      Assignment.find({ $or: [{ stream }, { stream: branch }, { branch }] }).sort({ createdAt: -1 }).catch(() => []),
      Content.find({
        type: { $in: ['assignment', 'assignments'] },
        $or: [
          { branch: new RegExp(`^${branch || stream}$`, 'i') },
          { stream: new RegExp(`^${stream || branch}$`, 'i') },
          { branch: /common/i },
          { isCommonFirstYear: true }
        ]
      }).sort({ uploadedAt: -1 }).catch(() => [])
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
