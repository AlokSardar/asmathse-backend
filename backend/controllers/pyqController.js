const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { PDFDocument } = require('pdf-lib');
const { GoogleGenAI } = require('@google/genai');
const PYQPaper = require('../models/PYQPaper');
const {
  normalizeSemester,
  normalizeMarks,
  normalizeQType,
} = require('../utils/cohortNormalize');
const { dbGuard } = require('../utils/dbGuard');

// Candidate model chain matching AI Question Import
const MODEL_CANDIDATE_CHAIN = [
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-flash-lite-latest',
  'gemini-3.5-flash',
  'gemini-flash-latest',
  'gemini-3.8-flash',
];

// Ensure upload directory exists
const pyqUploadDir = path.join(__dirname, '..', 'uploads', 'pyq');
if (!fs.existsSync(pyqUploadDir)) {
  fs.mkdirSync(pyqUploadDir, { recursive: true });
}

// Multer storage configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, pyqUploadDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.pdf';
    const cleanBase = path
      .basename(file.originalname, ext)
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .slice(0, 40);
    const uniqueSuffix = `${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    cb(null, `pyq_${cleanBase}_${uniqueSuffix}${ext}`);
  },
});

const fileFilter = (req, file, cb) => {
  const allowedTypes = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'];
  const ext = path.extname(file.originalname).toLowerCase();
  if (allowedTypes.includes(file.mimetype) || ['.pdf', '.png', '.jpg', '.jpeg', '.webp'].includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error('Only PDF and image files (PNG, JPG, WebP) are allowed for PYQ papers.'), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 30 * 1024 * 1024 }, // 30MB limit
});

exports.uploadMiddleware = upload.single('file');

/**
 * Resilient Gemini caller with candidate model fallback and retry
 */
async function callGemini(contents, config = {}, models = MODEL_CANDIDATE_CHAIN) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || !apiKey.trim()) {
    throw new Error('GEMINI_API_KEY is not configured on the server.');
  }

  const ai = new GoogleGenAI({ apiKey });
  let lastError = null;

  for (const model of models) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const response = await ai.models.generateContent({
          model,
          contents,
          config,
        });
        return { response, model };
      } catch (err) {
        lastError = err;
        const msg = (err.message || '').toLowerCase();
        const isRetryable =
          msg.includes('429') ||
          msg.includes('resource_exhausted') ||
          msg.includes('503') ||
          msg.includes('unavailable') ||
          msg.includes('timeout');
        if (!isRetryable || attempt === 2) break;
        await new Promise((res) => setTimeout(res, attempt * 1000));
      }
    }
  }

  throw lastError || new Error('All Gemini model candidates exhausted.');
}

/**
 * Helper to inspect PDF page count safely
 */
async function inspectPageCount(filePath) {
  try {
    if (!filePath.toLowerCase().endsWith('.pdf')) return 1;
    const fileBytes = fs.readFileSync(filePath);
    const pdfDoc = await PDFDocument.load(fileBytes, { ignoreEncryption: true });
    return Math.max(1, pdfDoc.getPageCount());
  } catch (err) {
    console.warn('[PYQ Controller] Page count detection fallback:', err.message);
    return 1;
  }
}

/**
 * 1. Upload PYQ Paper
 * POST /api/pyq/upload
 */
exports.uploadPaper = async (req, res) => {
  try {
    dbGuard('pyqController.uploadPaper');

    if (!req.file) {
      return res.status(400).json({ success: false, message: 'Please provide a valid PYQ paper file.' });
    }

    const {
      title,
      examBody = 'MAKAUT',
      examYear,
      examMonth = '',
      paperCode = '',
      course = 'Engineering',
      branch = 'CSE',
      semester = 'Semester 1',
      classLevel = '',
      subject = 'Mathematics',
    } = req.body;

    const parsedYear = parseInt(examYear, 10) || new Date().getFullYear();
    const cleanTitle = (title && title.trim()) || `${examBody} ${course} ${subject} (${parsedYear})`;
    const relativeUrl = `/uploads/pyq/${req.file.filename}`;
    const pageCount = await inspectPageCount(req.file.path);

    const normSem = normalizeSemester(semester, course);

    const newPaper = await PYQPaper.create({
      title: cleanTitle,
      examBody: String(examBody).trim() || 'MAKAUT',
      examYear: parsedYear,
      examMonth: String(examMonth).trim(),
      paperCode: String(paperCode).trim(),
      course: String(course).trim(),
      branch: String(branch).trim(),
      semester: normSem,
      classLevel: String(classLevel).trim(),
      subject: String(subject).trim(),
      originalFileUrl: relativeUrl,
      originalFileName: req.file.originalname,
      originalFileSize: req.file.size,
      pageCount,
      extractionStatus: 'pending',
      visibility: 'draft',
      createdBy: req.user?._id || req.user?.id,
    });

    return res.status(201).json({
      success: true,
      message: 'PYQ paper uploaded successfully.',
      paperId: newPaper._id,
      paper: newPaper,
      pageCount,
    });
  } catch (err) {
    console.error('[PYQ uploadPaper error]:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * 2. Extract Questions via Gemini Multimodal Vision API
 * POST /api/pyq/:paperId/extract
 * Supports optional SSE streaming
 */
exports.extractQuestions = async (req, res) => {
  const { paperId } = req.params;
  const wantsSse = req.headers.accept === 'text/event-stream' || req.query.stream === 'true';

  let sseWriter = null;
  if (wantsSse) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    sseWriter = (data) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };
  }

  try {
    dbGuard('pyqController.extractQuestions');

    const paper = await PYQPaper.findById(paperId);
    if (!paper || paper.isDeleted) {
      if (sseWriter) {
        sseWriter({ type: 'error', message: 'PYQ paper not found.' });
        return res.end();
      }
      return res.status(404).json({ success: false, message: 'PYQ paper not found.' });
    }

    paper.extractionStatus = 'extracting';
    await paper.save();

    if (sseWriter) {
      sseWriter({ type: 'progress', message: `Initializing OCR analysis on ${paper.pageCount} page(s)...`, progress: 10 });
    }

    // Resolve physical file path
    const localFilePath = path.join(__dirname, '..', paper.originalFileUrl.replace(/^\//, ''));
    if (!fs.existsSync(localFilePath)) {
      throw new Error(`Underlying document file not found at ${localFilePath}`);
    }

    const fileBytes = fs.readFileSync(localFilePath);
    const cleanBase64 = fileBytes.toString('base64');
    const isPdf = localFilePath.toLowerCase().endsWith('.pdf');
    const mimeType = isPdf ? 'application/pdf' : 'image/png';

    if (sseWriter) {
      sseWriter({ type: 'progress', message: 'Running Gemini AI question extraction & LaTeX transcription...', progress: 40 });
    }

    const promptText = `
