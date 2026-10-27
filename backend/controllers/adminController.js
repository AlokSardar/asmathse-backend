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
  const { title, type, stream: rawStream, branch: rawBranch, semester: rawSemester, course: rawCourse, board: rawBoard, classLevel: rawClassLevel, class: rawClass, subject: rawSubject, academicYear, fileUrl } = req.body;
  try {
    const rawC = String(rawCourse || rawBoard || rawStream || '').trim().toLowerCase();
    const rawCl = rawClassLevel || rawClass || req.body.class_name || req.body.className;
    
    let course = 'engineering';
    let board = rawBoard || null;
    let isIcse = rawC.includes('icse') || rawC.includes('isc') || (rawBoard && /icse/i.test(rawBoard));
    let isCbse = !isIcse && (rawC.includes('cbse') || rawC.includes('school') || (rawBoard && /cbse/i.test(rawBoard)) || (rawCl && /class/i.test(rawCl)));
    let isSchool = isIcse || isCbse || (rawCl && /class/i.test(rawCl));
    let isJee = !isSchool && (rawC.includes('jee') || rawC.includes('iit'));
    let isBsc = !isSchool && !isJee && (rawC.includes('bsc') || rawC.includes('science'));
    let isEng = !isSchool && !isJee && !isBsc;

    if (isIcse) {
      course = 'icse';
      board = rawBoard || 'ICSE';
    } else if (isCbse || isSchool) {
      course = 'cbse';
      board = rawBoard || 'CBSE';
      isCbse = true;
    } else if (isJee) {
      course = 'jee';
      isJee = true;
    } else if (isBsc) {
      course = 'bsc';
      isBsc = true;
    } else {
      course = 'engineering';
      isEng = true;
    }

    let branch = null;
    let stream = null;
    let semester = null;
    let classLevel = null;
    let targetClass = null;
    let subject = rawSubject || (isSchool ? 'Mathematics' : (isJee ? 'JEE Mathematics' : 'Engineering Mathematics'));
    let isCommon = false;

    if (isSchool) {
      branch = null;
      stream = board;
      semester = null;
      classLevel = rawClassLevel || rawClass || req.body.class_name || req.body.className || 'Class 9';
      targetClass = classLevel;
      subject = rawSubject || 'Mathematics';
      isCommon = false;
    } else if (isJee) {
      branch = rawBranch || 'JEE';
      stream = 'JEE';
      semester = null;
      classLevel = rawClassLevel || rawClass || req.body.class_name || req.body.className || 'JEE Mains & Advanced';
      targetClass = classLevel;
      subject = rawSubject || 'JEE Mathematics';
      isCommon = false;
    } else if (isBsc) {
      branch = rawBranch || rawStream || 'BSc (Honours) (Major)';
      stream = branch;
      semester = rawSemester !== undefined && rawSemester !== null && rawSemester !== '' ? rawSemester : 1;
      classLevel = null;
      targetClass = null;
      subject = rawSubject || 'Mathematics';
      isCommon = false;
    } else {
      branch = rawBranch || rawStream || 'CSE';
      stream = rawStream || rawBranch || 'CSE';
      semester = rawSemester !== undefined && rawSemester !== null && rawSemester !== '' ? rawSemester : 1;
      classLevel = null;
      targetClass = null;
      subject = rawSubject || 'Engineering Mathematics';
      isCommon = Boolean(
        (branch && /common/i.test(branch)) ||
        (stream && /common/i.test(stream)) ||
        (Number(semester) <= 2 && (/common/i.test(branch || '') || /common/i.test(stream || '')))
      );
    }

    const cleanNum = classLevel ? String(classLevel).replace(/[^0-9]/g, '') : '';
    const classNum = cleanNum ? Number(cleanNum) : null;

    const content = await Content.create({
      title,
      type: type || 'materials',
      board,
      course,
      stream,
      branch,
      semester,
      classLevel,
      class: targetClass,
      class_name: targetClass,
      className: targetClass,
      classNumber: classNum,
      subject,
      academicYear: academicYear || '2026-2027',
      isCommonFirstYear: isCommon,
      fileUrl,
      uploadedBy: req.user ? req.user.id : 'admin'
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
    const isNum = !isNaN(Number(semester));
    const query = { role: 'student' };
    if (/cbse|icse|school/i.test(stream) || !isNum) {
      query.$or = [
        { stream: new RegExp(`^${stream}$`, 'i') },
        { board: new RegExp(`^${stream}$`, 'i') },
        { targetCourse: new RegExp(`^${stream}$`, 'i') },
        { course: new RegExp(`^${stream}$`, 'i') }
      ];
      if (semester && semester !== 'all') {
        query.$and = [{
          $or: [
            { classLevel: new RegExp(`^${semester}$`, 'i') },
            { class: new RegExp(`^${semester}$`, 'i') },
            { class_name: new RegExp(`^${semester}$`, 'i') },
            { className: new RegExp(`^${semester}$`, 'i') },
            { semester: semester }
          ]
        }];
      }
    } else {
      query.stream = new RegExp(`^${stream}$`, 'i');
      query.semester = Number(semester);
    }
    const students = await User.find(query).select('-password');
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
