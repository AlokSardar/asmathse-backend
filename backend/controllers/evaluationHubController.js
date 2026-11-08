const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const Evaluation = require('../models/Evaluation');
const MarkingScheme = require('../models/MarkingScheme');
const EvaluationAnnotation = require('../models/EvaluationAnnotation');
const AuditLog = require('../models/AuditLog');
const ReEvaluationRequest = require('../models/ReEvaluationRequest');
const Content = require('../models/Content');
const Submission = require('../models/Submission');
const Notification = require('../models/Notification');
const { generateAuthenticatedScriptUrl, uploadPrivateScriptToCloudinary } = require('../services/cloudinaryService');

const uploadsDir = path.join(__dirname, '..', 'uploads');
const privateUploadsDir = path.join(uploadsDir, 'private_scripts');
if (!fs.existsSync(privateUploadsDir)) {
  fs.mkdirSync(privateUploadsDir, { recursive: true });
}

// Helper: Escape regex string
const escapeRegex = (str) => {
  if (typeof str !== 'string') return '';
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
};

// Helper: Verify teacher course/branch isolation
const checkTeacherAccess = (user, course, branch) => {
  const role = String(user?.role || '').toLowerCase();
  if (role === 'admin' || user?.id === 'master_admin_id') return true;
  if (role !== 'teacher') return false;

  const tCourse = String(user?.targetCourse || user?.course || '').toLowerCase().trim();
  const tBranch = String(user?.branch || user?.stream || '').toLowerCase().trim();
  const docCourse = String(course || '').toLowerCase().trim();
  const docBranch = String(branch || '').toLowerCase().trim();

  if (tCourse && docCourse && tCourse !== docCourse) return false;
  if (tBranch && docBranch && tBranch !== docBranch) return false;
  return true;
};

