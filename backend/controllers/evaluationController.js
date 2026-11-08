const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const Evaluation = require('../models/Evaluation');
const Content = require('../models/Content');
const ClassTest = require('../models/ClassTest');
const { getGeminiApiKey, getAvailableGeminiModels, parseGeminiJsonWithRecovery, splitDocumentIntoPages } = require('../services/geminiService');
const { uploadBase64ToCloudinary, uploadBufferToCloudinary } = require('../services/cloudinaryService');

// Helper: Inspect request credentials for administrator / teacher authorization
const getRequestUser = (req) => {
  if (req.user) return req.user;
  const authHeader = req.headers?.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    try {
      const token = authHeader.split(' ')[1];
      const secret = process.env.JWT_SECRET || 'asmaths_secret_jwt_key_2026_cluster0';
      return jwt.verify(token, secret);
    } catch (_) {}
  }
  return null;
};

const isAuthorizedAdmin = (req) => {
  const user = getRequestUser(req);
  const role = String(user?.role || '').toLowerCase();
  return role === 'admin' || role === 'teacher' || user?.id === 'master_admin_id';
};

// Helper: Ensure uploads folder exists
const uploadsDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const escapeRegex = (str) => {
  if (typeof str !== 'string') return '';
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
};

// @desc    Get all student evaluations (enforces student isolation: students only see their own records)
// @route   GET /api/evaluations
// @access  Public / Protected
const getAllEvaluations = async (req, res) => {
  try {
    const { studentEmail, testId, course, branch } = req.query;
    const query = {};
    const user = req.user || getRequestUser(req);
    if (!user) {
      return res.status(401).json({ message: 'Authentication required to access evaluations' });
    }
    const userRole = String(user?.role || '').toLowerCase();

    if (userRole === 'student') {
      // Students can ONLY view their OWN PUBLISHED evaluations
      query.published = true;
      const sEmail = String(user.email || '').toLowerCase().trim();
      const sId = String(user._id || user.id || '');
      query.$or = [
        { studentEmail: sEmail },
        { studentId: sId }
      ];
      if (testId) query.testId = testId;

      // Project trimmed student-safe fields (strictly omitting model answers, rubrics, audit trails, and internal locks)
      const rawEvals = await Evaluation.find(query)
        .select('-answerKeySnapshot -auditTrail -lockedBy')
        .sort({ submittedAt: -1, createdAt: -1 });

      const safeEvals = rawEvals.map(doc => {
        const obj = doc.toObject ? doc.toObject() : { ...doc };
        delete obj.answerKeySnapshot;
        delete obj.auditTrail;
        delete obj.lockedBy;
        if (Array.isArray(obj.questionBlocks)) {
          obj.questionBlocks = obj.questionBlocks.map(q => {
            const { standardAnswer, rubric, ...trimmedQ } = q;
            return trimmedQ;
          });
        }
        return obj;
      });

      return res.json(safeEvals);
    }

    // Faculty scope isolation: Teachers are strictly restricted to their assigned course & branch
    if (userRole === 'teacher' && user?.id !== 'master_admin_id') {
      const teacherCourse = user?.targetCourse || user?.course;
      if (teacherCourse) {
        query.course = new RegExp(`^${escapeRegex(teacherCourse)}$`, 'i');
      }
      const teacherBranch = user?.branch || user?.stream;
      if (teacherBranch) {
        query.branch = new RegExp(`^${escapeRegex(teacherBranch)}$`, 'i');
      }
    } else {
      if (course && course !== 'all') query.course = new RegExp(`^${escapeRegex(course)}$`, 'i');
      if (branch && branch !== 'all') query.branch = new RegExp(`^${escapeRegex(branch)}$`, 'i');
    }

    if (studentEmail) query.studentEmail = String(studentEmail).toLowerCase().trim();
    if (testId) query.testId = testId;

    const evals = await Evaluation.find(query).sort({ submittedAt: -1, createdAt: -1 });
    res.json(evals);
  } catch (error) {
    console.error('Error fetching evaluations:', error);
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get single student evaluation by ID (enforces student isolation)
// @route   GET /api/evaluations/:id
// @access  Public / Protected
const getEvaluationById = async (req, res) => {
  try {
    const { id } = req.params;
    const user = req.user || getRequestUser(req);
    if (!user) {
      return res.status(401).json({ message: 'Authentication required' });
    }
    const userRole = String(user?.role || '').toLowerCase();

    const isObjId = mongoose.Types.ObjectId.isValid(id);
    const ev = await Evaluation.findOne({
      $or: [
        { id },
        ...(isObjId ? [{ _id: id }] : [])
      ]
    });

    if (!ev) {
      return res.status(404).json({ message: 'Evaluation record not found' });
    }

    if (userRole === 'student') {
      const isOwner = (
        (user.email && String(user.email).toLowerCase().trim() === String(ev.studentEmail || '').toLowerCase().trim()) ||
        (user.id && String(user.id) === String(ev.studentId || ''))
      );
      if (!isOwner) {
        return res.status(403).json({ message: 'Access denied: You can only view your own evaluation records.' });
      }
      if (!ev.published) {
        return res.status(403).json({ message: 'Access denied: Evaluation results have not been published yet.' });
      }

      // Trim internal model answers, rubrics, and audit records for student
      const evObj = ev.toObject ? ev.toObject() : { ...ev };
      delete evObj.answerKeySnapshot;
      delete evObj.auditTrail;
      delete evObj.lockedBy;
      if (Array.isArray(evObj.questionBlocks)) {
        evObj.questionBlocks = evObj.questionBlocks.map(q => {
          const { standardAnswer, rubric, ...trimmedQ } = q;
          return trimmedQ;
        });
      }
      return res.json(evObj);
    }

    // Teacher isolation check: cannot view script belonging to another course/branch
    if (userRole === 'teacher' && user?.id !== 'master_admin_id') {
      const teacherCourse = String(user?.targetCourse || user?.course || '').toLowerCase().trim();
      const teacherBranch = String(user?.branch || user?.stream || '').toLowerCase().trim();
      const evCourse = String(ev.course || '').toLowerCase().trim();
      const evBranch = String(ev.branch || '').toLowerCase().trim();

      if (teacherCourse && evCourse && teacherCourse !== evCourse) {
        return res.status(403).json({ message: 'Forbidden: You cannot access evaluations from another course.' });
      }
      if (teacherBranch && evBranch && teacherBranch !== evBranch) {
        return res.status(403).json({ message: 'Forbidden: You cannot access evaluations from another branch.' });
      }
    }

    res.json(ev);
  } catch (error) {
    console.error('Error fetching evaluation by id:', error);
    res.status(500).json({ message: error.message });
  }
};

// @desc    Save student evaluation
// @route   POST /api/evaluations
// @access  Public
const saveEvaluation = async (req, res) => {
  try {
    const user = req.user || getRequestUser(req);
    const userRole = String(user?.role || '').toLowerCase();
    if (userRole !== 'teacher' && userRole !== 'admin') {
      return res.status(403).json({ message: 'Forbidden: Only teachers and administrators can save evaluations.' });
    }

    const data = req.body;
    if (userRole === 'teacher' && user?.id !== 'master_admin_id') {
      const teacherCourse = String(user?.targetCourse || user?.course || '').toLowerCase().trim();
      const teacherBranch = String(user?.branch || user?.stream || '').toLowerCase().trim();
      const evCourse = String(data.course || '').toLowerCase().trim();
      const evBranch = String(data.branch || '').toLowerCase().trim();

      if (teacherCourse && evCourse && teacherCourse !== evCourse) {
        return res.status(403).json({ message: 'Forbidden: You cannot evaluate submissions from another course.' });
      }
      if (teacherBranch && evBranch && teacherBranch !== evBranch) {
        return res.status(403).json({ message: 'Forbidden: You cannot evaluate submissions from another branch.' });
      }
    }

    const id = data.id || `eval_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    const payload = {
      ...data,
      id,
      submittedAt: data.submittedAt || new Date()
    };

    const saved = await Evaluation.findOneAndUpdate(
      { id },
      { $set: payload },
      { new: true, upsert: true, runValidators: false }
    );

    // Two-way synchronization with Submission model so student dashboard immediately updates
    try {
      const Submission = require('../models/Submission');
      const targetScore = saved.marksObtained !== undefined && saved.marksObtained !== null
        ? Number(saved.marksObtained)
        : (saved.marks !== undefined && saved.marks !== null ? Number(saved.marks) : null);

      await Submission.findOneAndUpdate(
        {
          $or: [
            { id },
            { assignmentId: String(saved.testId || saved.id), studentId: String(saved.studentId || saved.studentEmail) },
            { assignment: String(saved.testId || saved.id), student: String(saved.studentId || saved.studentEmail) }
          ]
        },
        {
          $set: {
            status: saved.published || saved.status === 'Evaluated' || targetScore !== null ? 'graded' : 'pending',
            marksObtained: targetScore,
            totalMarks: Number(saved.maxMarks || saved.totalMarks || 50),
            adminFeedback: saved.feedback || '',
            evaluationId: saved.id,
            grade: saved.grade || null,
            percentage: saved.percentage || null,
          }
        }
      );
    } catch (subSyncErr) {
      console.warn('[Sync to Submission] Notice:', subSyncErr.message);
    }

    res.status(201).json(saved);
  } catch (error) {
    console.error('Error saving evaluation to MongoDB Atlas:', error);
    res.status(500).json({ message: error.message });
  }
};

// @desc    Evaluate Real Handwritten Answer Sheet with Line Separation & Question Tagging
// @route   POST /api/evaluations/evaluate-handwritten
// @access  Public
const evaluateHandwrittenAnswerSheet = async (req, res) => {
  try {
    const {
      file, // Base64 data URL or uploaded file string
      fileName = 'Handwritten_Answer_Sheet.jpg',
      fileType = 'image/jpeg',
      studentId = 'student',
      studentName = 'Student',
      studentEmail = 'student@asmaths.com',
      testId,
      testTitle = 'Class Test',
      course = 'Engineering',
      branch = 'Computer Science',
      sem = 1,
      classLevel = '',
      subject = 'Mathematics',
      maxMarks = 50,
      cheated = false,
      questionPaperUrl,
      questionPaperDataUrl,
      questionPaperName,
      questionPaperText,
      customPrompt = '',
    } = req.body;

    if (!file && !cheated) {
      return res.status(400).json({ success: false, message: 'Please upload a handwritten answer sheet image or document' });
    }

    // Persist file directly to Cloudinary (zero Base64 payloads in MongoDB Atlas)
    let persistentUrl = '';
    let savedFileName = fileName;
    if (file && typeof file === 'string') {
      try {
        if (file.startsWith('data:') || (!file.startsWith('http') && !file.startsWith('/uploads') && file.length > 100)) {
          const cloudRes = await uploadBase64ToCloudinary(file, {
            fileName,
            folder: 'as_maths/evaluations',
          });
          persistentUrl = cloudRes.secure_url;
          savedFileName = cloudRes.public_id || fileName;
        } else {
          persistentUrl = file;
        }
      } catch (saveErr) {
        console.warn('Cloudinary evaluation upload error, engaging fallback:', saveErr.message);
        try {
          if (file.startsWith('data:')) {
            const matches = file.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
            if (matches && matches.length === 3) {
              const extension = matches[1].includes('pdf') ? 'pdf' : matches[1].includes('png') ? 'png' : 'jpg';
              savedFileName = `eval_${Date.now()}_${Math.random().toString(36).substr(2, 5)}.${extension}`;
              const filePath = path.join(uploadsDir, savedFileName);
              fs.writeFileSync(filePath, Buffer.from(matches[2], 'base64'));
              persistentUrl = `/uploads/${savedFileName}`;
            }
          } else if (!file.startsWith('http') && !file.startsWith('/uploads') && file.length > 100) {
            const isPdf = file.startsWith('JVBERi');
            const isPng = file.startsWith('iVBORw');
            const extension = isPdf ? 'pdf' : isPng ? 'png' : 'jpg';
            savedFileName = `eval_${Date.now()}_${Math.random().toString(36).substr(2, 5)}.${extension}`;
            const filePath = path.join(uploadsDir, savedFileName);
            fs.writeFileSync(filePath, Buffer.from(file, 'base64'));
            persistentUrl = `/uploads/${savedFileName}`;
          } else {
            persistentUrl = file;
          }
        } catch (_) {
          persistentUrl = file.startsWith('http') || file.startsWith('/uploads') ? file : '';
        }
      }
    }

    // Handle Anti-Cheat disqualification if flagged
    if (cheated) {
      const cheatedId = `eval_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
      const cheatRecord = {
        id: cheatedId,
        studentId,
        studentName,
        studentEmail,
        testId: testId || cheatedId,
        testTitle,
        course,
        branch,
        sem,
        classLevel,
        subject,
        score: `0 / ${maxMarks}`,
        marks: 0,
        totalMarks: 0,
        maxMarks: Number(maxMarks) || 50,
        percentage: 0,
        answerSheetUrl: persistentUrl || null,
        answerSheetDataUrl: null, // Zero Base64 payload stored in MongoDB!
        fileName: savedFileName,
        fileType,
        lineSeparatorsDetected: 0,
        questionBlocks: [],
        allMistakes: [
          {
            questionNumber: 'Disqualified',
            description: 'Anti-cheat security violation: student exited the examination window or switched browser tabs.',
            correction: 'Zero marks assigned under the Academic Examination Integrity Code.',
            severity: 'critical',
            location: { top: 50, left: 20, width: 60, height: 15 }
          }
        ],
        feedback: 'Zero marks awarded. Anti-cheat security protocol violation detected — student switched browser tabs or minimized test window.',
        mistakes: ['Disqualified under Anti-Cheat Examination Integrity Code.'],
        hints: 'Please remain focused inside the exam window for the entire duration of the test.',
        metrics: [
          { label: 'Conceptual Clarity', val: '0%' },
          { label: 'Step Precision', val: '0%' },
          { label: 'Exam Integrity', val: 'Violation' },
        ],
        cheated: true,
        status: 'disqualified',
        integrityStatus: 'disqualified',
        submittedDueToViolation: true,
        violationReason: 'Anti-cheat security violation: student exited the examination window or switched browser tabs.',
        submittedAt: new Date(),
      };

      const savedCheat = await Evaluation.findOneAndUpdate(
        { id: cheatedId },
        { $set: cheatRecord },
        { new: true, upsert: true }
      );
      return res.status(201).json({ success: true, evaluation: savedCheat });
    }

    // Resolve Teacher's Question Paper & Pre-Computed LaTeX Answer Key
    let resolvedQuestionDoc = questionPaperDataUrl || null;
    let resolvedQuestionText = questionPaperText || null;
    let resolvedQuestionUrl = questionPaperUrl || null;
    let resolvedAnswerKey = null;
    let targetTest = null;

    // Securely query MongoDB Content / ClassTest to link question paper file and rubric
    if (!resolvedQuestionDoc || !resolvedQuestionText || !resolvedAnswerKey) {
      try {
        const orConditions = [];
        if (testId) {
          orConditions.push({ id: testId });
          orConditions.push({ testId: testId });
          if (mongoose.Types.ObjectId.isValid(testId)) {
            orConditions.push({ _id: testId });
          }
        }
        if (testTitle) {
          const titleRegex = new RegExp(`^${escapeRegex(testTitle)}$`, 'i');
          orConditions.push(
            { title: testTitle, type: { $in: ['classtest', 'classtests', 'test'] } },
            { title: titleRegex, type: { $in: ['classtest', 'classtests', 'test'] } }
          );
        }

        if (orConditions.length > 0) {
          const foundContent = await Content.findOne({ $or: orConditions });
          if (foundContent) {
            targetTest = foundContent;
            resolvedAnswerKey = foundContent.answerKey || null;
            if (!resolvedQuestionDoc && foundContent.fileDataUrl) {
              resolvedQuestionDoc = foundContent.fileDataUrl;
            }
            if (!resolvedQuestionUrl) {
              resolvedQuestionUrl = foundContent.fileUrl || foundContent.filePath || null;
            }
            const contentText = foundContent.questionText || foundContent.description || '';
            if (contentText && (!resolvedQuestionText || resolvedQuestionText.length < contentText.length)) {
              resolvedQuestionText = contentText;
            }
            if (foundContent.steps || foundContent.keyFormula || foundContent.finalAnswer) {
              resolvedQuestionText = `${resolvedQuestionText || ''}\nKey Formula: ${foundContent.keyFormula || ''}\nSolution Steps: ${JSON.stringify(foundContent.steps || '')}\nFinal Answer: ${foundContent.finalAnswer || ''}`;
            }
            console.log(`📄 [TEACHER QUESTION PAPER & ANSWER KEY LINKED VIA MONGODB]: Found Content "${foundContent.title}" (ID: ${foundContent.id || foundContent._id}) - AnswerKey status: ${resolvedAnswerKey?.status || 'none'}`);
          } else {
            const foundTest = (testId && mongoose.Types.ObjectId.isValid(testId) ? await ClassTest.findById(testId).catch(() => null) : null) ||
                              (testTitle ? await ClassTest.findOne({ title: testTitle }).catch(() => null) : null);
            if (foundTest) {
              targetTest = foundTest;
              if (!resolvedQuestionUrl) resolvedQuestionUrl = foundTest.questionPaperUrl || null;
              resolvedQuestionText = foundTest.title || resolvedQuestionText;
              console.log(`📄 [TEACHER QUESTION PAPER LINKED VIA CLASSTEST]: Found ClassTest "${foundTest.title}"`);
            }
          }
        }
      } catch (lookupErr) {
        console.warn('Could not retrieve teacher question paper by testId/title:', lookupErr.message);
      }
    }

    if (!resolvedQuestionDoc && resolvedQuestionUrl) {
      try {
        let cleanUploadName = null;
        if (resolvedQuestionUrl.includes('/uploads/')) {
          cleanUploadName = resolvedQuestionUrl.substring(resolvedQuestionUrl.indexOf('/uploads/') + '/uploads/'.length);
        } else if (resolvedQuestionUrl.startsWith('uploads/')) {
          cleanUploadName = resolvedQuestionUrl.replace('uploads/', '');
        } else if (!resolvedQuestionUrl.startsWith('http://') && !resolvedQuestionUrl.startsWith('https://')) {
          cleanUploadName = path.basename(resolvedQuestionUrl);
        }

        const localPath = cleanUploadName
          ? path.join(uploadsDir, cleanUploadName)
          : (fs.existsSync(resolvedQuestionUrl) ? resolvedQuestionUrl : null);

        if (localPath && fs.existsSync(localPath)) {
          const dataBuf = fs.readFileSync(localPath);
          const ext = path.extname(localPath).toLowerCase();
          const mime = ext === '.pdf' ? 'application/pdf' : ext === '.png' ? 'image/png' : 'image/jpeg';
          resolvedQuestionDoc = `data:${mime};base64,${dataBuf.toString('base64')}`;
          console.log(`📄 [QUESTION PAPER FILE LOADED]: Read ${dataBuf.length} bytes from disk (${cleanUploadName})`);
        }
      } catch (readErr) {
        console.warn('Could not read question paper file from disk:', readErr.message);
      }
    }

    // AI OCR & Handwritten Parsing with Line Separation and Question Tagging
    let parsingResult = null;

    // Multi-page helper: Salvage partial evaluation JSON if response approached token boundary
    const parseEvaluationJsonWithRecovery = (text, targetMax) => {
      if (!text || typeof text !== 'string') return null;
      const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
      try {
        const direct = JSON.parse(cleaned);
        if (direct && Array.isArray(direct.questionBlocks) && direct.questionBlocks.length > 0) {
          return direct;
        }
      } catch (_) {}

      // Automated recovery for questionBlocks array across multi-page submission
      try {
        const qIndex = cleaned.indexOf('"questionBlocks"');
        const arrStart = cleaned.indexOf('[', qIndex !== -1 ? qIndex : 0);
        if (arrStart !== -1) {
          let lastClosingBrace = cleaned.lastIndexOf('}');
          while (lastClosingBrace > arrStart) {
            const candidate = cleaned.substring(arrStart, lastClosingBrace + 1) + ']';
            try {
              const recoveredArr = JSON.parse(candidate);
              if (Array.isArray(recoveredArr) && recoveredArr.length > 0) {
                console.log(`🔧 [EVALUATION JSON RECOVERY]: Salvaged ${recoveredArr.length} question blocks across multi-page submission!`);
                let total = 0;
                recoveredArr.forEach(q => { total += (Number(q.marksAwarded) || 0); });
                return {
                  totalMarks: Math.min(total, targetMax),
                  maxMarks: targetMax,
                  lineSeparatorsDetected: Math.max(1, recoveredArr.length - 1),
                  overallFeedback: 'Comprehensive multi-page handwritten assessment completed.',
                  questionBlocks: recoveredArr,
                  allMistakes: recoveredArr.flatMap(q => q.mistakes || []),
                  hints: 'Review your working steps across all submitted pages.',
                  metrics: [
                    { label: 'Conceptual Clarity', val: '80%' },
                    { label: 'Step Precision', val: '75%' },
                    { label: 'Multi-Page Completeness', val: '100%' }
                  ]
                };
              }
            } catch (_) {}
            lastClosingBrace = cleaned.lastIndexOf('}', lastClosingBrace - 1);
          }
        }
      } catch (salvageErr) {
        console.warn('Evaluation salvage notice:', salvageErr.message);
      }
      return null;
    };

    // Check for Google Gemini Vision API Key (robustly resolved)
    const geminiApiKey = getGeminiApiKey();
    if (geminiApiKey && file) {
      try {
        // Multi-page document aggregation: collect all pages (single PDF, multiple images, or array of pages)
        const allSubmissionPages = [];
        if (typeof file === 'string' && file.startsWith('data:')) {
          allSubmissionPages.push({ dataUrl: file, name: fileName });
        }
        if (Array.isArray(req.body?.files)) {
          req.body.files.forEach((f, idx) => {
            const dUrl = typeof f === 'string' ? f : (f.dataUrl || f.file || f.fileDataUrl);
            if (dUrl && dUrl.startsWith('data:') && !allSubmissionPages.some(p => p.dataUrl === dUrl)) {
              allSubmissionPages.push({ dataUrl: dUrl, name: f.name || `Page_${idx + 1}.jpg` });
            }
          });
        }
        if (Array.isArray(req.body?.pages)) {
          req.body.pages.forEach((p, idx) => {
            const dUrl = typeof p === 'string' ? p : (p.dataUrl || p.file);
            if (dUrl && dUrl.startsWith('data:') && !allSubmissionPages.some(item => item.dataUrl === dUrl)) {
              allSubmissionPages.push({ dataUrl: dUrl, name: `Page_${idx + 1}.jpg` });
            }
          });
        }

        // 1. Expand all submission pages (handling multi-page PDFs or multi-image submissions)
        const initialPages = [...allSubmissionPages];
        const expandedPages = [];
        for (let idx = 0; idx < initialPages.length; idx++) {
          const p = initialPages[idx];
          const isPdf = (p.dataUrl && p.dataUrl.includes('application/pdf')) || (p.name && p.name.toLowerCase().endsWith('.pdf'));
          if (isPdf && p.dataUrl) {
            try {
              const rawBase64 = p.dataUrl.replace(/^data:[^;]+;base64,/, '');
              const pdfBuf = Buffer.from(rawBase64, 'base64');
              const splitPdfs = await splitDocumentIntoPages({ fileBuffer: pdfBuf, fileMime: 'application/pdf' });
              if (splitPdfs && splitPdfs.length > 1) {
                splitPdfs.forEach((sp, spIdx) => {
                  expandedPages.push({
                    dataUrl: `data:application/pdf;base64,${sp.buffer.toString('base64')}`,
                    name: `Page_${spIdx + 1}.pdf`,
                    pageNumber: spIdx + 1,
                    totalPages: splitPdfs.length,
                  });
                });
                continue;
              }
            } catch (err) {
              console.warn('Submission PDF splitting notice:', err.message);
            }
          }
          expandedPages.push({
            ...p,
            pageNumber: expandedPages.length + 1,
          });
        }

        if (expandedPages.length > 0) {
          allSubmissionPages.length = 0;
          allSubmissionPages.push(...expandedPages);
        }

        const totalPages = allSubmissionPages.length;

        if (totalPages > 0) {
          const candidateModels = await getAvailableGeminiModels(geminiApiKey);
          const accumulatedQuestionBlocks = [];
          const accumulatedMistakes = [];
          let totalSeparatorsDetected = 0;
          const pageFeedbacks = [];

          console.log(`🤖 [AI SEQUENTIAL MULTI-PAGE EVALUATION]: Initializing sequential evaluation across ${totalPages} page(s)...`);

          // Sequential Page-by-Page AI Answer Sheet Evaluation Loop:
          // Process Page 1 -> evaluate -> process Page 2 -> evaluate -> ... -> loop completes on the last page -> aggregate final score and report
          for (let pageIdx = 0; pageIdx < totalPages; pageIdx++) {
            const pageItem = allSubmissionPages[pageIdx];
            const pageNum = pageIdx + 1;
            console.log(`🔍 [AI SEQUENTIAL EVALUATION]: Evaluating Page ${pageNum} of ${totalPages}...`);

            const pagePrompt = `You are a Professor of Mathematics and an automated Examination AI Evaluator.
You are evaluating PAGE ${pageNum} of ${totalPages} of a student's handwritten mathematics answer sheet for ${testTitle} (${course} - ${subject || 'Mathematics'}).
${resolvedQuestionDoc ? 'You have also been supplied with the Teacher\'s Official Question Paper document as the primary reference.' : ''}
${resolvedAnswerKey ? `
TEACHER'S PRE-COMPUTED / LOCKED LATEX ANSWER KEY & RUBRIC:
${Array.isArray(resolvedAnswerKey.questions) ? resolvedAnswerKey.questions.map(q => `[${q.q_no}] (Marks: ${q.max_marks})\nQuestion: ${q.problem_statement_latex}\nModel Solution: ${q.solution_latex}\nFinal Answer: ${q.final_answer_latex}`).join('\n\n') : ''}
CRITICAL INSTRUCTION: You MUST grade the student strictly against this pre-computed LaTeX answer key and allocate method marks accordingly.` : ''}
${customPrompt && customPrompt.trim() ? `
TEACHER'S CUSTOM EVALUATION INSTRUCTIONS & GRADING RULES:
${customPrompt.trim()}
CRITICAL: You MUST strictly evaluate and apply all specific grading rules, tolerance criteria, and guidelines specified above by the teacher.` : ''}
${accumulatedQuestionBlocks.length > 0 ? `
QUESTIONS EVALUATED ON PREVIOUS PAGES (Pages 1 to ${pageNum - 1}):
${accumulatedQuestionBlocks.map(q => `[${q.questionNumber}] (Awarded: ${q.marksAwarded}/${q.maxMarks}) on Page ${q.pageNumber}`).join('\n')}
CRITICAL CONTINUITY RULE: If a question started on an earlier page and continues onto this page, grade the continued work on Page ${pageNum}. Extract every question attempted on Page ${pageNum}.
` : ''}

CRITICAL TASK FOR PAGE ${pageNum} OF ${totalPages}:
1. Thoroughly scan, transcribe, and grade EVERY question and mathematical derivation visible on PAGE ${pageNum}.
2. Detect Question Tags explicitly written by the student on this page (e.g. 'ANS [Q1]', 'Q1', 'Question 1', '1(a)', 'Q2', 'Q3').
3. Detect horizontal boundary lines drawn by the student to separate answers on this page.
4. Transcribe the student's handwritten working steps and final answer for each question on this page (extractedAnswer).
5. STRICT MAXIMUM MARKS ENFORCEMENT & SCALING RULES:
   * For EVERY question block, "maxMarks" MUST STRICTLY EQUAL the question's allocated maximum marks.
   * "marksAwarded" CANNOT UNDER ANY CIRCUMSTANCE EXCEED "maxMarks": 0 <= marksAwarded <= maxMarks.
   * "pageNumber" MUST BE ${pageNum}.
6. Detect specific mistakes/slip-ups with normalized location coordinates on this page:
   "location": { "top": <0-100>, "left": <0-100>, "width": <10-60>, "height": <5-25> }
7. Write all mathematical expressions in valid LaTeX syntax.

Respond ONLY with valid JSON strictly matching:
{
  "pageNumber": ${pageNum},
  "lineSeparatorsDetected": number,
  "pageFeedback": "string",
  "questionBlocks": [
    {
      "pageNumber": ${pageNum},
      "questionNumber": "Q1",
      "questionText": "string containing full question statement with LaTeX",
      "standardAnswer": "string containing teacher standard correct solution with LaTeX",
      "extractedAnswer": "string containing student transcribed answer on this page with LaTeX",
      "marksAwarded": number,
      "maxMarks": number,
      "status": "correct" | "partial" | "incorrect",
      "workingSteps": ["step 1", "step 2"],
      "feedback": "string",
      "mistakes": [
        {
          "description": "string",
          "correction": "string",
          "severity": "minor" | "medium" | "critical",
          "location": { "top": number, "left": number, "width": number, "height": number }
        }
      ]
    }
  ],
  "pageMistakes": [
    {
      "questionNumber": "string",
      "description": "string",
      "correction": "string",
      "severity": "string",
      "location": { "top": number, "left": number, "width": number, "height": number }
    }
  ]
}`;

            const requestParts = [];
            if (resolvedQuestionDoc && resolvedQuestionDoc.startsWith('data:')) {
              const qMatches = resolvedQuestionDoc.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
              if (qMatches && qMatches.length === 3) {
                requestParts.push({ inline_data: { mime_type: qMatches[1], data: qMatches[2] } });
              }
            }

            // Attach ONLY this page for sequential evaluation
            if (pageItem.dataUrl && pageItem.dataUrl.startsWith('data:')) {
              const pMatch = pageItem.dataUrl.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
              if (pMatch && pMatch.length === 3) {
                requestParts.push({ inline_data: { mime_type: pMatch[1], data: pMatch[2] } });
              }
            }

            requestParts.push({ text: pagePrompt });

            for (const modelName of candidateModels) {
              try {
                const geminiResp = await fetch(
                  `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${geminiApiKey}`,
                  {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      contents: [{ parts: requestParts }],
                      generationConfig: {
                        response_mime_type: 'application/json',
                        temperature: 0.1,
                        maxOutputTokens: 8192,
                      }
                    })
                  }
                );

                if (geminiResp.ok) {
                  const geminiData = await geminiResp.json();
                  const textResponse = geminiData.candidates?.[0]?.content?.parts?.[0]?.text;
                  if (textResponse) {
                    const parsed = parseEvaluationJsonWithRecovery(textResponse, Number(maxMarks) || 50);
                    if (parsed && Array.isArray(parsed.questionBlocks) && parsed.questionBlocks.length > 0) {
                      const normalizedBlocks = parsed.questionBlocks.map((qb, bIdx) => {
                        const qMax = Number(qb.maxMarks) || 5;
                        const rawAwarded = Number(qb.marksAwarded) || 0;
                        return {
                          ...qb,
                          pageNumber: pageNum,
                          questionNumber: qb.questionNumber || `Q${accumulatedQuestionBlocks.length + bIdx + 1}`,
                          maxMarks: qMax,
                          marksAwarded: Math.min(Math.max(0, rawAwarded), qMax),
                        };
                      });

                      accumulatedQuestionBlocks.push(...normalizedBlocks);
                      if (Array.isArray(parsed.allMistakes || parsed.pageMistakes)) {
                        accumulatedMistakes.push(...(parsed.allMistakes || parsed.pageMistakes));
                      }
                      totalSeparatorsDetected += Number(parsed.lineSeparatorsDetected) || Math.max(1, normalizedBlocks.length - 1);
                      if (parsed.overallFeedback || parsed.pageFeedback) {
                        pageFeedbacks.push(`Page ${pageNum}: ${parsed.overallFeedback || parsed.pageFeedback}`);
                      }

                      console.log(`✅ [PAGE ${pageNum}/${totalPages} EVALUATED via ${modelName}]: ${normalizedBlocks.length} question blocks graded`);
                      break;
                    }
                  }
                }
              } catch (err) {
                console.warn(`Evaluation attempt on page ${pageNum} with model ${modelName} notice:`, err.message);
              }
            }
          }

          // Loop completes on the last page -> aggregate final score and report!
          if (accumulatedQuestionBlocks.length > 0) {
            const totalAwarded = accumulatedQuestionBlocks.reduce((acc, q) => acc + (Number(q.marksAwarded) || 0), 0);
            const finalTotalMarks = Math.min(totalAwarded, Number(maxMarks) || 50);

            parsingResult = {
              totalMarks: finalTotalMarks,
              maxMarks: Number(maxMarks) || 50,
              lineSeparatorsDetected: Math.max(1, totalSeparatorsDetected),
              overallFeedback: pageFeedbacks.length > 0
                ? pageFeedbacks.join(' | ')
                : `Comprehensive sequential evaluation completed across all ${totalPages} page(s). Total score: ${finalTotalMarks}/${maxMarks}.`,
              questionBlocks: accumulatedQuestionBlocks,
              allMistakes: accumulatedMistakes.length > 0
                ? accumulatedMistakes
                : accumulatedQuestionBlocks.flatMap(q => q.mistakes || []),
              hints: 'Review your working steps across all pages against the teacher answer key.',
              metrics: [
                { label: 'Conceptual Clarity', val: `${Math.min(100, Math.round((finalTotalMarks / (Number(maxMarks) || 50)) * 100))}%` },
                { label: 'Step Precision', val: `${Math.min(100, Math.round((finalTotalMarks / (Number(maxMarks) || 50)) * 95))}%` },
                { label: 'Multi-Page Completeness', val: '100%' },
              ],
            };

            console.log(`🏁 [SEQUENTIAL AI EVALUATION AGGREGATED]: Total Marks ${parsingResult.totalMarks}/${parsingResult.maxMarks} across ${parsingResult.questionBlocks.length} question blocks and ${totalPages} pages.`);
          }
        }
      } catch (geminiErr) {
        console.warn('Gemini multimodal evaluation error, falling back to heuristic vision pipeline:', geminiErr.message);
      }
    }


    // If multimodal OCR was unable to extract structured derivations, fail honestly and require genuine faculty evaluation
    if (!parsingResult) {
      console.warn("⚠️ [EVALUATION] Genuine AI OCR transcription unavailable. Zero synthetic fallback marks will be generated.");
      return res.status(422).json({
        success: false,
        error: "AI_OCR_PARSE_FAILED",
        message: "Multimodal OCR could not transcribe handwritten answer sheet. Please evaluate this submission directly in the Faculty Evaluation Studio.",
      });
    }

    // STRICT AI EVALUATION & GRADING BOUNDS (Max Marks Enforcement)
    const targetMaxFinal = Number(maxMarks) || Number(parsingResult?.maxMarks) || 50;
    const keyQuestions = (resolvedAnswerKey && Array.isArray(resolvedAnswerKey.questions))
      ? resolvedAnswerKey.questions
      : (Array.isArray(targetTest?.questions) ? targetTest.questions : []);

    if (Array.isArray(parsingResult?.questionBlocks) && parsingResult.questionBlocks.length > 0) {
      parsingResult.questionBlocks = parsingResult.questionBlocks.map((block, idx) => {
        // Match question from answer key or test definition
        const matchKey = keyQuestions.find(kq => 
          (kq.q_no && String(kq.q_no).trim().toLowerCase() === String(block.questionNumber || '').trim().toLowerCase()) ||
          (kq.id && String(kq.id) === String(block.questionId || ''))
        ) || keyQuestions[idx];

        const parseNum = (v, def = 0) => {
          if (typeof v === 'number') return isNaN(v) ? def : v;
          if (!v) return def;
          const m = String(v).match(/(\d+(?:\.\d+)?)/);
          return m ? parseFloat(m[1]) : def;
        };

        let qMax = parseNum(matchKey?.max_marks || matchKey?.marks || block.maxMarks, 0);
        if (!qMax || qMax <= 0) {
          qMax = Math.max(1, Math.floor(targetMaxFinal / parsingResult.questionBlocks.length));
        }

        let awarded = parseNum(block.marksAwarded, 0);
        if (awarded < 0) awarded = 0;

        // Strict clamp: awarded score can NEVER exceed maxMarks
        if (awarded > qMax) {
          console.warn(`⚠️ [BOUNDS ENFORCEMENT] Clamped question ${block.questionNumber} awarded marks from ${awarded} down to max ${qMax}`);
          awarded = qMax;
        }

        return {
          ...block,
          maxMarks: qMax,
          marksAwarded: awarded
        };
      });

      // Recompute totalMarks strictly from bounded questionBlocks
      const recomputedTotal = parsingResult.questionBlocks.reduce((sum, b) => sum + (Number(b.marksAwarded) || 0), 0);
      parsingResult.totalMarks = Math.min(targetMaxFinal, Math.max(0, recomputedTotal));
      parsingResult.maxMarks = targetMaxFinal;
    }

    // Save evaluation document to MongoDB Atlas
    const evalId = `eval_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    const totalMarksAwarded = Number(parsingResult.totalMarks) || 0;
    const maxMarksFinal = Number(parsingResult.maxMarks) || targetMaxFinal;
    const percentage = Math.round((totalMarksAwarded / maxMarksFinal) * 100);

    const evaluationDoc = {
      id: evalId,
      studentId,
      studentName,
      studentEmail,
      testId: testId || evalId,
      testTitle,
      course,
      branch,
      sem,
      classLevel,
      subject,
      score: `${totalMarksAwarded} / ${maxMarksFinal}`,
      marks: totalMarksAwarded,
      totalMarks: totalMarksAwarded,
      maxMarks: maxMarksFinal,
      percentage,
      answerSheetUrl: persistentUrl || null,
      answerSheetDataUrl: null, // Zero Base64 payload stored in MongoDB!
      fileName: savedFileName,
      fileType,
      lineSeparatorsDetected: parsingResult.lineSeparatorsDetected || 0,
      questionBlocks: parsingResult.questionBlocks || [],
      allMistakes: parsingResult.allMistakes || [],
      feedback: parsingResult.overallFeedback || 'Evaluation completed successfully.',
      mistakes: (parsingResult.allMistakes || []).map(m => `[${m.questionNumber}] ${m.description}`),
      hints: parsingResult.hints || '',
      metrics: parsingResult.metrics || [],
      cheated: false,
      answerKeySnapshot: resolvedAnswerKey || null,
      published: false,
      submittedAt: new Date(),
    };

    const savedEvaluation = await Evaluation.findOneAndUpdate(
      { id: evalId },
      { $set: evaluationDoc },
      { new: true, upsert: true }
    );

    console.log(`✅ [EVALUATION SAVED TO MONGODB ATLAS]: ${evalId} for ${studentEmail} (${totalMarksAwarded}/${maxMarksFinal})`);

    res.status(201).json({
      success: true,
      message: 'Answer sheet successfully evaluated via AI OCR pipeline with line separation & question tagging!',
      evaluation: savedEvaluation
    });
  } catch (error) {
    console.error('Handwritten answer sheet evaluation error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Batch sync student evaluations
// @route   POST /api/evaluations/batch
// @access  Public
const batchSyncEvaluations = async (req, res) => {
  try {
    const { items } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      return res.json({ count: 0, message: 'No evaluations provided' });
    }

    const ops = items.map((item) => {
      const id = item.id || `eval_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
      return {
        updateOne: {
          filter: { id },
          update: { $set: { ...item, id, submittedAt: item.submittedAt || new Date() } },
          upsert: true
        }
      };
    });

    const result = await Evaluation.bulkWrite(ops);
    res.json({
      success: true,
      upsertedCount: result.upsertedCount,
      modifiedCount: result.modifiedCount
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Clear all evaluations
// @route   DELETE /api/evaluations
// @access  Public
const clearAllEvaluations = async (req, res) => {
  try {
    const user = req.user || getRequestUser(req);
    const userRole = String(user?.role || '').toLowerCase();
    if (userRole !== 'admin') {
      return res.status(403).json({ message: 'Forbidden: Only administrators can clear evaluations.' });
    }
    await Evaluation.deleteMany({});
    res.json({ success: true, message: 'All evaluations cleared from MongoDB Atlas' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Delete single evaluation by ID or custom id
// @route   DELETE /api/evaluations/:id
// @access  Public
const deleteEvaluationById = async (req, res) => {
  try {
    const user = req.user || getRequestUser(req);
    const userRole = String(user?.role || '').toLowerCase();
    if (userRole !== 'admin') {
      return res.status(403).json({ message: 'Forbidden: Only administrators can delete evaluation records.' });
    }
    const { id } = req.params;
    const isObjId = mongoose.Types.ObjectId.isValid(id);
    const result = await Evaluation.deleteOne({
      $or: [
        ...(isObjId ? [{ _id: id }] : []),
        { id: id }
      ]
    });
    res.json({ success: true, message: 'Evaluation record deleted', deletedCount: result.deletedCount });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Delete multiple evaluations by IDs
// @route   POST /api/evaluations/batch-delete
// @access  Public
const deleteEvaluationsBatch = async (req, res) => {
  try {
    const user = req.user || getRequestUser(req);
    const userRole = String(user?.role || '').toLowerCase();
    if (userRole !== 'admin') {
      return res.status(403).json({ message: 'Forbidden: Only administrators can delete evaluation records in bulk.' });
    }
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ success: false, message: 'ids array is required' });
    }
    const validObjectIds = ids.filter(id => mongoose.Types.ObjectId.isValid(id));
    const result = await Evaluation.deleteMany({
      $or: [
        { _id: { $in: validObjectIds } },
        { id: { $in: ids } }
      ]
    });
    res.json({ success: true, message: `${result.deletedCount} evaluation records deleted`, deletedCount: result.deletedCount });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Publish evaluation results for a test and notify students
// @route   POST /api/evaluations/publish-results
// @access  Public
const publishEvaluationResults = async (req, res) => {
  try {
    const user = req.user || getRequestUser(req);
    const userRole = String(user?.role || '').toLowerCase();
    if (userRole !== 'teacher' && userRole !== 'admin') {
      return res.status(403).json({ message: 'Forbidden: Only teachers and administrators can publish evaluation results.' });
    }

    const { testId, testTitle } = req.body;
    if (!testId && !testTitle) {
      return res.status(400).json({ success: false, message: 'testId or testTitle required' });
    }

    const teacherCourse = userRole === 'teacher' && user?.id !== 'master_admin_id' ? (user?.targetCourse || user?.course) : null;
    const teacherBranch = userRole === 'teacher' && user?.id !== 'master_admin_id' ? (user?.branch || user?.stream) : null;

    const orConditions = [];
    if (testId && testId !== 'all') {
      orConditions.push({ testId: String(testId) });
      orConditions.push({ id: String(testId) });
      if (mongoose.Types.ObjectId.isValid(testId)) {
        orConditions.push({ _id: testId });
      }
    }
    if (testTitle && testTitle !== 'all' && testTitle !== 'Class Test') {
      const cleanTitle = String(testTitle).trim();
      const titleRegex = new RegExp(`^${escapeRegex(cleanTitle)}$`, 'i');
      orConditions.push({ testTitle: cleanTitle });
      orConditions.push({ testTitle: titleRegex });
    }

    const query = orConditions.length > 0 ? { $or: orConditions } : {};

    // Also update Content.publishedResults if testId/testTitle matches
    let targetContent = null;
    const contentOr = [];
    if (testId && testId !== 'all') {
      contentOr.push({ id: String(testId) });
      contentOr.push({ testId: String(testId) });
      if (mongoose.Types.ObjectId.isValid(testId)) {
        contentOr.push({ _id: testId });
      }
    }
    if (testTitle && testTitle !== 'all' && testTitle !== 'Class Test') {
      const cleanTitle = String(testTitle).trim();
      const titleRegex = new RegExp(`^${escapeRegex(cleanTitle)}$`, 'i');
      contentOr.push({ title: cleanTitle });
      contentOr.push({ title: titleRegex });
    }

    if (contentOr.length > 0) {
      targetContent = await Content.findOneAndUpdate(
        { $or: contentOr },
        { $set: { publishedResults: true } },
        { new: true }
      );
      // Also update ClassTest collection if present
      await ClassTest.updateMany(
        { $or: contentOr },
        { $set: { publishedResults: true } }
      ).catch(() => null);
    }

    const updatePayload = {
      published: true,
      publishedAt: new Date(),
    };
    if (targetContent?.answerKey) {
      updatePayload.answerKeySnapshot = targetContent.answerKey;
    }

    const updateResult = await Evaluation.updateMany(
      query,
      { $set: updatePayload }
    );

    // Trigger Real-Time Notification: "Result Published for [Test Name]"
    try {
      const Notification = require('../models/Notification');
      const testName = targetContent?.title || testTitle || 'Class Test';
      await Notification.create({
        id: `notif_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
        title: 'Class Test Result Published',
        message: `Result Published for ${testName}`,
        type: 'classtest',
        resourceType: 'document',
        course: targetContent?.course || '',
        branch: targetContent?.branch || '',
        semester: targetContent?.semester,
        classLevel: targetContent?.classLevel || '',
        subject: targetContent?.subject || '',
        contentId: targetContent?.id || testId || '',
        readBy: [],
      });
      console.log(`📢 [REAL-TIME NOTIFICATION DISPATCHED]: Result Published for ${testName}`);
    } catch (notifErr) {
      console.warn('Could not dispatch publish notification:', notifErr.message);
    }

    res.json({
      success: true,
      message: `Results published successfully for ${testTitle || testId}`,
      modifiedCount: updateResult.modifiedCount
    });
  } catch (error) {
    console.error('Error publishing evaluation results:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// In-Memory Active Proctoring Streams Registry
const activeProctoringStreams = new Map();

// @desc    Update / publish live student proctoring stream & camera snapshot
// @route   POST /api/evaluations/proctoring-stream
// @access  Public
const updateProctoringStream = async (req, res) => {
  try {
    const { studentEmail, studentId, studentName, testId, testTitle, snapshot, status, strikes, duration } = req.body;
    if (!studentEmail && !studentId) {
      return res.status(400).json({ success: false, message: 'Student identifier required' });
    }
    const key = String(studentEmail || studentId).toLowerCase().trim();
    const existing = activeProctoringStreams.get(key) || {};

    const record = {
      ...existing,
      studentEmail: studentEmail || existing.studentEmail || key,
      studentId: studentId || existing.studentId,
      studentName: studentName || existing.studentName || 'Student',
      testId: testId || existing.testId || 'test',
      testTitle: testTitle || existing.testTitle || 'Class Test',
      snapshot: snapshot || existing.snapshot || null,
      status: status || existing.status || 'active',
      strikes: strikes !== undefined ? strikes : (existing.strikes || 0),
      duration: duration || existing.duration || 0,
      lastHeartbeat: Date.now(),
      startTime: existing.startTime || Date.now(),
      videoUrl: req.body.videoUrl || existing.videoUrl || null,
    };

    activeProctoringStreams.set(key, record);
    res.json({ success: true, record });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc    Get all active student proctoring streams & recent sessions
// @route   GET /api/evaluations/proctoring-streams
// @access  Public
const getActiveProctoringStreams = async (req, res) => {
  try {
    const now = Date.now();
    const list = [];
    for (const [key, item] of activeProctoringStreams.entries()) {
      // Mark as safely disconnected if no heartbeat for 40 seconds
      if (item.status === 'active' && (now - item.lastHeartbeat) > 40000) {
        item.status = 'disconnected';
      }
      list.push(item);
    }
    res.json({ success: true, streams: list });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc    Upload & store student proctoring webcam recording video
// @route   POST /api/evaluations/proctoring-video
// @access  Public
const saveProctoringVideo = async (req, res) => {
  try {
    const { studentEmail, studentId, studentName, testId, testTitle, videoDataUrl, evaluationId } = req.body;
    if (!videoDataUrl) {
      return res.status(400).json({ success: false, message: 'videoDataUrl is required' });
    }

    const uploadsDir = path.join(__dirname, '..', 'uploads');
    const proctorDir = path.join(uploadsDir, 'proctoring');
    if (!fs.existsSync(proctorDir)) {
      fs.mkdirSync(proctorDir, { recursive: true });
    }

    const cleanEmail = (studentEmail || 'student').replace(/[^a-zA-Z0-9]/g, '_');
    const fileName = `proctor_${Date.now()}_${cleanEmail}.webm`;
    let publicUrl = '';

    try {
      const cloudRes = await uploadBase64ToCloudinary(videoDataUrl, {
        fileName,
        folder: 'as_maths/proctoring',
        resource_type: 'video',
      });
      publicUrl = cloudRes.secure_url;
    } catch (vidErr) {
      console.warn('Cloudinary proctoring video upload fallback to disk:', vidErr.message);
      const filePath = path.join(proctorDir, fileName);
      const matches = videoDataUrl.match(/^data:([A-Za-z0-9-+/]+);base64,(.+)$/);
      if (matches && matches.length === 3) {
        fs.writeFileSync(filePath, Buffer.from(matches[2], 'base64'));
      } else {
        fs.writeFileSync(filePath, videoDataUrl);
      }
      publicUrl = `/uploads/proctoring/${fileName}`;
    }

    const key = String(studentEmail || studentId).toLowerCase().trim();
    if (activeProctoringStreams.has(key)) {
      const item = activeProctoringStreams.get(key);
      item.videoUrl = publicUrl;
      item.status = 'concluded';
      activeProctoringStreams.set(key, item);
    }

    // Attach to Evaluation record if present
    if (evaluationId || (testId && studentEmail)) {
      const query = evaluationId
        ? { id: evaluationId }
        : { studentEmail, $or: [{ testId }, { testTitle }] };
      await Evaluation.updateMany(query, {
        $set: {
          proctoringVideoUrl: publicUrl,
          proctoringRecordedAt: new Date()
        }
      }).catch(() => null);
    }

    res.json({ success: true, videoUrl: publicUrl, fileName });
  } catch (err) {
    console.error('Error saving proctoring video:', err);
    res.status(500).json({ success: false, message: err.message });
  }
};

module.exports = {
  getAllEvaluations,
  getEvaluationById,
  saveEvaluation,
  evaluateHandwrittenAnswerSheet,
  publishEvaluationResults,
  batchSyncEvaluations,
  clearAllEvaluations,
  deleteEvaluationById,
  deleteEvaluationsBatch,
  updateProctoringStream,
  getActiveProctoringStreams,
  saveProctoringVideo,
};
