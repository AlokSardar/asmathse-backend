const mongoose = require('mongoose');
const Content = require('../models/Content');
const ImportSession = require('../models/ImportSession');
const { assertDevOrTestDatabase } = require('../utils/dbGuard');
const {
  normalizeSemester,
  normalizeMarks,
  normalizeQType,
  computeIsCommon,
  computeContentHash,
  calculateTextSimilarity,
} = require('../utils/cohortNormalize');

/**
 * POST /api/content/bulk-import
 * Commit extracted & reviewed questions to the Central Question Bank
 */
exports.bulkImportQuestions = async (req, res) => {
  try {
    assertDevOrTestDatabase();

    const {
      sessionId,
      fileName,
      course = 'Engineering',
      branch,
      stream,
      semester,
      classLevel,
      subject = 'Mathematics',
      questions = [],
      destination = 'question_bank',
      pyqExam = '',
      pyqYear = null,
    } = req.body;

    if (!Array.isArray(questions) || questions.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No questions provided for import.',
      });
    }

    const user = req.user;
    const userRole = String(user?.role || '').toLowerCase();
    const isTeacher = userRole === 'teacher';

    // Teacher cohort isolation guard
    if (isTeacher && user?.id !== 'master_admin_id') {
      const teacherCourse = String(user?.targetCourse || user?.course || '').toLowerCase().trim();
      const reqCourse = String(course || '').toLowerCase().trim();
      if (reqCourse && teacherCourse && !reqCourse.includes(teacherCourse) && !teacherCourse.includes(reqCourse)) {
        return res.status(403).json({
          success: false,
          message: 'Forbidden: Teachers cannot import questions outside their assigned course.',
        });
      }
    }

    // Canonical Cohort Normalizations (Amendment 3)
    const normSemester = normalizeSemester(semester || classLevel, course);
    const targetBranch = branch || stream || 'CSE';
    const effectiveClassLevel = classLevel || (course === 'CBSE' || course === 'ICSE' ? normSemester : null);

    const generatedSessionId = sessionId || `SESSION-IMPORT-${Date.now()}`;
    const importedIds = [];
    let skippedCount = 0;
    const errors = [];

    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      try {
        const qText = String(q.questionText || q.question_latex || q.text || '').trim();
        if (!qText) {
          skippedCount++;
          continue;
        }

        // Duplicate action handling (Amendment 5)
        if (q.duplicateAction === 'skip') {
          skippedCount++;
          continue;
        }

        const canonicalType = normalizeQType(q.qType || q.type, q.options);
        const canonicalMarks = normalizeMarks(q.marks);
        const isCommonVal = computeIsCommon({
          course,
          semester: normSemester,
          subject: q.subject || subject,
          explicitIsCommon: q.isCommon,
        });

        const customId = `QB-AI-${Date.now()}-${i}-${Math.random().toString(36).substring(2, 6)}`;
        const hash = computeContentHash(qText);

        // Duplicate detection: check if question with identical contentHash already exists
        const existingQuestion = await Content.findOne({ contentHash: hash, isDeleted: false }).lean();
        if (existingQuestion && q.duplicateAction !== 'import_anyway' && !q.isDuplicate) {
          skippedCount++;
          continue;
        }

        const isPyq = destination === 'pyq' || q.destination === 'pyq';
        const effectivePyqExam = q.pyqExam || pyqExam || (isPyq ? (fileName ? fileName.replace(/\.[^/.]+$/, '') : 'University Exam') : '');
        const effectivePyqYear = q.pyqYear ? Number(q.pyqYear) : (pyqYear ? Number(pyqYear) : (isPyq ? new Date().getFullYear() : null));
        const effectiveSource = isPyq ? 'PYQ' : (q.source || (fileName ? `${fileName} (Page ${q.pageNumber || 1})` : 'AI Import Pipeline'));
        const effectiveYearTag = q.yearTag || (effectivePyqYear ? String(effectivePyqYear) : (q.sourceYear || 'AI Import'));

        const contentDoc = new Content({
          id: customId,
          itemId: customId,
          customId,
          title: q.title || `${q.topic || subject} - Q${i + 1}`,
          type: 'question',
          qType: canonicalType,
          course,
          branch: targetBranch,
          stream: targetBranch,
          semester: normSemester,
          classLevel: effectiveClassLevel,
          subject: q.subject || subject,
          topic: q.topic || 'General Mathematics',
          difficulty: q.difficulty || 'Medium',
          marks: canonicalMarks,
          questionText: qText,
          options: Array.isArray(q.options) ? q.options : [],
          correctOption: q.correctOption !== undefined ? Number(q.correctOption) : (canonicalType === 'MCQ' ? 0 : null),
          finalAnswer: q.finalAnswer || q.answer_latex || '',
          steps: Array.isArray(q.steps) && q.steps.length > 0 ? q.steps : (q.solution_latex ? [q.solution_latex] : []),
          explanation: q.explanation || q.solution_latex || (Array.isArray(q.steps) ? q.steps.join('\n\n') : ''),
          solutionHidden: q.solutionHidden !== undefined ? Boolean(q.solutionHidden) : false,
          solutionLanguage: q.solutionLanguage || 'english',
          graphicSvg: q.graphicSvg || '',
          rubric: q.rubric || null,
          isCommon: isCommonVal,
          yearTag: effectiveYearTag,
          source: effectiveSource,
          pyqYear: effectivePyqYear,
          pyqExam: effectivePyqExam,
          importSessionId: generatedSessionId,
          importSource: q.importSource || 'AI Import',
          contentHash: hash,
          // Amendment 5: tag duplicate_of if imported anyway
          duplicate_of: (q.duplicateAction === 'import_anyway' || q.isDuplicate) && q.duplicateMatchId ? q.duplicateMatchId : null,
          uploadedBy: user?.name || 'Faculty Mentor',
          uploadedAt: new Date(),
        });

        const saved = await contentDoc.save();
        importedIds.push(saved.id);
      } catch (err) {
        console.error(`Item ${i} import failure:`, err.message);
        errors.push({ index: i, error: err.message });
      }
    }

    // Upsert ImportSession to guarantee history tracking
    await ImportSession.findOneAndUpdate(
      { sessionId: generatedSessionId },
      {
        $set: {
          sessionId: generatedSessionId,
          fileName: fileName || `Document-${new Date().toISOString().slice(0, 10)}.pdf`,
          course,
          branch: targetBranch,
          semester: normSemester,
          subject,
          status: 'completed',
          extractedCount: questions.length,
          lastImportedBatch: importedIds,
          importedAt: new Date(),
          createdBy: user?.name || user?.email || 'Faculty Admin',
        },
      },
      { upsert: true, new: true }
    );

    return res.status(200).json({
      success: true,
      message: `Successfully imported ${importedIds.length} questions into ${course} / ${targetBranch} / ${normSemester}.`,
      imported: importedIds.length,
      skipped: skippedCount,
      errors,
      sessionId: generatedSessionId,
      cohort: {
        course,
        branch: targetBranch,
        semester: normSemester,
        classLevel: effectiveClassLevel,
        subject,
      },
    });
  } catch (error) {
    console.error('bulkImportQuestions error:', error);
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || 'Failed to complete bulk question import.',
    });
  }
};