// Helper: Write audit log entry
const logAudit = async ({ targetType, targetId, action, req, changes = {} }) => {
  try {
    const user = req.user || {};
    await AuditLog.create({
      id: `AUDIT-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
      targetType,
      targetId: String(targetId),
      action,
      actorId: String(user.id || user._id || 'unknown'),
      actorName: user.name || 'System User',
      actorRole: user.role || 'system',
      actorEmail: user.email || '',
      changes,
      ipAddress: req.ip || req.connection?.remoteAddress || '127.0.0.1',
      userAgent: req.headers['user-agent'] || '',
      timestamp: new Date(),
    });
  } catch (err) {
    console.warn('[AuditLog] Notice: could not record audit log:', err.message);
  }
};

// Helper: Validate evaluation completeness against MarkingScheme for publication
const validateEvaluationForPublish = async (ev) => {
  const examId = String(ev.testId || ev.examId || '');
  const scheme = await MarkingScheme.findOne({ examId });
  const missing = [];

  if (scheme && Array.isArray(scheme.questions) && scheme.questions.length > 0) {
    const qMarks = Array.isArray(ev.questionMarks) ? ev.questionMarks : [];
    for (const sq of scheme.questions) {
      const qNum = String(sq.questionNumber).trim();
      const entry = qMarks.find((qm) => String(qm.questionNumber).trim() === qNum);
      if (!entry || ((entry.marksAwarded === null || entry.marksAwarded === undefined) && !entry.notAttempted)) {
        missing.push(qNum);
      }
    }
  }

  if (missing.length > 0) {
    return {
      valid: false,
      reason: `Incomplete marks: Questions [${missing.join(', ')}] have not been evaluated.`,
    };
  }

  if (ev.evaluationStatus !== 'evaluated') {
    return {
      valid: false,
      reason: `Evaluation status must be 'evaluated' (currently '${ev.evaluationStatus}'). Finalize evaluation first.`,
    };
  }

  if (ev.marksObtained === null || ev.marksObtained === undefined) {
    return {
      valid: false,
      reason: 'Evaluation has no recorded marks.',
    };
  }

  return { valid: true };
};

// ============================================================================
// 1. MARKING SCHEME MANAGEMENT
// ============================================================================

// @desc    Create or update marking scheme for an exam
// @route   POST /api/evaluations/marking-schemes
// @access  Teacher / Admin
const createOrUpdateMarkingScheme = async (req, res) => {
  try {
    const user = req.user;
    const data = req.body || {};
    const { examId, examTitle, course, branch, semester, totalMarks, sections, questions } = data;

    if (!examId || !examTitle || !course || !branch || !totalMarks) {
      return res.status(400).json({ message: 'Missing required marking scheme fields: examId, examTitle, course, branch, totalMarks' });
    }

    if (!checkTeacherAccess(user, course, branch)) {
      return res.status(403).json({ message: 'Forbidden: You cannot author marking schemes for another course or branch.' });
    }

    const schemeId = data.id || `SCHEME-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
    const payload = {
      id: schemeId,
      examId: String(examId),
      examTitle,
      course,
      branch,
      semester: semester || 1,
      subject: data.subject || 'Mathematics',
      totalMarks: Number(totalMarks),
      passingMarks: Number(data.passingMarks || Math.round(totalMarks * 0.4)),
      instructions: Array.isArray(data.instructions) ? data.instructions : [],
      sections: Array.isArray(sections) ? sections : [],
      questions: Array.isArray(questions) ? questions : [],
      status: data.status || 'draft',
      createdBy: String(user.id || user._id),
      createdByName: user.name || 'Faculty Member',
    };

    const scheme = await MarkingScheme.findOneAndUpdate(
      { examId: String(examId) },
      { $set: payload },
      { new: true, upsert: true, runValidators: true }
    );

    await logAudit({
      targetType: 'MarkingScheme',
      targetId: scheme.id,
      action: 'marks_modified',
      req,
      changes: { examId, totalMarks, questionsCount: scheme.questions.length },
    });

    res.status(201).json({ success: true, scheme });
  } catch (err) {
    console.error('Error saving marking scheme:', err);
    res.status(500).json({ message: err.message });
  }
};

// @desc    Get marking scheme for an exam
// @route   GET /api/evaluations/marking-schemes/:examId
// @access  Teacher / Admin
const getMarkingSchemeByExamId = async (req, res) => {
  try {
    const { examId } = req.params;
    const user = req.user;

    const scheme = await MarkingScheme.findOne({ examId: String(examId) });
    if (!scheme) {
      return res.status(404).json({ message: 'Marking scheme not found for this exam' });
    }

    if (!checkTeacherAccess(user, scheme.course, scheme.branch)) {
      return res.status(403).json({ message: 'Forbidden: You cannot access marking schemes from another course or branch.' });
    }

    res.json({ success: true, scheme });
  } catch (err) {
    console.error('Error fetching marking scheme:', err);
    res.status(500).json({ message: err.message });
  }
};

// ============================================================================
// 2. EVALUATION WORKSPACE DATA LOADER
// ============================================================================

// @desc    Get complete workspace data for split-screen evaluation
// @route   GET /api/evaluations/:id/workspace
// @access  Teacher / Admin
const getEvaluationWorkspace = async (req, res) => {
  try {
    const { id } = req.params;
    const user = req.user;

    const ev = await Evaluation.findOne({
      $or: [{ id }, ...(mongoose.Types.ObjectId.isValid(id) ? [{ _id: id }] : [])]
    });

    if (!ev) {
      return res.status(404).json({ message: 'Evaluation record not found' });
    }

    if (!checkTeacherAccess(user, ev.course, ev.branch)) {
      return res.status(403).json({ message: 'Forbidden: You cannot evaluate submissions from another course or branch.' });
    }

    const examId = String(ev.testId || ev.examId || '');

    // Concurrently fetch marking scheme, question paper, and annotations
    const [scheme, questionPaper, annotations] = await Promise.all([
      MarkingScheme.findOne({ examId }),
      Content.findOne({ $or: [{ id: examId }, { testId: examId }, ...(mongoose.Types.ObjectId.isValid(examId) ? [{ _id: examId }] : [])] })
        .select('-answerKey.solutionSet -answerKey.fullLatexDocument'),
      EvaluationAnnotation.find({ evaluationId: ev.id }).sort({ pageNumber: 1, createdAt: 1 }),
    ]);

    // Inspect active lock state
    const now = new Date();
    const isLockedByOther = Boolean(
      ev.lockedBy?.userId &&
      ev.lockedBy.userId !== String(user.id || user._id) &&
      new Date(ev.lockedBy.expiresAt) > now
    );

    res.json({
      success: true,
      evaluation: {
        id: ev.id,
        testId: ev.testId,
        testTitle: ev.testTitle,
        studentId: ev.studentId,
        studentName: ev.studentName,
        studentEmail: ev.studentEmail,
        studentRoll: ev.studentRoll || ev.rollNumber,
        course: ev.course,
        branch: ev.branch,
        semester: ev.semester || ev.sem,
        marksObtained: ev.marksObtained,
        totalMarks: scheme?.totalMarks || ev.totalMarks || ev.maxMarks,
        percentage: ev.percentage,
        grade: ev.grade,
        evaluationStatus: ev.evaluationStatus || 'pending',
        version: ev.version || 0,
        lockedBy: ev.lockedBy || null,
        isLockedByOther,
        questionMarks: ev.questionMarks || [],
        pageEvaluations: ev.pageEvaluations || [],
        feedback: ev.feedback || '',
        answerPages: ev.answerPages || [],
        totalPages: ev.totalPages || (ev.answerPages?.length || 1),
        answerSheetUrl: ev.answerSheetUrl || '',
        privateScriptUrl: `/api/evaluations/${ev.id}/script-file`,
        published: ev.published || false,
        submittedAt: ev.submittedAt,
      },
      markingScheme: scheme || null,
      questionPaper: questionPaper || null,
      annotations: annotations || [],
      lockState: {
        isLocked: Boolean(ev.lockedBy?.userId && new Date(ev.lockedBy.expiresAt) > now),
        isLockedByOther,
        lockedBy: ev.lockedBy?.userId || null,
        lockedByName: ev.lockedBy?.name || null,
        expiresAt: ev.lockedBy?.expiresAt || null,
      },
    });
  } catch (err) {
    console.error('Error fetching workspace data:', err);
    res.status(500).json({ message: err.message });
  }
};

// ============================================================================
// 3. CONCURRENCY LOCKING & HEARTBEAT
// ============================================================================

// @desc    Acquire or refresh an evaluation session lock (5-minute TTL)
// @route   POST /api/evaluations/:id/lock
// @access  Teacher / Admin
const acquireOrRefreshLock = async (req, res) => {
  try {
    const { id } = req.params;
    const user = req.user;
    const userId = String(user.id || user._id);

    const ev = await Evaluation.findOne({
      $or: [{ id }, ...(mongoose.Types.ObjectId.isValid(id) ? [{ _id: id }] : [])]
    });

    if (!ev) {
      return res.status(404).json({ message: 'Evaluation not found' });
    }

    if (!checkTeacherAccess(user, ev.course, ev.branch)) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    const now = new Date();
    const existingLock = ev.lockedBy;

    // Check if locked by someone else with unexpired TTL
    if (existingLock?.userId && existingLock.userId !== userId && new Date(existingLock.expiresAt) > now) {
      return res.status(409).json({
        success: false,
        message: `This script is currently locked by ${existingLock.name || 'another teacher'}.`,
        lockedByName: existingLock.name,
        lockedBy: existingLock,
      });
    }

    // Acquire or extend lock with 5-minute TTL
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
    const lockPayload = {
      userId,
      name: user.name || 'Faculty Member',
      role: user.role || 'teacher',
      lockedAt: now,
      expiresAt,
    };

    ev.lockedBy = lockPayload;
    if (ev.evaluationStatus === 'pending') {
      ev.evaluationStatus = 'in_progress';
    }
    await ev.save();

    await logAudit({
      targetType: 'Evaluation',
      targetId: ev.id,
      action: 'lock_acquired',
      req,
      changes: { expiresAt },
    });

    res.json({ success: true, isLocked: true, lockedBy: lockPayload });
  } catch (err) {
    console.error('Error acquiring lock:', err);
    res.status(500).json({ message: err.message });
  }
};

// @desc    Release evaluation lock
// @route   POST /api/evaluations/:id/unlock
// @access  Teacher / Admin
const releaseLock = async (req, res) => {
  try {
    const { id } = req.params;
    const user = req.user;
    const userId = String(user.id || user._id);
    const isAdmin = String(user.role).toLowerCase() === 'admin';

    const ev = await Evaluation.findOne({
      $or: [{ id }, ...(mongoose.Types.ObjectId.isValid(id) ? [{ _id: id }] : [])]
    });

    if (!ev) {
      return res.status(404).json({ message: 'Evaluation not found' });
    }

    if (ev.lockedBy?.userId && ev.lockedBy.userId !== userId && !isAdmin) {
      return res.status(403).json({ message: 'You can only release locks held by yourself.' });
    }

    ev.lockedBy = null;
    await ev.save();

    await logAudit({
      targetType: 'Evaluation',
      targetId: ev.id,
      action: 'lock_released',
      req,
    });

    res.json({ success: true, isLocked: false, message: 'Lock released successfully' });
  } catch (err) {
    console.error('Error releasing lock:', err);
    res.status(500).json({ message: err.message });
  }
};

// ============================================================================
// 4. VERSIONED DRAFT SAVES & MARKS INTEGRITY
// ============================================================================

// @desc    Save evaluation draft with optimistic concurrency control and marks integrity
// @route   PATCH /api/evaluations/:id/draft
// @access  Teacher / Admin
const saveEvaluationDraft = async (req, res) => {
  try {
    const { id } = req.params;
    const user = req.user;
    const userId = String(user.id || user._id);
    const userRole = String(user.role || '').toLowerCase();
    const data = req.body || {};

    const ev = await Evaluation.findOne({
      $or: [{ id }, ...(mongoose.Types.ObjectId.isValid(id) ? [{ _id: id }] : [])]
    });

    if (!ev) {
      return res.status(404).json({ message: 'Evaluation not found' });
    }

    if (!checkTeacherAccess(user, ev.course, ev.branch)) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    // 1. Lock Enforcement: caller must hold valid unexpired lock; admin override permitted with audit entry
    const now = new Date();
    const isLockHolder = Boolean(ev.lockedBy?.userId && String(ev.lockedBy.userId) === userId && new Date(ev.lockedBy.expiresAt) > now);

    if (!isLockHolder) {
      if (userRole === 'admin') {
        await logAudit({
          targetType: 'Evaluation',
          targetId: ev.id,
          action: 'admin_override',
          req,
          changes: { operation: 'draft_save', reason: 'Admin override save without exclusive lock' },
        });
      } else {
        return res.status(409).json({
          success: false,
          message: ev.lockedBy?.userId
            ? `Exclusive lock is currently held by ${ev.lockedBy.name || 'another teacher'}. Please acquire the lock before saving.`
            : 'Exclusive lock required. Your lock has expired or has not been acquired.',
          lockedBy: ev.lockedBy || null,
        });
      }
    }

    // 2. Optimistic concurrency control: version check
    const clientVersion = Number(data.version);
    if (!data.force && !isNaN(clientVersion) && clientVersion !== (ev.version || 0)) {
      return res.status(409).json({
        success: false,
        isVersionConflict: true,
        message: 'Conflict: This evaluation has been updated in another session. Please reload to avoid overwriting, or choose Keep Mine to overwrite.',
        serverVersion: ev.version || 0,
        currentVersion: ev.version || 0,
      });
    }

    if (data.force && !isNaN(clientVersion) && clientVersion !== (ev.version || 0)) {
      await logAudit({
        targetType: 'Evaluation',
        targetId: ev.id,
        action: 'version_conflict_override',
        req,
        changes: { clientVersion, serverVersion: ev.version, note: 'Teacher elected to keep mine and overwrite stale version' },
      });
    }

    // 3. Server-side marks integrity & reconciliation against MarkingScheme
    const examId = String(ev.testId || ev.examId || '');
    const scheme = await MarkingScheme.findOne({ examId });

    let finalTotalMarks = Number(ev.totalMarks || ev.maxMarks || 50);
    const rawQuestionMarks = Array.isArray(data.questionMarks) ? data.questionMarks : (ev.questionMarks || []);
    let computedMarksObtained = 0;
    const validatedQuestionMarks = [];

    if (scheme) {
      finalTotalMarks = Number(scheme.totalMarks);

      for (const item of rawQuestionMarks) {
        const qNum = String(item.questionNumber || '').trim();
        const schemeQ = scheme.questions.find(
          (sq) => String(sq.questionNumber).trim() === qNum &&
            (!item.subPart || String(sq.subPart || '').trim() === String(item.subPart).trim())
        );

        if (!schemeQ) {
          return res.status(400).json({
            message: `Unknown question number '${qNum}' in evaluation marks. Question does not exist in MarkingScheme.`
          });
        }

        const qMax = Number(schemeQ.maxMarks);
        let qAwarded = 0;

        if (item.notAttempted === true) {
          qAwarded = 0;
        } else {
          qAwarded = Number(item.marksAwarded);
          if (isNaN(qAwarded) || qAwarded < 0 || qAwarded > qMax) {
            return res.status(400).json({
              message: `Marks awarded for question ${qNum} (${item.marksAwarded}) must be between 0 and ${qMax}.`
            });
          }
        }

        // Validate step marks if present
        const rawStepMarks = Array.isArray(item.stepMarks)
          ? item.stepMarks
          : (Array.isArray(item.stepMarksAwarded) ? item.stepMarksAwarded : []);

        const validatedStepMarks = [];
        if (rawStepMarks.length > 0 && Array.isArray(schemeQ.stepRubric) && schemeQ.stepRubric.length > 0) {
          for (const sm of rawStepMarks) {
            const stepNum = Number(sm.stepNumber);
            const schemeStep = schemeQ.stepRubric.find((s) => Number(s.stepNumber) === stepNum);
            if (schemeStep) {
              const smAwarded = Number(sm.marksAwarded);
              if (isNaN(smAwarded) || smAwarded < 0 || smAwarded > schemeStep.marksAwarded) {
                return res.status(400).json({
                  message: `Step marks for question ${qNum} step ${stepNum} (${sm.marksAwarded}) exceeds step maximum (${schemeStep.marksAwarded}).`
                });
              }
              validatedStepMarks.push({
                stepNumber: stepNum,
                marksAwarded: smAwarded,
                comment: sm.comment || '',
              });
            }
          }
        }

        validatedQuestionMarks.push({
          questionNumber: qNum,
          subPart: item.subPart || '',
          maxMarks: qMax,
          marksAwarded: qAwarded,
          notAttempted: item.notAttempted === true,
          stepMarks: validatedStepMarks,
          remarks: item.remarks || item.teacherFeedback || '',
          teacherFeedback: item.teacherFeedback || item.remarks || '',
        });

        computedMarksObtained += qAwarded;
      }
    } else {
      for (const q of rawQuestionMarks) {
        const awarded = Number(q.marksAwarded || 0);
        validatedQuestionMarks.push({
          ...q,
          marksAwarded: awarded,
        });
        computedMarksObtained += awarded;
      }
    }

    const marksObtained = computedMarksObtained;
const percentage = finalTotalMarks > 0 ? Math.round((marksObtained / finalTotalMarks) * 100) : 0;
    const grade = percentage >= 90 ? 'A+' : percentage >= 80 ? 'A' : percentage >= 70 ? 'B+' : percentage >= 60 ? 'B' : percentage >= 40 ? 'C' : 'F';

    const previousMarks = ev.marksObtained;
    const nextVersion = (ev.version || 0) + 1;

    ev.questionMarks = validatedQuestionMarks;
    ev.pageEvaluations = Array.isArray(data.pageEvaluations) ? data.pageEvaluations : (ev.pageEvaluations || []);
    ev.marksObtained = marksObtained;
    ev.marks = marksObtained;
    ev.score = marksObtained;
    ev.totalMarks = finalTotalMarks;
    ev.maxMarks = finalTotalMarks;
    ev.percentage = percentage;
    ev.grade = grade;
    ev.feedback = data.feedback !== undefined ? data.feedback : (ev.feedback || '');
    ev.evaluationStatus = 'in_progress';
    ev.evaluatedBy = userId;
    ev.evaluatedByName = user.name || 'Faculty Member';
    ev.evaluatedAt = new Date();
    ev.version = nextVersion;

    await ev.save();

    await logAudit({
      targetType: 'Evaluation',
      targetId: ev.id,
      action: 'draft_saved',
      req,
      changes: {
        previousMarks,
        newMarks: marksObtained,
        version: nextVersion,
        questionCount: validatedQuestionMarks.length,
      },
    });

    res.json({
      success: true,
      evaluation: ev,
      version: nextVersion,
    });
  } catch (err) {
    console.error('Error saving draft:', err);
    res.status(500).json({ message: err.message });
  }
};

// @desc    Finalize evaluation (verifies lock and completeness, marks ready for publication)
// @route   POST /api/evaluations/:id/finalize
// @access  Teacher / Admin
const finalizeEvaluation = async (req, res) => {
  try {
    const { id } = req.params;
    const user = req.user;
    const userId = String(user.id || user._id);
    const userRole = String(user.role || '').toLowerCase();

    const ev = await Evaluation.findOne({
      $or: [{ id }, ...(mongoose.Types.ObjectId.isValid(id) ? [{ _id: id }] : [])]
    });

    if (!ev) {
      return res.status(404).json({ message: 'Evaluation not found' });
    }

    if (!checkTeacherAccess(user, ev.course, ev.branch)) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    // Lock check
    const now = new Date();
    const isLockHolder = Boolean(ev.lockedBy?.userId && String(ev.lockedBy.userId) === userId && new Date(ev.lockedBy.expiresAt) > now);
    if (!isLockHolder && userRole !== 'admin') {
      return res.status(409).json({
        message: 'Exclusive lock required to finalize evaluation.',
        lockedBy: ev.lockedBy
      });
    }

    // Verify complete marks for every question in MarkingScheme
    const examId = String(ev.testId || ev.examId || '');
    const scheme = await MarkingScheme.findOne({ examId });

    if (scheme && Array.isArray(scheme.questions) && scheme.questions.length > 0) {
      const qMarks = Array.isArray(ev.questionMarks) ? ev.questionMarks : [];
      const missing = [];
      for (const sq of scheme.questions) {
        const qNum = String(sq.questionNumber).trim();
        const entry = qMarks.find((qm) => String(qm.questionNumber).trim() === qNum);
        if (!entry || ((entry.marksAwarded === null || entry.marksAwarded === undefined) && !entry.notAttempted)) {
          missing.push(qNum);
        }
      }
      if (missing.length > 0) {
        return res.status(400).json({
          message: `Cannot finalize evaluation: Questions [${missing.join(', ')}] have not been evaluated. All questions must have marks awarded or be marked as not attempted.`
        });
      }
    }

    ev.evaluationStatus = 'evaluated';
    ev.status = 'Evaluated';
    ev.evaluatedBy = userId;
    ev.evaluatedByName = user.name || 'Faculty Member';
    ev.evaluatedAt = new Date();
    ev.version = (ev.version || 0) + 1;
    await ev.save();

    await logAudit({
      targetType: 'Evaluation',
      targetId: ev.id,
      action: 'evaluated',
      req,
      changes: { marksObtained: ev.marksObtained, grade: ev.grade },
    });

    res.json({ success: true, evaluation: ev, message: 'Evaluation finalized and marked ready for publishing' });
  } catch (err) {
    console.error('Error finalizing evaluation:', err);
    res.status(500).json({ message: err.message });
  }
};

// ============================================================================
// 5. VECTOR ANNOTATIONS WITH PAGE/EVALUATION CAPS & DELETION GUARDS
// ============================================================================

// @desc    Add vector annotation to a script page (bounded, capped per-page and per-eval)
// @route   POST /api/evaluations/:id/annotations
// @access  Teacher / Admin
const addAnnotation = async (req, res) => {
  try {
    const { id } = req.params;
    const user = req.user;
    const userId = String(user.id || user._id);
    const userRole = String(user.role || '').toLowerCase();
    const data = req.body || {};

    const ev = await Evaluation.findOne({
      $or: [{ id }, ...(mongoose.Types.ObjectId.isValid(id) ? [{ _id: id }] : [])]
    });

    if (!ev) {
      return res.status(404).json({ message: 'Evaluation not found' });
    }

    if (!checkTeacherAccess(user, ev.course, ev.branch)) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    // Lock check
    const now = new Date();
    const isLockHolder = Boolean(ev.lockedBy?.userId && String(ev.lockedBy.userId) === userId && new Date(ev.lockedBy.expiresAt) > now);
    if (!isLockHolder && userRole !== 'admin') {
      return res.status(409).json({ message: 'Exclusive lock required to create annotations.', lockedBy: ev.lockedBy });
    }

    // Annotation caps: 500 per page, 5000 per evaluation
    const pageNumber = Number(data.pageNumber || 1);
    const pageAnnotCount = await EvaluationAnnotation.countDocuments({ evaluationId: ev.id, pageNumber });
    if (pageAnnotCount >= 500) {
      return res.status(400).json({ message: `Page annotation limit of 500 reached for page ${pageNumber}.` });
    }

    const totalAnnotCount = await EvaluationAnnotation.countDocuments({ evaluationId: ev.id });
    if (totalAnnotCount >= 5000) {
      return res.status(400).json({ message: 'Total evaluation annotation limit of 5000 reached.' });
    }

    const rawCoords = Array.isArray(data.coordinates) ? data.coordinates : [];
    // Enforce bounded vector limit: maximum 1000 points
    if (rawCoords.length > 1000) {
      return res.status(400).json({ message: 'Vector stroke exceeds limit of 1000 points.' });
    }

    // Validate normalized coordinates [0.0, 1.0]
    const hasInvalidCoords = rawCoords.some((pt) => {
      const x = Number(pt.x);
      const y = Number(pt.y);
      return isNaN(x) || isNaN(y) || x < 0 || x > 1 || y < 0 || y > 1;
    });
    if (hasInvalidCoords) {
      return res.status(400).json({ message: 'Vector coordinates must be normalized between 0.0 and 1.0.' });
    }

    const boundedCoords = rawCoords.map((pt) => ({
      x: Number(pt.x),
      y: Number(pt.y),
    }));

    const annotationId = data.id || `ANN-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
    const annotation = await EvaluationAnnotation.create({
      id: annotationId,
      evaluationId: ev.id,
      pageNumber,
      tool: data.tool || 'pen',
      color: data.color || '#ef4444',
      strokeWidth: Number(data.strokeWidth || 2),
      coordinates: boundedCoords,
      content: typeof data.content === 'string' ? data.content.slice(0, 500) : '',
      authorId: userId,
      authorName: user.name || 'Faculty Member',
      authorRole: user.role || 'teacher',
    });

    await logAudit({
      targetType: 'Evaluation',
      targetId: ev.id,
      action: 'marks_modified',
      req,
      changes: { annotationId: annotation.id, tool: annotation.tool, page: annotation.pageNumber },
    });

    res.status(201).json({ success: true, annotation });
  } catch (err) {
    console.error('Error adding annotation:', err);
    res.status(500).json({ message: err.message });
  }
};

// @desc    Delete an annotation (only original author or admin can delete)
// @route   DELETE /api/evaluations/:id/annotations/:annotationId
// @access  Teacher / Admin
const deleteAnnotation = async (req, res) => {
  try {
    const { id, annotationId } = req.params;
    const user = req.user;
    const userId = String(user.id || user._id);
    const userRole = String(user.role || '').toLowerCase();

    const ev = await Evaluation.findOne({
      $or: [{ id }, ...(mongoose.Types.ObjectId.isValid(id) ? [{ _id: id }] : [])]
    });

    if (!ev) {
      return res.status(404).json({ message: 'Evaluation not found' });
    }

    if (!checkTeacherAccess(user, ev.course, ev.branch)) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    // Lock check
    const now = new Date();
    const isLockHolder = Boolean(ev.lockedBy?.userId && String(ev.lockedBy.userId) === userId && new Date(ev.lockedBy.expiresAt) > now);
    if (!isLockHolder && userRole !== 'admin') {
      return res.status(409).json({ message: 'Exclusive lock required to delete annotations.', lockedBy: ev.lockedBy });
    }

    const annotation = await EvaluationAnnotation.findOne({
      evaluationId: ev.id,
      id: annotationId,
    });

    if (!annotation) {
      return res.status(404).json({ message: 'Annotation not found' });
    }

    // Deletion guard: only author or admin can delete
    if (annotation.authorId !== userId && userRole !== 'admin') {
      return res.status(403).json({ message: 'Forbidden: Only the original author or an administrator can delete this annotation.' });
    }

    await EvaluationAnnotation.deleteOne({ _id: annotation._id });

    await logAudit({
      targetType: 'Evaluation',
      targetId: ev.id,
      action: 'annotation_deleted',
      req,
      changes: { annotationId },
    });

    res.json({ success: true, message: 'Annotation removed' });
  } catch (err) {
    console.error('Error deleting annotation:', err);
    res.status(500).json({ message: err.message });
  }
};

// @desc    Get all annotations for an evaluation (teacher/admin)
// @route   GET /api/evaluations/:id/annotations
// @access  Teacher / Admin
const getAnnotations = async (req, res) => {
  try {
    const { id } = req.params;
    const user = req.user;

    const ev = await Evaluation.findOne({
      $or: [{ id }, ...(mongoose.Types.ObjectId.isValid(id) ? [{ _id: id }] : [])]
    });

    if (!ev) {
      return res.status(404).json({ message: 'Evaluation not found' });
    }

    if (!checkTeacherAccess(user, ev.course, ev.branch)) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    const annotations = await EvaluationAnnotation.find({ evaluationId: ev.id }).sort({ pageNumber: 1, createdAt: 1 });
    res.json({ success: true, annotations, count: annotations.length });
  } catch (err) {
    console.error('Error getting annotations:', err);
    res.status(500).json({ message: err.message });
  }
};

// @desc    Student gets annotations for their own published evaluation (strictly trimmed, no internal fields)
// @route   GET /api/evaluations/:id/student-annotations
// @access  Student
const getStudentAnnotations = async (req, res) => {
  try {
    const { id } = req.params;
    const user = req.user;
    const userId = String(user.id || user._id);
    const userEmail = String(user.email || '').toLowerCase().trim();

    const ev = await Evaluation.findOne({
      $or: [{ id }, ...(mongoose.Types.ObjectId.isValid(id) ? [{ _id: id }] : [])]
    });

    if (!ev) {
      return res.status(404).json({ message: 'Evaluation not found' });
    }

    const isOwner = (ev.studentEmail && String(ev.studentEmail).toLowerCase().trim() === userEmail) ||
                    (ev.studentId && String(ev.studentId) === userId);

    if (!isOwner) {
      return res.status(403).json({ message: 'Forbidden: You can only view annotations for your own evaluation.' });
    }

    // Strict student visibility: must be published
    if (!ev.published && !ev.autoGraded) {
      return res.status(403).json({ message: 'Access denied: Evaluation results have not been published yet.' });
    }

    const rawAnnots = await EvaluationAnnotation.find({ evaluationId: ev.id }).sort({ pageNumber: 1, createdAt: 1 });
    const safeAnnots = rawAnnots.map((a) => ({
      id: a.id,
      pageNumber: a.pageNumber,
      tool: a.tool,
      color: a.color,
      strokeWidth: a.strokeWidth,
      coordinates: a.coordinates,
      content: a.content,
      createdAt: a.createdAt,
    }));

    res.json({ success: true, annotations: safeAnnots, count: safeAnnots.length });
  } catch (err) {
    console.error('Error fetching student annotations:', err);
    res.status(500).json({ message: err.message });
  }
};

// ============================================================================
// 6. ATOMIC PUBLISHING (TRANSACTION OR COMPENSATING ROLLBACK)
// ============================================================================

// @desc    Publish single student evaluation
// @route   POST /api/evaluations/:id/publish
// @access  Teacher / Admin
const publishEvaluation = async (req, res) => {
  const { id } = req.params;
  const user = req.user;
  const userId = String(user.id || user._id);
  const userRole = String(user.role || '').toLowerCase();

  const ev = await Evaluation.findOne({
    $or: [{ id }, ...(mongoose.Types.ObjectId.isValid(id) ? [{ _id: id }] : [])]
  });

  if (!ev) {
    return res.status(404).json({ message: 'Evaluation not found' });
  }

  if (!checkTeacherAccess(user, ev.course, ev.branch)) {
    return res.status(403).json({ message: 'Forbidden' });
  }

  // Lock check
  const now = new Date();
  const isLockHolder = Boolean(ev.lockedBy?.userId && String(ev.lockedBy.userId) === userId && new Date(ev.lockedBy.expiresAt) > now);
  if (!isLockHolder && userRole !== 'admin') {
    return res.status(409).json({ message: 'Exclusive lock required to publish evaluation.', lockedBy: ev.lockedBy });
  }

  // Publish rules: must be status 'evaluated' with complete marks
  const validation = await validateEvaluationForPublish(ev);
  if (!validation.valid) {
    return res.status(400).json({ message: validation.reason });
  }

  const publishTimestamp = new Date();
  const publishPayload = {
    published: true,
    evaluationStatus: 'published',
    status: 'Evaluated',
    publishedAt: publishTimestamp,
    publishedBy: userId,
  };

  // Attempt multi-document transaction; fall back to compensating rollback
  let session = null;
  let useTx = false;

  try {
    session = await mongoose.startSession();
    session.startTransaction();
    useTx = true;
  } catch (txStartErr) {
    session = null;
    useTx = false;
  }

  if (useTx && session) {
    try {
      const updatedEval = await Evaluation.findOneAndUpdate(
        { id: ev.id },
        { $set: publishPayload },
        { new: true, session }
      );

      await Submission.findOneAndUpdate(
        {
          $or: [
            { id: ev.id },
            { assignmentId: String(ev.testId || ev.id), studentId: String(ev.studentId || ev.studentEmail) },
            { examId: String(ev.testId || ev.id), studentId: String(ev.studentId || ev.studentEmail) }
          ]
        },
        {
          $set: {
            status: 'graded',
            marksObtained: ev.marksObtained,
            grade: ev.grade,
            percentage: ev.percentage,
          }
        },
        { session }
      );

      await session.commitTransaction();
      session.endSession();

      await logAudit({
        targetType: 'Evaluation',
        targetId: ev.id,
        action: 'published',
        req,
        changes: { publishedAt: publishTimestamp, marks: ev.marksObtained },
      });

      // Dispatch notification
      try {
        await Notification.create({
          userId: ev.studentId || ev.studentEmail,
          title: 'Exam Result Published',
          message: `Your result for ${ev.testTitle || 'Mathematics Examination'} has been published (${ev.marksObtained}/${ev.totalMarks || ev.maxMarks}).`,
          type: 'result_published',
          metadata: { evaluationId: ev.id, testId: ev.testId },
        });
      } catch (_) {}

      return res.json({ success: true, evaluation: updatedEval });
    } catch (txExecErr) {
      await session.abortTransaction();
      session.endSession();
      console.error('Transaction aborted during publish:', txExecErr);
      return res.status(500).json({ message: 'Publishing transaction failed and was rolled back.' });
    }
  }

  // Compensating Rollback Path
  const originalPublished = ev.published;
  const originalStatus = ev.evaluationStatus;

  try {
    const updatedEval = await Evaluation.findOneAndUpdate(
      { id: ev.id },
      { $set: publishPayload },
      { new: true }
    );

    await Submission.findOneAndUpdate(
      {
        $or: [
          { id: ev.id },
          { assignmentId: String(ev.testId || ev.id), studentId: String(ev.studentId || ev.studentEmail) },
          { examId: String(ev.testId || ev.id), studentId: String(ev.studentId || ev.studentEmail) }
        ]
      },
      {
        $set: {
          status: 'graded',
          marksObtained: ev.marksObtained,
          grade: ev.grade,
          percentage: ev.percentage,
        }
      }
    );

    await logAudit({
      targetType: 'Evaluation',
      targetId: ev.id,
      action: 'published',
      req,
      changes: { publishedAt: publishTimestamp, marks: ev.marksObtained },
    });

    try {
      await Notification.create({
        userId: ev.studentId || ev.studentEmail,
        title: 'Exam Result Published',
        message: `Your result for ${ev.testTitle || 'Mathematics Examination'} has been published (${ev.marksObtained}/${ev.totalMarks || ev.maxMarks}).`,
        type: 'result_published',
        metadata: { evaluationId: ev.id, testId: ev.testId },
      });
    } catch (_) {}

    return res.json({ success: true, evaluation: updatedEval });
  } catch (compErr) {
    // Execute compensating rollback
    await Evaluation.findOneAndUpdate(
      { id: ev.id },
      { $set: { published: originalPublished, evaluationStatus: originalStatus } }
    );
    console.error('Compensating rollback triggered during publish:', compErr);
    return res.status(500).json({ message: 'Publishing failed; changes rolled back.' });
  }
};

// @desc    Bulk publish evaluated submissions for an exam cohort
// @route   POST /api/evaluations/bulk-publish
// @access  Teacher / Admin
const bulkPublishEvaluations = async (req, res) => {
  try {
    const user = req.user;
    const { examId, evaluationIds, course, branch } = req.body || {};

    if (!examId && (!Array.isArray(evaluationIds) || evaluationIds.length === 0)) {
      return res.status(400).json({ message: 'examId or evaluationIds array is required for bulk publish.' });
    }

    if (!checkTeacherAccess(user, course, branch)) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    const query = {
      published: false,
    };

    if (examId) {
      query.$or = [{ testId: String(examId) }, { examId: String(examId) }];
    }
    if (Array.isArray(evaluationIds) && evaluationIds.length > 0) {
      query.id = { $in: evaluationIds };
    }

    if (course && course !== 'all') query.course = new RegExp(`^${escapeRegex(course)}$`, 'i');
    if (branch && branch !== 'all') query.branch = new RegExp(`^${escapeRegex(branch)}$`, 'i');

    const candidates = await Evaluation.find(query);
    const toPublish = [];
    const skipped = [];

    for (const candidate of candidates) {
      const validation = await validateEvaluationForPublish(candidate);
      if (validation.valid) {
        toPublish.push(candidate);
      } else {
        skipped.push({
          id: candidate.id,
          studentName: candidate.studentName || 'Student',
          reason: validation.reason,
        });
      }
    }

    if (toPublish.length === 0) {
      return res.json({
        success: true,
        publishedCount: 0,
        skippedCount: skipped.length,
        published: [],
        skipped,
        message: 'No candidate evaluations were eligible for publication.',
      });
    }

    const publishTimestamp = new Date();
    const publishedIds = toPublish.map((e) => e.id);

    // Atomic update
    await Evaluation.updateMany(
      { id: { $in: publishedIds } },
      {
        $set: {
          published: true,
          evaluationStatus: 'published',
          status: 'Evaluated',
          publishedAt: publishTimestamp,
          publishedBy: String(user.id || user._id),
        }
      }
    );

    // Send notifications to published students
    for (const pub of toPublish) {
      try {
        await Notification.create({
          userId: pub.studentId || pub.studentEmail,
          title: 'Exam Result Published',
          message: `Your result for ${pub.testTitle || 'Mathematics Examination'} has been published (${pub.marksObtained}/${pub.totalMarks || pub.maxMarks}).`,
          type: 'result_published',
          metadata: { evaluationId: pub.id, testId: pub.testId },
        });
      } catch (_) {}
    }

    await logAudit({
      targetType: 'Evaluation',
      targetId: String(examId || 'bulk'),
      action: 'published',
      req,
      changes: { bulk: true, examId, publishedCount: publishedIds.length, skippedCount: skipped.length },
    });

    res.json({
      success: true,
      publishedCount: publishedIds.length,
      skippedCount: skipped.length,
      published: toPublish.map((e) => ({ id: e.id, studentName: e.studentName, marksObtained: e.marksObtained })),
      skipped,
      message: `Successfully published ${publishedIds.length} evaluations. Skipped ${skipped.length} incomplete submissions.`,
    });
  } catch (err) {
    console.error('Error bulk publishing evaluations:', err);
    res.status(500).json({ message: err.message });
  }
};

// ============================================================================
// 7. STUDENT RE-EVALUATION DISPUTES
// ============================================================================

// @desc    Student requests re-evaluation on their own published exam (limit 1 request per evaluation)
// @route   POST /api/evaluations/:id/re-evaluate
// @access  Student
const requestReEvaluation = async (req, res) => {
  try {
    const { id } = req.params;
    const user = req.user;
    const userRole = String(user?.role || '').toLowerCase();
    const data = req.body || {};

    if (userRole !== 'student') {
      return res.status(403).json({ message: 'Only students can file re-evaluation requests.' });
    }

    const ev = await Evaluation.findOne({
      $or: [{ id }, ...(mongoose.Types.ObjectId.isValid(id) ? [{ _id: id }] : [])]
    });

    if (!ev) {
      return res.status(404).json({ message: 'Evaluation not found' });
    }

    const sEmail = String(user.email || '').toLowerCase().trim();
    const sId = String(user.id || user._id || '');
    const isOwner = (ev.studentEmail && String(ev.studentEmail).toLowerCase().trim() === sEmail) || (ev.studentId && String(ev.studentId) === sId);

    if (!isOwner) {
      return res.status(403).json({ message: 'You can only request re-evaluation on your own exams.' });
    }

    if (!ev.published && !ev.autoGraded) {
      return res.status(400).json({ message: 'Re-evaluation can only be requested on published results.' });
    }

    if (!data.reason || String(data.reason).trim().length < 10) {
      return res.status(400).json({ message: 'Please provide a clear justification of at least 10 characters.' });
    }

    // Gaps rule 4: One request per evaluation per student
    const existingReq = await ReEvaluationRequest.findOne({
      evaluationId: ev.id,
      studentId: sId,
    });

    if (existingReq) {
      return res.status(409).json({
        message: 'A re-evaluation request has already been submitted for this evaluation. Only one dispute is allowed per exam attempt.',
      });
    }

    const requestId = `REEVAL-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
    const reEval = await ReEvaluationRequest.create({
      id: requestId,
      evaluationId: ev.id,
      testId: String(ev.testId || ev.examId || '1'),
      testTitle: ev.testTitle || ev.examTitle || 'Class Examination',
      studentId: sId,
      studentEmail: sEmail,
      studentName: user.name || ev.studentName || 'Student',
      course: ev.course,
      branch: ev.branch,
      semester: ev.semester || ev.sem,
      questionNumbers: Array.isArray(data.questionNumbers) ? data.questionNumbers : [],
      reason: String(data.reason).slice(0, 1000),
      currentMarks: ev.marksObtained,
      status: 'pending',
      requestedAt: new Date(),
    });

    await logAudit({
      targetType: 'ReEvaluationRequest',
      targetId: reEval.id,
      action: 're_evaluation_requested',
      req,
      changes: { evaluationId: ev.id, questions: reEval.questionNumbers },
    });

    res.status(201).json({ success: true, request: reEval });
  } catch (err) {
    console.error('Error requesting re-evaluation:', err);
    res.status(500).json({ message: err.message });
  }
};

// @desc    Get student's re-evaluation dispute request for an evaluation
// @route   GET /api/evaluations/:id/re-evaluate
// @access  Protected (Student owner / Teacher / Admin)
const getStudentReEvaluationRequest = async (req, res) => {
  try {
    const { id } = req.params;
    const user = req.user;
    const userId = String(user?.id || user?._id || '');
    const userEmail = String(user?.email || '').toLowerCase().trim();
    const userRole = String(user?.role || '').toLowerCase();

    const ev = await Evaluation.findOne({
      $or: [{ id }, ...(mongoose.Types.ObjectId.isValid(id) ? [{ _id: id }] : [])]
    });

    if (!ev) {
      return res.status(404).json({ message: 'Evaluation not found' });
    }

    if (userRole === 'student') {
      const isOwner = (ev.studentEmail && String(ev.studentEmail).toLowerCase().trim() === userEmail) ||
                      (ev.studentId && String(ev.studentId) === userId);
      if (!isOwner) {
        return res.status(403).json({ message: 'Forbidden: You can only view re-evaluation requests for your own evaluation.' });
      }
    } else if (userRole === 'teacher') {
      if (!checkTeacherAccess(user, ev.course, ev.branch)) {
        return res.status(403).json({ message: 'Forbidden' });
      }
    }

    const reEval = await ReEvaluationRequest.findOne({ evaluationId: ev.id }).sort({ requestedAt: -1 });
    res.json({ success: true, request: reEval || null });
  } catch (err) {
    console.error('Error getting re-evaluation request:', err);
    res.status(500).json({ message: err.message });
  }
};

// @desc    Get single re-evaluation dispute request by id (course/branch scoped)
// @route   GET /api/evaluations/re-evaluation-requests/:requestId
// @access  Teacher / Admin
const getReEvaluationRequestById = async (req, res) => {
  try {
    const { requestId } = req.params;
    const user = req.user;

    const reEval = await ReEvaluationRequest.findOne({ id: requestId });
    if (!reEval) {
      return res.status(404).json({ message: 'Re-evaluation request not found' });
    }

    if (!checkTeacherAccess(user, reEval.course, reEval.branch)) {
      return res.status(403).json({ message: 'Forbidden: You cannot access re-evaluation disputes from another course or branch.' });
    }

    res.json({ success: true, request: reEval });
  } catch (err) {
    console.error('Error getting re-evaluation by id:', err);
    res.status(500).json({ message: err.message });
  }
};

// @desc    List all re-evaluation dispute requests for faculty review
// @route   GET /api/evaluations/re-evaluation-requests
// @access  Teacher / Admin
const listReEvaluationRequests = async (req, res) => {
  try {
    const user = req.user;
    const userRole = String(user?.role || '').toLowerCase();
    const query = {};

    if (userRole === 'teacher' && user?.id !== 'master_admin_id') {
      const teacherCourse = user?.targetCourse || user?.course;
      if (teacherCourse) query.course = new RegExp(`^${escapeRegex(teacherCourse)}$`, 'i');
      const teacherBranch = user?.branch || user?.stream;
      if (teacherBranch) query.branch = new RegExp(`^${escapeRegex(teacherBranch)}$`, 'i');
    }

    const requests = await ReEvaluationRequest.find(query).sort({ requestedAt: -1 });
    res.json({ success: true, requests });
  } catch (err) {
    console.error('Error listing re-evaluations:', err);
    res.status(500).json({ message: err.message });
  }
};

// @desc    Resolve a re-evaluation dispute (approve with mark adjustment or reject, within 0..maxMarks)
// @route   PATCH /api/evaluations/re-evaluation-requests/:requestId
// @access  Teacher / Admin
const resolveReEvaluationRequest = async (req, res) => {
  try {
    const { requestId } = req.params;
    const user = req.user;
    const { status, reviewRemarks, resolutionRemarks, marksAdjustment, adjustedMarks } = req.body || {};

    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ message: 'Status must be approved or rejected.' });
    }

    const reEval = await ReEvaluationRequest.findOne({ id: requestId });
    if (!reEval) {
      return res.status(404).json({ message: 'Re-evaluation request not found' });
    }

    if (!checkTeacherAccess(user, reEval.course, reEval.branch)) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    const ev = await Evaluation.findOne({ id: reEval.evaluationId });
    if (!ev) {
      return res.status(404).json({ message: 'Associated evaluation not found' });
    }

    const scheme = await MarkingScheme.findOne({ examId: String(ev.testId || ev.examId || '') });
    const maxMarks = Number(scheme?.totalMarks || ev.totalMarks || ev.maxMarks || 50);

    const oldScore = Number(ev.marksObtained ?? ev.score ?? 0);
    let newScore = oldScore;
    let adj = 0;

    if (status === 'approved') {
      if (adjustedMarks !== undefined) {
        const targetMarks = Number(adjustedMarks);
        if (isNaN(targetMarks) || targetMarks < 0 || targetMarks > maxMarks) {
          return res.status(400).json({ message: `adjustedMarks must be between 0 and ${maxMarks}.` });
        }
        newScore = targetMarks;
        adj = newScore - (ev.marksObtained || 0);
      } else if (marksAdjustment !== undefined) {
        adj = Number(marksAdjustment);
        newScore = oldScore + adj;
        if (newScore < 0 || newScore > maxMarks) {
          return res.status(400).json({ message: `Adjusted total (${newScore}) must be between 0 and ${maxMarks}.` });
        }
      }

      // Decrease rule: dispute resolution cannot decrease student marks unless admin override
      const userRole = String(user?.role || '').toLowerCase();
      const allowDecrease = Boolean(req.body.allowDecrease);
      if (newScore < oldScore) {
        if (userRole !== 'admin' || !allowDecrease) {
          return res.status(400).json({
            message: 'Dispute resolution cannot decrease student marks unless an administrator explicitly enables allowDecrease override.',
            oldMarks: oldScore,
            newMarks: newScore,
            allowDecreaseRequired: true,
          });
        }
      }

      const percentage = maxMarks > 0 ? Math.round((newScore / maxMarks) * 100) : 0;
      const grade = percentage >= 90 ? 'A+' : percentage >= 80 ? 'A' : percentage >= 70 ? 'B+' : percentage >= 60 ? 'B' : percentage >= 40 ? 'C' : 'F';

      ev.marksObtained = newScore;
      ev.marks = newScore;
      ev.score = newScore;
      ev.percentage = percentage;
      ev.grade = grade;
      ev.version = (ev.version || 0) + 1;
      await ev.save();
    }

    reEval.status = status;
    reEval.reviewedBy = String(user.id || user._id);
    reEval.reviewedByName = user.name || 'Faculty Member';
    reEval.reviewRemarks = String(reviewRemarks || resolutionRemarks || '').slice(0, 1000);
    reEval.marksAdjustment = adj;
    reEval.newMarks = newScore;
    reEval.resolvedAt = new Date();
    await reEval.save();

    await logAudit({
      targetType: 'ReEvaluationRequest',
      targetId: reEval.id,
      action: 're_evaluation_resolved',
      req,
      changes: {
        status,
        oldMarks: oldScore,
        newMarks: newScore,
        marksAdjustment: adj,
        allowDecrease: Boolean(req.body.allowDecrease),
      },
    });

    // Notify student
    try {
      await Notification.create({
        userId: reEval.studentId || reEval.studentEmail,
        title: 'Re-Evaluation Resolved',
        message: `Your re-evaluation request for ${reEval.testTitle} has been ${status}. Final marks: ${newScore}/${maxMarks}.`,
        type: 're_evaluation_resolved',
        metadata: { requestId: reEval.id, evaluationId: ev.id, newMarks: newScore },
      });
    } catch (_) {}

    res.json({ success: true, request: reEval, evaluation: ev });
  } catch (err) {
    console.error('Error resolving re-evaluation:', err);
    res.status(500).json({ message: err.message });
  }
};