You are an expert mathematics examination parser.
Analyze the attached question paper and transcribe ALL visible questions and sub-questions.
Transcribe questions accurately using standard LaTeX formatting (wrap inline math in $...$ and display math in $$...$$).

Return ONLY a valid JSON array adhering strictly to this schema:
[
  {
    "questionNumber": "1(a)",
    "questionText": "Evaluate the integral $\\\\int_0^\\\\infty \\\\frac{\\\\sin x}{x} dx$.",
    "marks": 5,
    "unit": "Unit I",
    "qType": "Subjective",
    "options": []
  }
]

Field guidelines:
- "questionNumber": exact question number as printed (e.g. "1(a)", "2", "3(b)", "Q4").
- "questionText": complete question statement with LaTeX math notation.
- "marks": numerical marks allocated to this specific question/part.
- "unit": section, group, or unit label (e.g. "Group A", "Unit 1", "Section II").
- "qType": "MCQ" | "Subjective" | "Short" | "Long".
- If questions are organized into subparts (e.g., 1(a), 1(b)), output each distinct subpart as an individual entry.
- Do NOT wrap in markdown formatting or explanation outside JSON.
`.trim();

    const contents = [
      {
        role: 'user',
        parts: [
          {
            inlineData: {
              data: cleanBase64,
              mimeType,
            },
          },
          {
            text: promptText,
          },
        ],
      },
    ];

    const config = {
      temperature: 0,
      responseMimeType: 'application/json',
    };

    const { response, model } = await callGemini(contents, config);
    const responseText = response.text || '';

    let parsedQuestions = [];
    const jsonMatch = responseText.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      try {
        parsedQuestions = JSON.parse(jsonMatch[0]);
      } catch (parseErr) {
        console.warn('[PYQ JSON Parse Warning]:', parseErr.message);
      }
    }

    if (!Array.isArray(parsedQuestions) || parsedQuestions.length === 0) {
      // Fallback: Attempt object wrapped items
      try {
        const obj = JSON.parse(responseText);
        if (Array.isArray(obj.questions)) parsedQuestions = obj.questions;
      } catch (_) {}
    }

    // Normalize extracted questions
    const normalizedQuestions = (parsedQuestions || []).map((q, idx) => ({
      questionNumber: String(q.questionNumber || `Q${idx + 1}`).trim(),
      questionText: String(q.questionText || '').trim(),
      marks: normalizeMarks(q.marks, 5),
      unit: String(q.unit || 'General').trim(),
      qType: normalizeQType(q.qType, q.options),
      options: Array.isArray(q.options) ? q.options.map(String) : [],
      correctOption: typeof q.correctOption === 'number' ? q.correctOption : null,
      solution: {
        language: 'english',
        steps: [],
        finalAnswer: '',
        hasGraphic: false,
        graphicDescription: '',
        graphicSvg: '',
      },
      isVerified: false,
      teacherNote: '',
    }));

    const totalMarks = normalizedQuestions.reduce((acc, cur) => acc + (cur.marks || 0), 0);

    paper.questions = normalizedQuestions;
    paper.totalQuestions = normalizedQuestions.length;
    paper.totalMarks = totalMarks;
    paper.extractionStatus = 'extracted';
    paper.extractedAt = new Date();
    await paper.save();

    if (sseWriter) {
      sseWriter({
        type: 'complete',
        message: `Extracted ${normalizedQuestions.length} questions successfully using ${model}.`,
        totalQuestions: normalizedQuestions.length,
        totalMarks,
        paper,
      });
      return res.end();
    }

    return res.status(200).json({
      success: true,
      message: `Extracted ${normalizedQuestions.length} questions successfully.`,
      modelUsed: model,
      totalQuestions: normalizedQuestions.length,
      totalMarks,
      paper,
    });
  } catch (err) {
    console.error('[PYQ extractQuestions error]:', err);
    if (sseWriter) {
      sseWriter({ type: 'error', message: err.message });
      return res.end();
    }
    return res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * 3. AI Generate Step-by-Step Solutions (Bilingual + Optional SVG Graphics)
 * POST /api/pyq/:paperId/solve
 */
exports.solveQuestions = async (req, res) => {
  const { paperId } = req.params;
  const {
    language = 'english',
    style = 'step-by-step',
    generateGraphics = true,
    questionIds = null,
  } = req.body;

  const wantsSse = req.headers.accept === 'text/event-stream' || req.query.stream === 'true';

  let sseWriter = null;
  if (wantsSse) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    sseWriter = (data) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };
  }

  try {
    dbGuard('pyqController.solveQuestions');

    const paper = await PYQPaper.findById(paperId);
    if (!paper || paper.isDeleted) {
      if (sseWriter) {
        sseWriter({ type: 'error', message: 'PYQ paper not found.' });
        return res.end();
      }
      return res.status(404).json({ success: false, message: 'PYQ paper not found.' });
    }

    paper.extractionStatus = 'solving';
    await paper.save();

    const targetIndices = [];
    paper.questions.forEach((q, index) => {
      if (!questionIds || questionIds.length === 0 || questionIds.includes(String(q._id))) {
        targetIndices.push(index);
      }
    });

    const totalToSolve = targetIndices.length;
    let solvedCounter = 0;

    for (let i = 0; i < targetIndices.length; i++) {
      const qIndex = targetIndices[i];
      const q = paper.questions[qIndex];

      if (sseWriter) {
        sseWriter({
          type: 'progress',
          message: `Solving question ${i + 1} of ${totalToSolve} (${q.questionNumber})...`,
          current: i + 1,
          total: totalToSolve,
          questionNumber: q.questionNumber,
        });
      }

      const langInstruction =
        language === 'bengali'
          ? 'Language: Bengali (বাংলা). Write all explanatory sentences in clear Bengali using Bengali script. Keep mathematical formulas in standard LaTeX.'
          : 'Language: English. Write all explanatory steps in clear English. Keep mathematical formulas in standard LaTeX.';

      const solvePrompt = `