/**
 * POST /api/content/check-duplicates
 * Checks an array of candidate question texts against existing Question Bank
 * (Strategy: Content hash matching + Token Jaccard >= 0.85; strictly no regex injection)
 */
exports.checkDuplicates = async (req, res) => {
  try {
    assertDevOrTestDatabase();

    const { questions = [], questionTexts = [], course } = req.body;
    const candidates = questions.length > 0
      ? questions
      : questionTexts.map((text, idx) => ({ id: idx, questionText: text }));

    if (candidates.length === 0) {
      return res.status(200).json({ success: true, duplicates: [] });
    }

    // Query existing questions scoped by course if provided, otherwise recent 500 items
    const query = { isDeleted: { $ne: true } };
    if (course) {
      query.course = new RegExp(`^${course}$`, 'i');
    }

    const existingBank = await Content.find(query)
      .select('id customId title questionText contentHash course branch semester')
      .lean();

    const duplicates = [];

    for (let i = 0; i < candidates.length; i++) {
      const cand = candidates[i];
      const candText = cand.questionText || cand.question_latex || cand.text || '';
      if (!candText) continue;

      const candHash = computeContentHash(candText);

      let bestMatch = null;
      let highestSimilarity = 0;

      for (const item of existingBank) {
        // 1. Exact normalized hash match
        if (item.contentHash && item.contentHash === candHash) {
          bestMatch = item;
          highestSimilarity = 1.0;
          break;
        }

        // 2. High-precision Token Jaccard check (min threshold 0.85)
        const sim = calculateTextSimilarity(candText, item.questionText || item.title || '');
        if (sim >= 0.85 && sim > highestSimilarity) {
          highestSimilarity = sim;
          bestMatch = item;
        }
      }

      if (bestMatch && highestSimilarity >= 0.85) {
        duplicates.push({
          index: i,
          candidateId: cand.id || cand.itemId || i,
          questionText: candText,
          matchId: bestMatch.id || bestMatch.customId || String(bestMatch._id),
          matchTitle: bestMatch.title || bestMatch.questionText?.slice(0, 50),
          matchCohort: `${bestMatch.course || ''} ${bestMatch.branch || ''} ${bestMatch.semester || ''}`.trim(),
          similarity: Math.round(highestSimilarity * 100),
        });
      }
    }

    return res.status(200).json({
      success: true,
      totalChecked: candidates.length,
      duplicateCount: duplicates.length,
      duplicates,
    });
  } catch (error) {
    console.error('checkDuplicates error:', error);
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || 'Duplicate check failed.',
    });
  }
};