// ============================================================================
// 8. AUDIT LOGS RETRIEVAL
// ============================================================================

// @desc    Get audit trail for an evaluation
// @route   GET /api/evaluations/:id/audit-logs
// @access  Teacher / Admin
const getAuditLogs = async (req, res) => {
  try {
    const { id } = req.params;
    const user = req.user;

    const ev = await Evaluation.findOne({
      $or: [{ id }, ...(mongoose.Types.ObjectId.isValid(id) ? [{ _id: id }] : [])]
    });

    if (!ev) {
      return res.status(404).json({ message: 'Evaluation not found' });
    }

    if (!checkTeacherAccess(user, ev.course, ev.branch)) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    const logs = await AuditLog.find({ targetId: ev.id }).sort({ timestamp: -1 });
    res.json({ success: true, logs, auditLogs: logs, total: logs.length });
  } catch (err) {
    console.error('Error fetching audit logs:', err);
    res.status(500).json({ message: err.message });
  }
};

// ============================================================================
// 9. SCRIPT PAGES & PRIVATE SCRIPT DELIVERY (MULTI-PAGE & AUTHENTICATED STREAMING)
// ============================================================================

// @desc    Get script page count & types without exposing raw URLs
// @route   GET /api/evaluations/:id/pages
// @access  Protected (Student owner on published / Teacher / Admin)
const getScriptPages = async (req, res) => {
  try {
    const { id } = req.params;
    const user = req.user;
    const userRole = String(user?.role || '').toLowerCase();
    const userId = String(user.id || user._id);
    const userEmail = String(user.email || '').toLowerCase().trim();

    const ev = await Evaluation.findOne({
      $or: [{ id }, ...(mongoose.Types.ObjectId.isValid(id) ? [{ _id: id }] : [])]
    });

    if (!ev) {
      return res.status(404).json({ message: 'Evaluation not found' });
    }

    if (userRole === 'student') {
      const isOwner = (ev.studentEmail && String(ev.studentEmail).toLowerCase().trim() === userEmail) ||
                      (ev.studentId && String(ev.studentId) === userId);
      if (!isOwner) {
        return res.status(403).json({ message: 'Forbidden: You can only view pages for your own evaluation.' });
      }
      if (!ev.published && !ev.autoGraded) {
        return res.status(403).json({ message: 'Access denied: Evaluation results have not been published yet.' });
      }
    } else if (userRole === 'teacher') {
      if (!checkTeacherAccess(user, ev.course, ev.branch)) {
        return res.status(403).json({ message: 'Forbidden: You cannot access evaluations from another course/branch.' });
      }
    }

    const rawPages = Array.isArray(ev.answerPages) && ev.answerPages.length > 0
      ? ev.answerPages
      : [{ pageNumber: 1, fileType: ev.fileType || 'application/pdf' }];

    const safePages = rawPages.map((p, idx) => {
      const pageNum = p.pageNumber || (idx + 1);
      const width = p.width || null;
      const height = p.height || null;
      const aspectRatio = p.aspectRatio || (width && height ? +(width / height).toFixed(4) : null);
      return {
        pageNumber: pageNum,
        fileType: p.fileType || 'application/pdf',
        width,
        height,
        aspectRatio,
      };
    });

    res.json({
      success: true,
      totalPages: safePages.length,
      pages: safePages,
    });
  } catch (err) {
    console.error('Error fetching script pages:', err);
    res.status(500).json({ message: err.message });
  }
};