You are a distinguished university mathematics professor and examiner.
Solve the following mathematics examination question comprehensively.

${langInstruction}
Solution Style: ${style === 'concise' ? 'Concise (key working only)' : 'Step-by-step rigorous LMS model answer'}.
Question (${q.questionNumber}, Marks: ${q.marks}):
${q.questionText}

RETURN ONLY A VALID JSON OBJECT conforming strictly to this format:
{
  "steps": [
    "Step 1: State the initial theorem or formula...",
    "Step 2: Substitute values...",
    "Step 3: Evaluate the expression..."
  ],
  "finalAnswer": "The final numerical or symbolic result in LaTeX, e.g. $\\\\frac{\\\\pi}{2}$",
  "hasGraphic": true,
  "graphicDescription": "Description of the 2D coordinate graph, function curve, or geometric sketch needed, or empty string if no graphic is required"
}

Format rules:
- Format all mathematical equations in LaTeX with proper escaping ($...$ or $$...$$).
- "hasGraphic": true ONLY if a visual diagram, coordinate plot, geometric figure, or number line directly clarifies the solution.
- Return ONLY valid JSON. No markdown backticks outside, no conversational text.
`.trim();

      try {
        const { response } = await callGemini(
          [{ role: 'user', parts: [{ text: solvePrompt }] }],
          { temperature: 0.1, responseMimeType: 'application/json' }
        );

        let parsedSolution = null;
        try {
          parsedSolution = JSON.parse(response.text || '{}');
        } catch (_) {
          const match = (response.text || '').match(/\{[\s\S]*\}/);
          if (match) parsedSolution = JSON.parse(match[0]);
        }

        const steps = Array.isArray(parsedSolution?.steps) ? parsedSolution.steps.map(String) : [];
        const finalAnswer = String(parsedSolution?.finalAnswer || '').trim();
        const hasGraphic = Boolean(parsedSolution?.hasGraphic && generateGraphics);
        const graphicDescription = String(parsedSolution?.graphicDescription || '').trim();
        let graphicSvg = '';

        // If graphic required and requested, invoke SVG generation
        if (hasGraphic && graphicDescription) {
          try {
            const svgPrompt = `