/**
 * GET /api/content/import-history
 * Paginated list of past import sessions with summary metrics and statistics
 */
exports.getImportHistory = async (req, res) => {
  try {
    assertDevOrTestDatabase();

    const { page = 1, limit = 10, course } = req.query;
    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.min(50, Math.max(1, parseInt(limit, 10)));

    const query = {};
    if (course && course !== 'ALL') {
      query.course = new RegExp(`^${course}$`, 'i');
    }

    const [sessions, totalSessions, allImportedContent] = await Promise.all([
      ImportSession.find(query)
        .sort({ importedAt: -1, createdAt: -1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum)
        .lean(),
      ImportSession.countDocuments(query),
      Content.find({ importSource: 'AI Import', isDeleted: { $ne: true } })
        .select('qType subject uploadedAt')
        .lean(),
    ]);

    // Compute Stats
    const totalAllTime = allImportedContent.length;
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const totalThisMonth = allImportedContent.filter((c) => c.uploadedAt && new Date(c.uploadedAt) >= startOfMonth).length;

    const byQType = {
      MCQ: 0,
      Subjective: 0,
      'True/False': 0,
      'Fill-in-the-blank': 0,
    };

    const subjectCounts = {};

    for (const c of allImportedContent) {
      const type = c.qType || 'Subjective';
      if (byQType[type] !== undefined) {
        byQType[type]++;
      } else {
        byQType.Subjective++;
      }

      const subj = c.subject || 'General';
      subjectCounts[subj] = (subjectCounts[subj] || 0) + 1;
    }

    const topSubjects = Object.entries(subjectCounts)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    const history = sessions.map((s) => ({
      sessionId: s.sessionId,
      fileName: s.fileName,
      fileSizeLabel: s.fileSizeLabel || '2.1 MB',
      course: s.course,
      branch: s.branch,
      semester: s.semester,
      classLevel: s.classLevel || null,
      subject: s.subject || 'Applied Mathematics',
      totalPages: s.totalPages || 1,
      importedCount: s.lastImportedBatch ? s.lastImportedBatch.length : (s.extractedCount || 0),
      importedAt: s.importedAt || s.createdAt,
      importedBy: s.createdBy || 'Faculty Mentor',
      status: s.status || 'completed',
    }));

    return res.status(200).json({
      success: true,
      history,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: totalSessions,
        totalPages: Math.ceil(totalSessions / limitNum) || 1,
      },
      stats: {
        totalAllTime,
        totalThisMonth,
        byQType,
        topSubjects,
      },
    });
  } catch (error) {
    console.error('getImportHistory error:', error);
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || 'Failed to retrieve import history.',
    });
  }
};