// @desc    Stream or generate signed URL for private student answer script (supports ?page=N)
// @route   GET /api/evaluations/:id/script-file
// @access  Protected (Student owner on published / Teacher / Admin)
const streamPrivateScript = async (req, res) => {
  try {
    const { id } = req.params;
    const pageParam = req.query.page ? parseInt(req.query.page, 10) : 1;
    const user = req.user;
    if (!user) {
      return res.status(401).json({ message: 'Authentication required' });
    }

    const userRole = String(user?.role || '').toLowerCase();
    const userId = String(user.id || user._id);
    const userEmail = String(user.email || '').toLowerCase().trim();

    const ev = await Evaluation.findOne({
      $or: [{ id }, ...(mongoose.Types.ObjectId.isValid(id) ? [{ _id: id }] : [])]
    });

    if (!ev) {
      return res.status(404).json({ message: 'Evaluation not found' });
    }

    // Role-based authorization
    if (userRole === 'student') {
      const isOwner = (ev.studentEmail && String(ev.studentEmail).toLowerCase().trim() === userEmail) ||
                      (ev.studentId && String(ev.studentId) === userId);
      if (!isOwner) {
        return res.status(403).json({ message: 'Forbidden: You can only view your own answer script.' });
      }
      if (!ev.published && !ev.autoGraded) {
        return res.status(403).json({ message: 'Access denied: Evaluation results have not been published yet.' });
      }
    } else if (userRole === 'teacher') {
      if (!checkTeacherAccess(user, ev.course, ev.branch)) {
        return res.status(403).json({ message: 'Forbidden: You cannot access evaluations from another course/branch.' });
      }
    }

    // Inspect if a specific page exists in answerPages
    let targetFileName = null;
    let targetPublicId = null;

    if (Array.isArray(ev.answerPages) && ev.answerPages.length > 0) {
      const targetPage = ev.answerPages.find((p) => p.pageNumber === pageParam) || ev.answerPages[0];
      if (targetPage) {
        targetFileName = targetPage.fileName || (typeof targetPage === 'string' ? path.basename(targetPage) : null);
        targetPublicId = targetPage.storageKey;
      }
    }

    // 1. Cloudinary Authenticated Mode
    const cloudPublicId = targetPublicId || ev.privatePublicId;
    if (cloudPublicId && !cloudPublicId.startsWith('local_private_')) {
      const signedUrl = generateAuthenticatedScriptUrl(cloudPublicId, 'pdf', 600);
      if (signedUrl) {
        return res.redirect(signedUrl);
      }
    }

    // 2. Local Private Disk Fallback
    const candidateFiles = [
      targetFileName,
      ev.fileName,
      ev.privateScriptUrl ? path.basename(ev.privateScriptUrl) : null,
      ev.answerSheetUrl ? path.basename(ev.answerSheetUrl) : null,
      `${ev.id}.pdf`,
    ].filter(Boolean);

    let targetFilePath = null;
    for (const f of candidateFiles) {
      const p1 = path.join(privateUploadsDir, f);
      if (fs.existsSync(p1)) {
        targetFilePath = p1;
        break;
      }
      const p2 = path.join(uploadsDir, f);
      if (fs.existsSync(p2)) {
        targetFilePath = p2;
        break;
      }
    }

    if (!targetFilePath || !fs.existsSync(targetFilePath)) {
      if (ev.answerSheetDataUrl && ev.answerSheetDataUrl.startsWith('data:')) {
        const base64Data = ev.answerSheetDataUrl.replace(/^data:[^;]+;base64,/, '');
        const buf = Buffer.from(base64Data, 'base64');
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'inline; filename="AnswerScript.pdf"');
        return res.send(buf);
      }
      return res.status(404).json({ message: 'Physical answer script file not found on disk.' });
    }

    const ext = path.extname(targetFilePath).toLowerCase();
    const contentType = ext === '.pdf' ? 'application/pdf' : (ext === '.png' ? 'image/png' : 'image/jpeg');
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `inline; filename="${path.basename(targetFilePath)}"`);
    res.setHeader('Cache-Control', 'private, no-cache, no-store, must-revalidate');

    const fileStream = fs.createReadStream(targetFilePath);
    fileStream.pipe(res);
  } catch (err) {
    console.error('Error streaming script file:', err);
    res.status(500).json({ message: err.message });
  }
};