Generate a clean, scalable, professional SVG diagram for the following mathematical visualization:
"${graphicDescription}".

SVG requirements:
- Return ONLY raw valid SVG markup starting with <svg and ending with </svg>.
- Ensure viewBox="0 0 500 300" and width="100%" height="auto".
- Use crisp styling: stroke="#4f46e5" for main curves, stroke="#94a3b8" for axes/grids, fill="none", font-family="Inter, sans-serif", font-size="12".
- High contrast, dark-mode & light-mode friendly.
- Do NOT output any markdown backticks, DO NOT output any explanation.
`.trim();

            const svgRes = await callGemini(
              [{ role: 'user', parts: [{ text: svgPrompt }] }],
              { temperature: 0.1 }
            );

            let rawSvg = (svgRes.response.text || '').trim();
            const svgMatch = rawSvg.match(/<svg[\s\S]*<\/svg>/i);
            if (svgMatch) {
              graphicSvg = svgMatch[0];
            }
          } catch (svgErr) {
            console.warn(`[PYQ SVG Generation Notice for ${q.questionNumber}]:`, svgErr.message);
          }
        }

        // Assign solution to document sub-item
        q.solution = {
          language,
          steps,
          finalAnswer,
          hasGraphic: Boolean(hasGraphic && graphicSvg),
          graphicDescription,
          graphicSvg,
        };

        solvedCounter++;

        if (sseWriter) {
          sseWriter({
            type: 'question_solved',
            questionIndex: qIndex,
            questionNumber: q.questionNumber,
            solution: q.solution,
          });
        }
      } catch (qErr) {
        console.warn(`[PYQ solve error on ${q.questionNumber}]:`, qErr.message);
      }
    }

    paper.solvedCount = paper.questions.filter((it) => it.solution && it.solution.steps?.length > 0).length;
    paper.extractionStatus = 'solved';
    paper.solvedAt = new Date();
    await paper.save();

    if (sseWriter) {
      sseWriter({
        type: 'complete',
        message: `Successfully solved ${solvedCounter} question(s).`,
        solvedCount: paper.solvedCount,
        paper,
      });
      return res.end();
    }

    return res.status(200).json({
      success: true,
      message: `Successfully generated solutions for ${solvedCounter} question(s).`,
      solvedCount: paper.solvedCount,
      paper,
    });
  } catch (err) {
    console.error('[PYQ solveQuestions error]:', err);
    if (sseWriter) {
      sseWriter({ type: 'error', message: err.message });
      return res.end();
    }
    return res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * 4. Update / Verify Question & Solution
 * PATCH /api/pyq/:paperId/questions/:qIndex
 */
exports.updateQuestion = async (req, res) => {
  try {
    dbGuard('pyqController.updateQuestion');

    const { paperId, qIndex } = req.params;
    const index = parseInt(qIndex, 10);

    const paper = await PYQPaper.findById(paperId);
    if (!paper || paper.isDeleted) {
      return res.status(404).json({ success: false, message: 'PYQ paper not found.' });
    }

    if (index < 0 || index >= paper.questions.length) {
      return res.status(400).json({ success: false, message: 'Invalid question index.' });
    }

    const {
      questionNumber,
      questionText,
      marks,
      unit,
      qType,
      solution,
      isVerified,
      teacherNote,
    } = req.body;

    const target = paper.questions[index];

    if (questionNumber !== undefined) target.questionNumber = String(questionNumber).trim();
    if (questionText !== undefined) target.questionText = String(questionText).trim();
    if (marks !== undefined) target.marks = normalizeMarks(marks, target.marks || 5);
    if (unit !== undefined) target.unit = String(unit).trim();
    if (qType !== undefined) target.qType = normalizeQType(qType);
    if (teacherNote !== undefined) target.teacherNote = String(teacherNote).trim();

    if (isVerified !== undefined) {
      target.isVerified = Boolean(isVerified);
    }

    if (solution && typeof solution === 'object') {
      target.solution = {
        language: solution.language || target.solution?.language || 'english',
        steps: Array.isArray(solution.steps) ? solution.steps : target.solution?.steps || [],
        finalAnswer: solution.finalAnswer !== undefined ? String(solution.finalAnswer) : target.solution?.finalAnswer || '',
        hasGraphic: solution.hasGraphic !== undefined ? Boolean(solution.hasGraphic) : target.solution?.hasGraphic || false,
        graphicDescription: solution.graphicDescription !== undefined ? String(solution.graphicDescription) : target.solution?.graphicDescription || '',
        graphicSvg: solution.graphicSvg !== undefined ? String(solution.graphicSvg) : target.solution?.graphicSvg || '',
      };
    }

    paper.totalMarks = paper.questions.reduce((acc, it) => acc + (it.marks || 0), 0);
    paper.verifiedCount = paper.questions.filter((it) => it.isVerified).length;
    paper.solvedCount = paper.questions.filter((it) => it.solution && it.solution.steps?.length > 0).length;

    await paper.save();

    return res.status(200).json({
      success: true,
      message: 'Question updated successfully.',
      question: target,
      paper,
    });
  } catch (err) {
    console.error('[PYQ updateQuestion error]:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * 5. Publish PYQ Paper
 * PATCH /api/pyq/:paperId/publish
 */
exports.publishPaper = async (req, res) => {
  try {
    dbGuard('pyqController.publishPaper');

    const { paperId } = req.params;
    const { isDownloadable = true } = req.body;

    const paper = await PYQPaper.findById(paperId);
    if (!paper || paper.isDeleted) {
      return res.status(404).json({ success: false, message: 'PYQ paper not found.' });
    }

    paper.visibility = 'published';
    paper.extractionStatus = 'published';
    paper.publishedAt = new Date();
    paper.isDownloadable = Boolean(isDownloadable);

    await paper.save();

    return res.status(200).json({
      success: true,
      message: `"${paper.title}" published successfully to student portal.`,
      paper,
    });
  } catch (err) {
    console.error('[PYQ publishPaper error]:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * 6. Unpublish PYQ Paper
 * PATCH /api/pyq/:paperId/unpublish
 */
exports.unpublishPaper = async (req, res) => {
  try {
    dbGuard('pyqController.unpublishPaper');

    const { paperId } = req.params;
    const paper = await PYQPaper.findById(paperId);
    if (!paper || paper.isDeleted) {
      return res.status(404).json({ success: false, message: 'PYQ paper not found.' });
    }

    paper.visibility = 'draft';
    paper.extractionStatus = 'review';
    await paper.save();

    return res.status(200).json({
      success: true,
      message: `"${paper.title}" reverted to draft.`,
      paper,
    });
  } catch (err) {
    console.error('[PYQ unpublishPaper error]:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * 7. List PYQ Papers (with Cohort & RBAC Isolation)
 * GET /api/pyq
 */
exports.getPYQPapers = async (req, res) => {
  try {
    const {
      course,
      branch,
      semester,
      examBody,
      examYear,
      visibility,
      search,
      page = 1,
      limit = 20,
    } = req.query;

    const userRole = String(req.user?.role || '').toLowerCase();
    const isPrivileged = userRole === 'admin' || userRole === 'teacher';

    const filter = { isDeleted: false };

    // Student vs Faculty view gating
    if (!isPrivileged) {
      filter.visibility = 'published';
    } else if (visibility) {
      filter.visibility = visibility;
    }

    // Cohort scoping
    if (course) {
      filter.course = new RegExp(`^${course}$`, 'i');
    }

    if (semester) {
      const normSem = normalizeSemester(semester, course);
      filter.semester = normSem;
    }

    if (branch && branch !== 'all') {
      // Include branch or common
      filter.$or = [
        { branch: new RegExp(`^${branch}$`, 'i') },
        { branch: 'All' },
        { branch: 'General' },
      ];
    }

    if (examBody && examBody !== 'all') {
      filter.examBody = new RegExp(`^${examBody}$`, 'i');
    }

    if (examYear && !isNaN(examYear)) {
      filter.examYear = Number(examYear);
    }

    if (search && search.trim()) {
      const searchRegex = new RegExp(search.trim(), 'i');
      filter.$or = [
        { title: searchRegex },
        { subject: searchRegex },
        { paperCode: searchRegex },
        { examBody: searchRegex },
      ];
    }

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const skip = (pageNum - 1) * limitNum;

    const [papers, totalCount] = await Promise.all([
      PYQPaper.find(filter)
        .sort({ examYear: -1, createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      PYQPaper.countDocuments(filter),
    ]);

    // Compute KPI stats (only across non-deleted)
    const currentYear = new Date().getFullYear();
    const baseCohortFilter = course ? { course: new RegExp(`^${course}$`, 'i'), isDeleted: false } : { isDeleted: false };

    const [totalPapers, publishedCount, pendingReviewCount, thisYearCount] = await Promise.all([
      PYQPaper.countDocuments(baseCohortFilter),
      PYQPaper.countDocuments({ ...baseCohortFilter, visibility: 'published' }),
      PYQPaper.countDocuments({
        ...baseCohortFilter,
        visibility: 'draft',
        extractionStatus: { $in: ['extracted', 'solved', 'review'] },
      }),
      PYQPaper.countDocuments({ ...baseCohortFilter, examYear: currentYear }),
    ]);

    // Aggregate counts by exam body for filter tree
    const examBodyCounts = await PYQPaper.aggregate([
      { $match: { ...baseCohortFilter, ...(isPrivileged ? {} : { visibility: 'published' }) } },
      { $group: { _id: '$examBody', count: { $sum: 1 } } },
    ]);

    const examBodyMap = {};
    examBodyCounts.forEach((it) => {
      if (it._id) examBodyMap[it._id] = it.count;
    });

    return res.status(200).json({
      success: true,
      data: papers,
      pagination: {
        total: totalCount,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.ceil(totalCount / limitNum),
      },
      counts: {
        total: totalPapers,
        published: publishedCount,
        pendingReview: pendingReviewCount,
        thisYear: thisYearCount,
        byExamBody: examBodyMap,
      },
    });
  } catch (err) {
    console.error('[PYQ getPYQPapers error]:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * 8. Get Single PYQ Paper by ID
 * GET /api/pyq/:paperId
 */
exports.getPYQPaperById = async (req, res) => {
  try {
    const { paperId } = req.params;
    const paper = await PYQPaper.findById(paperId).lean();

    if (!paper || paper.isDeleted) {
      return res.status(404).json({ success: false, message: 'PYQ paper not found.' });
    }

    const userRole = String(req.user?.role || '').toLowerCase();
    const isPrivileged = userRole === 'admin' || userRole === 'teacher';

    if (!isPrivileged && paper.visibility !== 'published') {
      return res.status(403).json({ success: false, message: 'Access denied: This PYQ paper is not yet published.' });
    }

    return res.status(200).json({
      success: true,
      paper,
    });
  } catch (err) {
    console.error('[PYQ getPYQPaperById error]:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * 9. Soft-Delete Paper
 * DELETE /api/pyq/:paperId
 */
exports.deletePaper = async (req, res) => {
  try {
    dbGuard('pyqController.deletePaper');

    const { paperId } = req.params;
    const paper = await PYQPaper.findById(paperId);
    if (!paper) {
      return res.status(404).json({ success: false, message: 'PYQ paper not found.' });
    }

    paper.isDeleted = true;
    await paper.save();

    return res.status(200).json({
      success: true,
      message: `"${paper.title}" moved to trash.`,
      paperId: paper._id,
    });
  } catch (err) {
    console.error('[PYQ deletePaper error]:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * 10. Restore Soft-Deleted Paper
 * POST /api/pyq/:paperId/restore
 */
exports.restorePaper = async (req, res) => {
  try {
    dbGuard('pyqController.restorePaper');

    const { paperId } = req.params;
    const paper = await PYQPaper.findById(paperId);
    if (!paper) {
      return res.status(404).json({ success: false, message: 'PYQ paper not found.' });
    }

    paper.isDeleted = false;
    await paper.save();

    return res.status(200).json({
      success: true,
      message: `"${paper.title}" restored successfully.`,
      paper,
    });
  } catch (err) {
    console.error('[PYQ restorePaper error]:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * 11. Download / Print Solved Paper View (HTML with Print Stylesheet)
 * GET /api/pyq/:paperId/download
 */
exports.getPaperPrintView = async (req, res) => {
  try {
    const { paperId } = req.params;
    const paper = await PYQPaper.findById(paperId).lean();

    if (!paper || paper.isDeleted) {
      return res.status(404).send('<h2>PYQ Paper not found.</h2>');
    }

    const userRole = String(req.user?.role || '').toLowerCase();
    const isPrivileged = userRole === 'admin' || userRole === 'teacher';

    if (!isPrivileged && paper.visibility !== 'published') {
      return res.status(403).send('<h2>This solved PYQ paper is not yet published.</h2>');
    }

    // Build standalone printable HTML document with KaTeX rendering
    const questionsHtml = (paper.questions || [])
      .map((q, idx) => {
        const stepsHtml = (q.solution?.steps || [])
          .map(
            (step, sIdx) =>
              `<li style="margin-bottom: 8px; line-height: 1.6;">${step}</li>`
          )
          .join('');

        const finalAnsHtml = q.solution?.finalAnswer
          ? `<div style="margin-top: 10px; padding: 10px 14px; background: #eef2ff; border-left: 4px solid #6366f1; font-weight: 700;">
              Final Answer: ${q.solution.finalAnswer}
             </div>`
          : '';

        const graphicHtml = q.solution?.graphicSvg
          ? `<div style="margin: 14px 0; text-align: center; max-width: 480px; margin-left: auto; margin-right: auto; padding: 12px; background: #f8fafc; border-radius: 8px; border: 1px solid #e2e8f0;">
              ${q.solution.graphicSvg}
             </div>`
          : '';

        return `
        <article class="question-block" style="margin-bottom: 28px; padding-bottom: 20px; border-bottom: 1px dashed #cbd5e1; page-break-inside: avoid;">
          <div style="display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 8px;">
            <h3 style="margin: 0; font-size: 16px; color: #1e1b4b; font-weight: 700;">
              Question ${q.questionNumber || idx + 1}
              <span style="font-size: 13px; font-weight: 500; color: #64748b; margin-left: 8px;">[${q.unit || 'Section A'}]</span>
            </h3>
            <span style="font-size: 13px; font-weight: 700; color: #4338ca;">[${q.marks} Marks]</span>
          </div>

          <div class="question-statement" style="font-size: 14.5px; line-height: 1.6; color: #0f172a; margin-bottom: 12px;">
            ${q.questionText}
          </div>

          <div class="solution-container" style="background: #f8fafc; border-radius: 8px; padding: 14px 18px; border: 1px solid #e2e8f0;">
            <div style="font-size: 12px; font-weight: 800; color: #475569; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 8px;">
              Model Solution (${q.solution?.language === 'bengali' ? 'বাংলা' : 'English'}):
            </div>
            ${
              stepsHtml
                ? `<ol style="margin: 0 0 10px 20px; padding: 0; color: #1e293b; font-size: 14px;">${stepsHtml}</ol>`
                : '<div style="font-style: italic; color: #94a3b8; font-size: 13px;">Solution pending generation.</div>'
            }
            ${graphicHtml}
            ${finalAnsHtml}
          </div>
        </article>
      `;
      })
      .join('');

    const printableHtml = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${paper.title} — Solved Paper | AS Maths Educator</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.8/dist/katex.min.css">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&family=Noto+Sans+Bengali:wght@400;600;700&display=swap" rel="stylesheet">
  <script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.8/dist/katex.min.js"></script>
  <script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.8/dist/contrib/auto-render.min.js"
    onload="renderMathInElement(document.body, {delimiters: [{left: '$$', right: '$$', display: true}, {left: '$', right: '$', display: false}]});"></script>
  <style>
    body {
      font-family: 'Inter', 'Noto Sans Bengali', system-ui, sans-serif;
      margin: 0;
      padding: 32px 40px;
      color: #0f172a;
      background: #ffffff;
    }
    .header-box {
      border-bottom: 2px solid #4f46e5;
      padding-bottom: 16px;
      margin-bottom: 24px;
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
    }
    .paper-title {
      font-size: 24px;
      font-weight: 800;
      color: #1e1b4b;
      margin: 0 0 6px 0;
    }
    .paper-subtitle {
      font-size: 14px;
      color: #475569;
      font-weight: 600;
    }
    .print-btn-bar {
      margin-bottom: 20px;
      display: flex;
      gap: 12px;
    }
    .as-print-btn {
      background: #4f46e5;
      color: #ffffff;
      padding: 8px 18px;
      font-size: 14px;
      font-weight: 700;
      border: none;
      border-radius: 8px;
      cursor: pointer;
    }
    @media print {
      .print-btn-bar { display: none !important; }
      body { padding: 12mm 15mm; }
      .question-block { page-break-inside: avoid; }
    }
  </style>
</head>
<body>
  <div class="print-btn-bar">
    <button class="as-print-btn" onclick="window.print()">🖨️ Print / Save as PDF</button>
  </div>

  <header class="header-box">
    <div>
      <h1 class="paper-title">${paper.title}</h1>
      <div class="paper-subtitle">
        ${paper.course} • ${paper.branch} • ${paper.semester} • Subject: ${paper.subject}
      </div>
      <div style="font-size: 12.5px; color: #64748b; margin-top: 4px;">
        Exam Body: <strong>${paper.examBody}</strong> | Year: <strong>${paper.examYear}</strong> ${paper.paperCode ? `| Paper Code: <strong>${paper.paperCode}</strong>` : ''}
      </div>
    </div>
    <div style="text-align: right;">
      <div style="font-size: 18px; font-weight: 800; color: #4f46e5;">AS Maths Educator</div>
      <div style="font-size: 12px; color: #64748b;">Solved Question Paper Booklet</div>
      <div style="font-size: 12px; font-weight: 700; color: #059669; margin-top: 4px;">Total Marks: ${paper.totalMarks}</div>
    </div>
  </header>

  <main>
    ${questionsHtml}
  </main>

  <footer style="margin-top: 40px; padding-top: 14px; border-top: 1px solid #cbd5e1; font-size: 11.5px; color: #94a3b8; text-align: center;">
    Generated by AS Maths Educator — AI-Assisted Verified Solutions Platform
  </footer>
</body>
</html>
    `;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(printableHtml);
  } catch (err) {
    console.error('[PYQ getPaperPrintView error]:', err);
    return res.status(500).send(`<h2>Error generating print view: ${err.message}</h2>`);
  }
};