// ============================================================================
// 10. WORKSPACE LISTINGS: EXAMS & SUBMISSIONS QUEUE
// ============================================================================

// @desc    Get list of distinct exams with evaluation queue counters
// @route   GET /api/evaluations/exams
// @access  Teacher / Admin
const getExamsList = async (req, res) => {
  try {
    const user = req.user;
    const userRole = String(user?.role || '').toLowerCase();
    const query = {};

    if (userRole === 'teacher' && user?.id !== 'master_admin_id') {
      const teacherCourse = user?.targetCourse || user?.course;
      const teacherBranch = user?.branch || user?.stream;
      if (teacherCourse) query.course = new RegExp(`^${escapeRegex(teacherCourse)}$`, 'i');
      if (teacherBranch) query.branch = new RegExp(`^${escapeRegex(teacherBranch)}$`, 'i');
    }

    const evals = await Evaluation.find(query).lean();
    const examMap = {};

    for (const ev of evals) {
      const examId = String(ev.testId || ev.examId || 'unknown');
      if (!examMap[examId]) {
        examMap[examId] = {
          examId,
          examTitle: ev.testTitle || ev.examTitle || 'Class Examination',
          course: ev.course,
          branch: ev.branch,
          semester: ev.semester || ev.sem,
          examType: ev.examType || 'Written / Upload',
          totalSubmissions: 0,
          pendingCount: 0,
          inProgressCount: 0,
          evaluatedCount: 0,
          publishedCount: 0,
        };
      }
      examMap[examId].totalSubmissions++;
      const estatus = ev.evaluationStatus || (ev.published ? 'published' : 'pending');
      if (estatus === 'pending') examMap[examId].pendingCount++;
      else if (estatus === 'in_progress') examMap[examId].inProgressCount++;
      else if (estatus === 'evaluated') examMap[examId].evaluatedCount++;
      else if (estatus === 'published') examMap[examId].publishedCount++;
    }

    const examIds = Object.keys(examMap);
    const schemes = await MarkingScheme.find({ examId: { $in: examIds } }).select('examId').lean();
    const schemeSet = new Set(schemes.map((s) => String(s.examId)));

    const exams = Object.values(examMap).map((e) => ({
      ...e,
      hasMarkingScheme: schemeSet.has(e.examId),
    }));

    res.json({ success: true, count: exams.length, exams });
  } catch (err) {
    console.error('Error fetching exams list:', err);
    res.status(500).json({ message: err.message });
  }
};

// @desc    Get filtered submissions queue for workspace with counters & next unevaluated
// @route   GET /api/evaluations/submissions-queue
// @access  Teacher / Admin
const getSubmissionsQueue = async (req, res) => {
  try {
    const user = req.user;
    const userRole = String(user?.role || '').toLowerCase();
    const {
      examId,
      course,
      branch,
      semester,
      status,
      search,
      page = 1,
      limit = 20,
    } = req.query;

    const baseQuery = {};

    if (userRole === 'teacher' && user?.id !== 'master_admin_id') {
      const teacherCourse = user?.targetCourse || user?.course;
      const teacherBranch = user?.branch || user?.stream;
      if (teacherCourse) baseQuery.course = new RegExp(`^${escapeRegex(teacherCourse)}$`, 'i');
      if (teacherBranch) baseQuery.branch = new RegExp(`^${escapeRegex(teacherBranch)}$`, 'i');
    } else {
      if (course && course !== 'all') baseQuery.course = new RegExp(`^${escapeRegex(course)}$`, 'i');
      if (branch && branch !== 'all') baseQuery.branch = new RegExp(`^${escapeRegex(branch)}$`, 'i');
    }

    if (examId && examId !== 'all') {
      baseQuery.$or = [{ testId: String(examId) }, { examId: String(examId) }];
    }
    if (semester && semester !== 'all') {
      baseQuery.$and = baseQuery.$and || [];
      baseQuery.$and.push({ $or: [{ semester: Number(semester) }, { sem: Number(semester) }, { semester: String(semester) }] });
    }

    const allMatches = await Evaluation.find(baseQuery)
      .select('id testId examId evaluationStatus published marksObtained lockedBy studentName rollNumber studentRoll submittedAt createdAt')
      .lean();

    const now = new Date();
    const counters = {
      total: allMatches.length,
      pending: 0,
      in_progress: 0,
      evaluated: 0,
      published: 0,
      re_evaluation_pending: 0,
    };

    let nextUnevaluatedId = null;

    for (const item of allMatches) {
      const s = item.evaluationStatus || (item.published ? 'published' : 'pending');
      if (s === 'pending') counters.pending++;
      else if (s === 'in_progress') counters.in_progress++;
      else if (s === 'evaluated') counters.evaluated++;
      else if (s === 'published') counters.published++;

      if (!nextUnevaluatedId && (s === 'pending' || s === 'in_progress')) {
        const isLockedByOther = Boolean(
          item.lockedBy?.userId &&
          String(item.lockedBy.userId) !== String(user.id || user._id) &&
          new Date(item.lockedBy.expiresAt) > now
        );
        if (!isLockedByOther) {
          nextUnevaluatedId = item.id;
        }
      }
    }

    if (examId && examId !== 'all') {
      counters.re_evaluation_pending = await ReEvaluationRequest.countDocuments({
        testId: String(examId),
        status: { $in: ['pending', 'under_review'] },
      });
    }

    const filterQuery = { ...baseQuery };
    if (status && status !== 'all') {
      if (status === 'published') {
        filterQuery.published = true;
      } else {
        filterQuery.evaluationStatus = status;
      }
    }

    if (search && String(search).trim()) {
      const sRegex = new RegExp(escapeRegex(String(search).trim()), 'i');
      filterQuery.$and = filterQuery.$and || [];
      filterQuery.$and.push({
        $or: [
          { studentName: sRegex },
          { rollNumber: sRegex },
          { studentRoll: sRegex },
          { studentEmail: sRegex },
        ],
      });
    }

    const p = Math.max(1, parseInt(page, 10));
    const lim = Math.max(1, Math.min(100, parseInt(limit, 10)));
    const skip = (p - 1) * lim;

    const [filteredDocs, totalCount] = await Promise.all([
      Evaluation.find(filterQuery)
        .sort({ submittedAt: 1, createdAt: 1 })
        .skip(skip)
        .limit(lim)
        .lean(),
      Evaluation.countDocuments(filterQuery),
    ]);

    const minimalSubmissions = filteredDocs.map((doc) => {
      const isLocked = Boolean(doc.lockedBy?.userId && new Date(doc.lockedBy.expiresAt) > now);
      return {
        id: doc.id,
        studentName: doc.studentName || 'Student',
        rollNumber: doc.rollNumber || doc.studentRoll || 'N/A',
        examTitle: doc.testTitle || doc.examTitle || 'Class Examination',
        examType: doc.examType || 'Written / Upload',
        status: doc.status || 'Pending Evaluation',
        evaluationStatus: doc.evaluationStatus || (doc.published ? 'published' : 'pending'),
        marksObtained: doc.marksObtained,
        totalMarks: doc.totalMarks || doc.maxMarks || 50,
        pageCount: doc.totalPages || (Array.isArray(doc.answerPages) ? doc.answerPages.length : 1),
        isLocked,
        lockedByName: isLocked ? (doc.lockedBy?.name || 'Another Teacher') : null,
        lockedByUserId: isLocked ? doc.lockedBy?.userId : null,
        submittedAt: doc.submittedAt || doc.createdAt,
      };
    });

    res.json({
      success: true,
      counters,
      nextUnevaluatedId,
      submissions: minimalSubmissions,
      pagination: {
        page: p,
        limit: lim,
        totalCount,
        totalPages: Math.ceil(totalCount / lim),
      },
    });
  } catch (err) {
    console.error('Error fetching submissions queue:', err);
    res.status(500).json({ message: err.message });
  }
};

module.exports = {
  createOrUpdateMarkingScheme,
  getMarkingSchemeByExamId,
  getEvaluationWorkspace,
  acquireOrRefreshLock,
  releaseLock,
  saveEvaluationDraft,
  finalizeEvaluation,
  addAnnotation,
  deleteAnnotation,
  getAnnotations,
  getStudentAnnotations,
  publishEvaluation,
  bulkPublishEvaluations,
  requestReEvaluation,
  getStudentReEvaluationRequest,
  listReEvaluationRequests,
  getReEvaluationRequestById,
  resolveReEvaluationRequest,
  getAuditLogs,
  getScriptPages,
  streamPrivateScript,
  getExamsList,
  getSubmissionsQueue,
};
