const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs');
const Doubt = require('../models/Doubt');
const DoubtMessage = require('../models/DoubtMessage');
const DoubtQuota = require('../models/DoubtQuota');
const Notification = require('../models/Notification');
const {
  validateImageMagicBytes,
  stripExifMetadata,
  transcribeProblem,
  explainProblem,
  PRIMARY_EXPLAIN_MODEL,
} = require('../services/aiDoubtService');

const DAILY_STUDENT_DOUBT_LIMIT = Number(process.env.DAILY_STUDENT_DOUBT_LIMIT) || 5;
const SWEEPER_TIMEOUT_MS = Number(process.env.DOUBT_SWEEPER_TIMEOUT_MS) || 5 * 60 * 1000;

/**
 * Sweeps doubts that have been stuck in 'processing' longer than the sweeper timeout (5 minutes).
 * Marks them 'error' with an honest message so the UI never spins forever,
 * and refunds the student's daily quota.
 */
async function sweepStuckDoubtJobs() {
  try {
    const threshold = new Date(Date.now() - SWEEPER_TIMEOUT_MS);
    const stuckDoubts = await Doubt.find({
      status: 'processing',
      updatedAt: { $lt: threshold },
    });

    for (const doubt of stuckDoubts) {
      doubt.status = 'error';
      doubt.lastErrorMessage = `AI processing timed out after ${Math.round(SWEEPER_TIMEOUT_MS / 60000)} minutes. Server may have restarted or experienced network latency.`;
      doubt.auditTrail.push({
        status: 'error',
        changedBy: 'System Sweeper',
        role: 'system',
        note: `Marked as timed out by system sweeper (exceeded ${Math.round(SWEEPER_TIMEOUT_MS / 60000)} minutes in processing).`,
      });
      await doubt.save();
      // Refund quota to student
      await DoubtQuota.rollbackStudentQuota(doubt.student);
    }
    return stuckDoubts.length;
  } catch (err) {
    console.error('Error running sweepStuckDoubtJobs:', err.message);
    return 0;
  }
}

/**
 * Background Asynchronous Worker for AI processing.
 * Runs non-blockingly so Render / Vercel proxy never timeouts.
 */
async function processDoubtJob(doubtId, jobType = 'initial') {
  try {
    const doubt = await Doubt.findById(doubtId);
    if (!doubt) return;

    const hasImages = Array.isArray(doubt.attachments) && doubt.attachments.length > 0;

    if (hasImages && !doubt.aiTranscription?.confirmedByUser && jobType === 'initial') {
      // ── STAGE 1: Problem Transcription for image doubts ──
      try {
        const firstAttachment = doubt.attachments[0];
        let base64Data = '';
        if (firstAttachment.base64Data) {
          base64Data = firstAttachment.base64Data.replace(/^data:[^;]+;base64,/, '');
        } else if (firstAttachment.url && firstAttachment.url.startsWith('data:')) {
          base64Data = firstAttachment.url.split(',')[1];
        } else if (firstAttachment.url) {
          const resp = await fetch(firstAttachment.url);
          const buf = await resp.arrayBuffer();
          base64Data = Buffer.from(buf).toString('base64');
        }

        const transcriptionRes = await transcribeProblem({
          imageBase64: base64Data,
          mimeType: firstAttachment.mimeType || 'image/jpeg',
          studentNote: doubt.title || '',
          topic: doubt.topic || '',
        });

        doubt.aiTranscription = {
          ...transcriptionRes.transcription,
          attempts: transcriptionRes.transcription.attempts || [],
          confirmedByUser: false,
          transcribedAt: new Date(),
        };
        doubt.status = 'transcribed';
        doubt.auditTrail.push({
          status: 'transcribed',
          changedBy: 'AI Transcription Engine',
          role: 'ai',
          note: `Extracted with confidence ${(transcriptionRes.transcription.confidence * 100).toFixed(0)}%`,
        });
        await doubt.save();

        await DoubtMessage.create({
          doubt: doubt._id,
          authorRole: 'ai',
          authorName: 'AI Transcription Engine',
          messageType: 'transcription',
          contentPlain: transcriptionRes.transcription.problemText,
          contentLatex: transcriptionRes.transcription.latexEquation,
          modelUsed: transcriptionRes.transcription.modelUsed,
          attempts: transcriptionRes.transcription.attempts || [],
        });
      } catch (transcribeErr) {
        console.error(`Transcription job failed for doubt ${doubtId}:`, transcribeErr.message);
        doubt.status = 'error';
        doubt.lastErrorMessage = transcribeErr.message;
        doubt.auditTrail.push({
          status: 'error',
          changedBy: 'System',
          role: 'system',
          note: `Transcription error: ${transcribeErr.message}`,
        });
        await doubt.save();
        // Refund quota for failed AI attempt
        await DoubtQuota.rollbackStudentQuota(doubt.student);
      }
    } else {
      // ── STAGE 2: Pedagogical Explanation (Typed doubts or Confirmed image doubts) ──
      try {
        const queryText = doubt.aiTranscription?.problemText || doubt.title;
        const queryLatex = doubt.aiTranscription?.latexEquation || '';

        // Load thread messages for follow-up context if any
        const previousMessages = await DoubtMessage.find({ doubt: doubt._id }).sort({ createdAt: 1 }).limit(10);

        const explanationRes = await explainProblem({
          problemText: queryText,
          latexEquation: queryLatex,
          topic: doubt.topic,
          course: doubt.course,
          language: doubt.language || 'en',
          studentNote: doubt.title !== queryText ? doubt.title : '',
          previousMessages: jobType === 'followup' ? previousMessages : [],
        });

        doubt.aiExplanation = {
          ...explanationRes.explanation,
          modelUsed: explanationRes.modelUsed,
          isFallbackModel: explanationRes.isFallbackModel,
          disclaimer: explanationRes.disclaimer,
          attempts: explanationRes.attempts || [],
          generatedAt: new Date(),
        };
        doubt.status = 'ai_answered';
        doubt.auditTrail.push({
          status: 'ai_answered',
          changedBy: 'AI Pedagogical Tutor',
          role: 'ai',
          note: `Resolved via ${explanationRes.modelUsed} (${explanationRes.isFallbackModel ? 'Fallback Model' : 'Primary Model'})`,
        });
        await doubt.save();

        await DoubtMessage.create({
          doubt: doubt._id,
          authorRole: 'ai',
          authorName: 'AI Pedagogical Tutor',
          messageType: 'explanation',
          contentPlain: explanationRes.explanation.summary || '',
          contentLatex: explanationRes.explanation.finalAnswer || '',
          structuredSteps: explanationRes.explanation.steps || [],
          conceptsUsed: explanationRes.explanation.conceptsUsed || [],
          quickCheck: explanationRes.explanation.quickCheck || '',
          commonMistakes: explanationRes.explanation.commonMistakes || [],
          modelUsed: explanationRes.modelUsed,
          isFallbackModel: explanationRes.isFallbackModel,
          disclaimer: explanationRes.disclaimer,
          attempts: explanationRes.attempts || [],
        });

        // Record successful query in telemetry
        await DoubtQuota.recordSuccessfulQuery(explanationRes.modelUsed);
      } catch (explainErr) {
        console.error(`Explanation job failed for doubt ${doubtId}:`, explainErr.message);
        doubt.status = 'error';
        doubt.lastErrorMessage = explainErr.message;
        doubt.auditTrail.push({
          status: 'error',
          changedBy: 'System',
          role: 'system',
          note: `AI Explanation error: ${explainErr.message}`,
        });
        await doubt.save();
        // Refund quota for failed AI attempt
        await DoubtQuota.rollbackStudentQuota(doubt.student);
      }
    }
  } catch (globalErr) {
    console.error(`Fatal error in processDoubtJob for ${doubtId}:`, globalErr.message);
  }
}

/**
 * @desc    Submit a new student mathematical doubt
 * @route   POST /api/doubts/ask
 * @access  Protected (Student)
 */
exports.askDoubt = async (req, res) => {
  try {
    const studentUser = req.user;
    const studentId = studentUser?.id || studentUser?._id;

    if (!studentId) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

    const {
      title,
      problemText,
      mathLatex,
      whatITried,
      language = 'en',
      academicLevel,
      subject = 'Engineering Mathematics',
      course,
      branch,
      semester,
      chapter,
      topic,
      attachments = [],
    } = req.body || {};

    const effectiveTitle = (problemText || title || '').trim();
    const effectiveLatex = (mathLatex || '').trim();

    // 1. Atomic Quota Reservation
    const quotaCheck = await DoubtQuota.reserveStudentQuota(studentId, DAILY_STUDENT_DOUBT_LIMIT);
    if (!quotaCheck.allowed) {
      return res.status(429).json({
        success: false,
        error: 'STUDENT_QUOTA_EXCEEDED',
        message: `You have reached your daily doubt limit (${quotaCheck.limit} doubts/day). You can escalate directly to your faculty or try again tomorrow.`,
        limit: quotaCheck.limit,
        current: quotaCheck.current,
        canEscalate: true,
      });
    }

    // 2. Validate & Secure Attachments (multipart files + json base64 attachments)
    const processedAttachments = [];
    const filesToProcess = [];

    // Add multipart files if present
    const rawFiles = req.files || (req.file ? [req.file] : []);
    for (const f of rawFiles) {
      if (f.buffer) {
        filesToProcess.push({
          buffer: f.buffer,
          fileName: f.originalname,
          mimeType: f.mimetype,
        });
      }
    }

    // Add JSON attachments
    if (Array.isArray(attachments)) {
      for (const att of attachments) {
        if (!att) continue;
        if (att.base64Data) {
          const rawBase64 = att.base64Data.replace(/^data:[^;]+;base64,/, '');
          filesToProcess.push({
            buffer: Buffer.from(rawBase64, 'base64'),
            fileName: att.fileName || 'Problem_Snapshot.jpg',
            mimeType: att.mimeType,
          });
        }
      }
    }

    // Process all files with magic bytes security check and EXIF stripping
    for (let i = 0; i < filesToProcess.length; i++) {
      const item = filesToProcess[i];
      const magic = validateImageMagicBytes(item.buffer);
      if (!magic.valid) {
        // Rollback reserved quota on validation failure
        await DoubtQuota.rollbackStudentQuota(studentId);
        return res.status(400).json({
          success: false,
          message: 'Invalid attachment type. Only real JPEG, PNG, WebP or PDF files are accepted.',
        });
      }

      // Strip EXIF metadata
      const sanitizedBuffer = stripExifMetadata(item.buffer);

      // Store private attachment data
      processedAttachments.push({
        url: '', // will be set after doubt creation to /api/doubts/:id/attachments/:index
        base64Data: `data:${magic.mimeType};base64,${sanitizedBuffer.toString('base64')}`,
        fileName: item.fileName || `Problem_Snapshot_${i + 1}.jpg`,
        mimeType: magic.mimeType,
        size: sanitizedBuffer.length,
        storageType: 'private_stream',
      });
    }

    // Ensure question has content
    if (!effectiveTitle && !effectiveLatex && processedAttachments.length === 0) {
      await DoubtQuota.rollbackStudentQuota(studentId);
      return res.status(400).json({
        success: false,
        message: 'Please provide question text, LaTeX equations, or upload a photo of the problem.',
      });
    }

    // 3. Create Doubt Record in MongoDB
    const hasImages = processedAttachments.length > 0;
    const doubt = new Doubt({
      student: studentId,
      studentName: studentUser.name || 'Student',
      studentEmail: studentUser.email || '',
      studentRoll: studentUser.rollNumber || '',
      course: course || studentUser.targetCourse || studentUser.course || 'engineering',
      branch: branch || studentUser.branch || studentUser.stream || 'CSE',
      semester: semester || studentUser.semester || 'Semester 1',
      subject: subject || 'Engineering Mathematics',
      chapter: chapter || 'Calculus',
      topic: topic || chapter || 'Higher Mathematics',
      title: effectiveTitle || 'Mathematical Doubt',
      language: language === 'bn' ? 'bn' : 'en',
      academicLevel: academicLevel || {
        course: studentUser.targetCourse || 'engineering',
        stream: studentUser.stream || 'CSE',
        semester: studentUser.semester || 1,
      },
      status: 'processing',
      attachments: processedAttachments,
      aiTranscription: {
        problemText: effectiveTitle,
        latexEquation: effectiveLatex,
        confidence: 1.0,
        confirmedByUser: !hasImages, // Typed doubts are auto-confirmed
      },
      auditTrail: [
        {
          status: 'processing',
          changedBy: studentUser.name || 'Student',
          role: 'student',
          note: hasImages ? 'Submitted photo doubt for transcription' : 'Submitted typed doubt for pedagogical solution',
        },
      ],
    });

    await doubt.save();

    // 4. Record Initial User Message in Thread
    await DoubtMessage.create({
      doubt: doubt._id,
      authorRole: 'student',
      authorId: studentId,
      authorName: studentUser.name || 'Student',
      messageType: 'initial_question',
      contentPlain: effectiveTitle,
      contentLatex: effectiveLatex,
      attachments: doubt.attachments.map((a) => ({ url: a.url, fileName: a.fileName })),
    });

    // 5. Fire Background Worker (Non-blocking HTTP 202)
    setImmediate(() => {
      processDoubtJob(doubt._id, 'initial');
    });

    return res.status(202).json({
      success: true,
      message: hasImages
        ? 'Doubt received. Transcribing handwritten problem...'
        : 'Doubt received. Formulating pedagogical solution...',
      doubtId: doubt._id,
      doubtCode: doubt.doubtCode,
      status: 'processing',
      hasImages,
      remainingQuota: quotaCheck.remaining,
    });
  } catch (error) {
    console.error('Error in askDoubt handler:', error);
    if (req.user?.id || req.user?._id) {
      await DoubtQuota.rollbackStudentQuota(req.user.id || req.user._id);
    }
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @desc    Confirm or edit OCR transcription (Stage 1 -> Stage 2)
 * @route   POST /api/doubts/:id/confirm-transcription
 * @access  Protected (Student)
 */
exports.confirmTranscription = async (req, res) => {
  try {
    const studentUser = req.user;
    const { id } = req.params;
    const { problemText, latexEquation } = req.body || {};

    const doubt = await Doubt.findById(id);
    if (!doubt) {
      return res.status(404).json({ success: false, message: 'Doubt not found' });
    }

    if (String(doubt.student) !== String(studentUser._id || studentUser.id)) {
      return res.status(403).json({ success: false, message: 'Access denied: You do not own this doubt ticket.' });
    }

    doubt.aiTranscription = {
      ...doubt.aiTranscription,
      problemText: (problemText || doubt.aiTranscription?.problemText || doubt.title).trim(),
      latexEquation: (latexEquation || doubt.aiTranscription?.latexEquation || '').trim(),
      confirmedByUser: true,
      confirmedAt: new Date(),
    };
    doubt.status = 'processing';
    doubt.auditTrail.push({
      status: 'processing',
      changedBy: studentUser.name || 'Student',
      role: 'student',
      note: 'Student verified problem transcription. Triggering Stage 2 explanation.',
    });
    await doubt.save();

    setImmediate(() => {
      processDoubtJob(doubt._id, 'explanation');
    });

    return res.status(202).json({
      success: true,
      message: 'Transcription confirmed. Generating step-by-step solution...',
      doubtId: doubt._id,
      status: 'processing',
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @desc    Ask a follow-up question on an existing doubt thread (max 3)
 * @route   POST /api/doubts/:id/followup
 * @access  Protected (Student)
 */
exports.askFollowup = async (req, res) => {
  try {
    const studentUser = req.user;
    const { id } = req.params;
    const { message, mathLatex } = req.body || {};

    if (!message && !mathLatex) {
      return res.status(400).json({ success: false, message: 'Please provide your follow-up question.' });
    }

    const doubt = await Doubt.findById(id);
    if (!doubt) {
      return res.status(404).json({ success: false, message: 'Doubt not found' });
    }

    if (String(doubt.student) !== String(studentUser._id || studentUser.id)) {
      return res.status(403).json({ success: false, message: 'Access denied: You do not own this doubt ticket.' });
    }

    if (doubt.followupCount >= 3) {
      return res.status(400).json({
        success: false,
        message: 'Maximum follow-up limit reached (3 questions). You can now escalate directly to your faculty.',
        canEscalate: true,
      });
    }

    doubt.followupCount += 1;
    doubt.status = 'processing';
    doubt.auditTrail.push({
      status: 'processing',
      changedBy: studentUser.name || 'Student',
      role: 'student',
      note: `Asked follow-up #${doubt.followupCount}`,
    });
    await doubt.save();

    await DoubtMessage.create({
      doubt: doubt._id,
      authorRole: 'student',
      authorId: studentUser._id || studentUser.id,
      authorName: studentUser.name || 'Student',
      messageType: 'followup',
      contentPlain: message || '',
      contentLatex: mathLatex || '',
    });

    setImmediate(() => {
      processDoubtJob(doubt._id, 'followup');
    });

    return res.status(202).json({
      success: true,
      message: 'Follow-up received. Teacher AI is formulating response...',
      followupCount: doubt.followupCount,
      remainingFollowups: 3 - doubt.followupCount,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @desc    Escalate doubt to faculty queue (24-hour SLA guarantee)
 * @route   POST /api/doubts/:id/escalate
 * @access  Protected (Student)
 */
exports.escalateDoubt = async (req, res) => {
  try {
    const studentUser = req.user;
    const { id } = req.params;
    const { reason = 'Needs faculty clarification' } = req.body || {};

    const doubt = await Doubt.findById(id);
    if (!doubt) {
      return res.status(404).json({ success: false, message: 'Doubt not found' });
    }

    if (String(doubt.student) !== String(studentUser._id || studentUser.id)) {
      return res.status(403).json({ success: false, message: 'Access denied: You do not own this doubt ticket.' });
    }

    const slaDeadline = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24-hour SLA
    doubt.status = 'escalated';
    doubt.escalationReason = reason;
    doubt.slaDeadline = slaDeadline;
    doubt.unreadByTeacher = true;
    doubt.auditTrail.push({
      status: 'escalated',
      changedBy: studentUser.name || 'Student',
      role: 'student',
      note: `Escalated to faculty queue: ${reason}`,
    });
    await doubt.save();

    // Create targeted notification for teachers of this course & branch
    try {
      await Notification.create({
        id: `notif_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
        title: 'New Student Doubt Escalated',
        message: `${studentUser.name} escalated doubt ${doubt.doubtCode} (${doubt.topic}) with 24h SLA.`,
        type: 'classtest',
        course: doubt.course,
        targetRole: 'teacher',
        read: false,
      });
    } catch (_) {}

    return res.json({
      success: true,
      message: 'Doubt escalated to faculty queue. SLA guarantee: resolution within 24 hours.',
      doubtCode: doubt.doubtCode,
      slaDeadline,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @desc    Mark doubt as resolved
 * @route   POST /api/doubts/:id/resolve
 * @access  Protected (Student or Teacher)
 */
exports.resolveDoubt = async (req, res) => {
  try {
    const user = req.user;
    const { id } = req.params;

    const doubt = await Doubt.findById(id);
    if (!doubt) {
      return res.status(404).json({ success: false, message: 'Doubt not found' });
    }

    const isStudentOwner = String(doubt.student) === String(user._id || user.id);
    const isTeacher = ['teacher', 'admin'].includes(String(user.role).toLowerCase());

    if (!isStudentOwner && !isTeacher) {
      return res.status(403).json({ success: false, message: 'Access denied.' });
    }

    doubt.status = 'resolved';
    doubt.resolvedAt = new Date();
    doubt.resolvedBy = isStudentOwner ? 'student' : 'teacher';
    doubt.auditTrail.push({
      status: 'resolved',
      changedBy: user.name || 'User',
      role: isStudentOwner ? 'student' : 'teacher',
      note: `Marked as resolved by ${user.name}`,
    });
    await doubt.save();

    return res.json({
      success: true,
      message: 'Doubt marked as resolved.',
      doubt,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @desc    Reopen a resolved doubt (max 1 time)
 * @route   POST /api/doubts/:id/reopen
 * @access  Protected (Student)
 */
exports.reopenDoubt = async (req, res) => {
  try {
    const studentUser = req.user;
    const { id } = req.params;
    const { message } = req.body || {};

    const doubt = await Doubt.findById(id);
    if (!doubt) {
      return res.status(404).json({ success: false, message: 'Doubt not found' });
    }

    if (String(doubt.student) !== String(studentUser._id || studentUser.id)) {
      return res.status(403).json({ success: false, message: 'Access denied: You do not own this doubt ticket.' });
    }

    if (doubt.reopenCount >= 1) {
      return res.status(400).json({
        success: false,
        message: 'This doubt has already been reopened once. Please ask a new doubt for further queries.',
      });
    }

    doubt.reopenCount += 1;
    doubt.status = 'reopened';
    doubt.unreadByTeacher = true;
    doubt.auditTrail.push({
      status: 'reopened',
      changedBy: studentUser.name || 'Student',
      role: 'student',
      note: `Reopened: ${message || 'Student requested further clarification.'}`,
    });
    await doubt.save();

    if (message) {
      await DoubtMessage.create({
        doubt: doubt._id,
        authorRole: 'student',
        authorId: studentUser._id || studentUser.id,
        authorName: studentUser.name,
        messageType: 'followup',
        contentPlain: message,
      });
    }

    return res.json({
      success: true,
      message: 'Doubt reopened. Faculty has been notified.',
      doubt,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @desc    Faculty claims/assigns doubt to self with course/branch isolation
 * @route   POST /api/doubts/:id/claim
 * @access  Protected (Teacher/Admin)
 */
exports.claimDoubt = async (req, res) => {
  try {
    const teacherUser = req.user;
    const { id } = req.params;

    const doubt = await Doubt.findById(id);
    if (!doubt) {
      return res.status(404).json({ success: false, message: 'Doubt not found' });
    }

    const userRole = String(teacherUser?.role || '').toLowerCase();
    // Teacher Course & Branch Isolation (Admins have global visibility)
    if (userRole === 'teacher' && teacherUser.id !== 'master_admin_id') {
      const teacherCourse = teacherUser.targetCourse || teacherUser.course;
      if (teacherCourse && doubt.course && teacherCourse.toLowerCase() !== doubt.course.toLowerCase()) {
        return res.status(403).json({
          success: false,
          message: `Access denied: You are assigned to course "${teacherCourse}" and cannot claim doubts from course "${doubt.course}".`,
        });
      }
      const teacherBranch = teacherUser.branch || teacherUser.stream;
      if (teacherBranch && doubt.branch && teacherBranch.toLowerCase() !== doubt.branch.toLowerCase()) {
        return res.status(403).json({
          success: false,
          message: `Access denied: You are assigned to branch "${teacherBranch}" and cannot claim doubts from branch "${doubt.branch}".`,
        });
      }
    }

    doubt.status = 'teacher_assigned';
    doubt.assignedTeacher = {
      id: teacherUser._id || teacherUser.id,
      name: teacherUser.name || 'Faculty',
      email: teacherUser.email || '',
      assignedAt: new Date(),
    };
    doubt.auditTrail.push({
      status: 'teacher_assigned',
      changedBy: teacherUser.name || 'Faculty',
      role: 'teacher',
      note: `Ticket claimed by faculty ${teacherUser.name}`,
    });
    await doubt.save();

    return res.json({
      success: true,
      message: 'Doubt assigned to you.',
      doubt,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @desc    Faculty publishes verified LaTeX solution to student doubt
 * @route   POST /api/doubts/:id/teacher-reply
 * @access  Protected (Teacher/Admin)
 */
exports.submitTeacherReply = async (req, res) => {
  try {
    const teacherUser = req.user;
    const { id } = req.params;
    const { solutionPlain, solutionLatex, attachments = [], markResolved = true } = req.body || {};

    if (!solutionPlain && !solutionLatex) {
      return res.status(400).json({ success: false, message: 'Please provide solution content or LaTeX equations.' });
    }

    const doubt = await Doubt.findById(id);
    if (!doubt) {
      return res.status(404).json({ success: false, message: 'Doubt not found' });
    }

    const userRole = String(teacherUser?.role || '').toLowerCase();
    if (userRole === 'teacher' && teacherUser.id !== 'master_admin_id') {
      const teacherCourse = teacherUser.targetCourse || teacherUser.course;
      if (teacherCourse && doubt.course && teacherCourse.toLowerCase() !== doubt.course.toLowerCase()) {
        return res.status(403).json({
          success: false,
          message: `Access denied: You cannot submit solutions to doubts outside your assigned course "${teacherCourse}".`,
        });
      }
    }

    doubt.status = markResolved ? 'resolved' : 'teacher_answered';
    doubt.unreadByStudent = true;
    doubt.unreadByTeacher = false;
    if (markResolved) {
      doubt.resolvedAt = new Date();
      doubt.resolvedBy = 'teacher';
    }

    doubt.auditTrail.push({
      status: doubt.status,
      changedBy: teacherUser.name || 'Faculty',
      role: 'teacher',
      note: `Faculty solution published by ${teacherUser.name}`,
    });
    await doubt.save();

    const replyMsg = await DoubtMessage.create({
      doubt: doubt._id,
      authorRole: 'teacher',
      authorId: teacherUser._id || teacherUser.id,
      authorName: teacherUser.name || 'Faculty',
      messageType: 'teacher_reply',
      contentPlain: solutionPlain || '',
      contentLatex: solutionLatex || '',
      attachments: attachments.map((a) => ({ url: a.url, fileName: a.fileName || 'Solution_Attachment.jpg' })),
      isFallbackModel: false,
    });

    // Notify Student
    try {
      await Notification.create({
        id: `notif_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
        title: 'Faculty Answered Your Doubt',
        message: `Faculty ${teacherUser.name} has provided a verified resolution for ${doubt.doubtCode}.`,
        type: 'classtest',
        course: doubt.course,
        targetRole: 'student',
        studentId: String(doubt.student),
        read: false,
      });
    } catch (_) {}

    return res.json({
      success: true,
      message: 'Solution published to student.',
      doubt,
      replyMessage: replyMsg,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @desc    Get student's own doubts
 * @route   GET /api/doubts/my
 * @access  Protected (Student)
 */
exports.getMyDoubts = async (req, res) => {
  try {
    const studentUser = req.user;
    const studentId = studentUser._id || studentUser.id;

    const { status, subject, limit = 20, page = 1 } = req.query;
    const filter = { student: studentId };

    if (status && status !== 'all') {
      filter.status = status;
    }
    if (subject && subject !== 'all') {
      filter.subject = subject;
    }

    const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);
    const doubts = await Doubt.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit, 10));

    const total = await Doubt.countDocuments(filter);

    return res.json({
      success: true,
      doubts,
      pagination: {
        total,
        page: parseInt(page, 10),
        pages: Math.ceil(total / parseInt(limit, 10)),
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @desc    Get faculty review queue (filtered by teacher's course/branch)
 * @route   GET /api/doubts/teacher/queue
 * @access  Protected (Teacher/Admin)
 */
exports.getTeacherQueue = async (req, res) => {
  try {
    const user = req.user;
    const userRole = String(user?.role || '').toLowerCase();
    const { status, priority, limit = 30 } = req.query;

    const filter = {};
    if (status) {
      filter.status = status;
    } else {
      filter.status = { $in: ['escalated', 'teacher_assigned', 'teacher_answered'] };
    }

    if (priority) {
      filter.priority = priority;
    }

    // Teacher course/branch isolation: Admin sees all, teacher sees assigned course
    if (userRole === 'teacher' && user?.id !== 'master_admin_id') {
      const teacherCourse = user?.targetCourse || user?.course;
      if (teacherCourse) {
        filter.course = new RegExp(`^${teacherCourse}$`, 'i');
      }
      const teacherBranch = user?.branch || user?.stream;
      if (teacherBranch) {
        filter.$or = [
          { branch: new RegExp(`^${teacherBranch}$`, 'i') },
          { branch: { $exists: false } },
          { branch: '' },
        ];
      }
    }

    const queue = await Doubt.find(filter)
      .sort({ priority: -1, slaDeadline: 1, createdAt: -1 })
      .limit(parseInt(limit, 10))
      .populate('student', 'name email rollNumber');

    return res.json({
      success: true,
      queue,
      totalCount: queue.length,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @desc    Get full doubt thread with messages and audit trail (owner or faculty only)
 * @route   GET /api/doubts/:id
 * @access  Protected
 */
exports.getDoubtById = async (req, res) => {
  try {
    const { id } = req.params;
    const doubt = await Doubt.findById(id).populate('student', 'name email rollNumber course stream');
    if (!doubt) {
      return res.status(404).json({ success: false, message: 'Doubt not found' });
    }

    const userRole = String(req.user?.role || '').toLowerCase();
    const userId = String(req.user?.id || req.user?._id || '');
    const isOwner = String(doubt.student?._id || doubt.student) === userId;
    const isTeacherOrAdmin = ['admin', 'teacher'].includes(userRole);

    if (!isOwner && !isTeacherOrAdmin) {
      return res.status(403).json({
        success: false,
        message: 'Access denied: You are not authorized to view this doubt.',
      });
    }

    // Stuck job sweeper on status poll: if stuck in processing > sweeper limit, mark as error
    if (doubt.status === 'processing') {
      const threshold = Date.now() - SWEEPER_TIMEOUT_MS;
      if (doubt.updatedAt && new Date(doubt.updatedAt).getTime() < threshold) {
        doubt.status = 'error';
        doubt.lastErrorMessage = `AI processing timed out after ${Math.round(SWEEPER_TIMEOUT_MS / 60000)} minutes. You can retry once or escalate directly to faculty.`;
        doubt.auditTrail.push({
          status: 'error',
          changedBy: 'Polling Sweeper',
          role: 'system',
          note: `Marked as error during status poll (exceeded ${Math.round(SWEEPER_TIMEOUT_MS / 60000)} minutes in processing).`,
        });
        await doubt.save();
        await DoubtQuota.rollbackStudentQuota(doubt.student);
      }
    }

    const messages = await DoubtMessage.find({ doubt: doubt._id }).sort({ createdAt: 1 });

    return res.json({
      success: true,
      doubt,
      messages,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @desc    Serve private authenticated image attachment
 * @route   GET /api/doubts/:id/attachments/:index
 * @access  Protected (Student Owner or Faculty/Admin)
 */
exports.getAttachment = async (req, res) => {
  try {
    const { id, index } = req.params;
    const doubt = await Doubt.findById(id);
    if (!doubt) {
      return res.status(404).json({ success: false, message: 'Doubt not found' });
    }

    const userRole = String(req.user?.role || '').toLowerCase();
    const userId = String(req.user?.id || req.user?._id || '');
    const isOwner = String(doubt.student?._id || doubt.student) === userId;
    const isTeacherOrAdmin = ['admin', 'teacher'].includes(userRole);

    if (!isOwner && !isTeacherOrAdmin) {
      return res.status(403).json({
        success: false,
        message: 'Access denied: You are not authorized to view this attachment.',
      });
    }

    const attIndex = parseInt(index, 10);
    const attachment = doubt.attachments?.[attIndex];
    if (!attachment) {
      return res.status(404).json({ success: false, message: 'Attachment not found' });
    }

    if (attachment.base64Data || attachment.url?.startsWith('data:')) {
      const raw = attachment.base64Data || attachment.url.split(',')[1];
      const buf = Buffer.from(raw, 'base64');
      res.setHeader('Content-Type', attachment.mimeType || 'image/jpeg');
      res.setHeader('Cache-Control', 'private, no-cache, no-store, must-revalidate');
      return res.send(buf);
    }

    return res.status(404).json({ success: false, message: 'Attachment binary not found' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @desc    Get student quota & telemetry status
 * @route   GET /api/doubts/quota
 * @access  Protected
 */
exports.getQuotaStatus = async (req, res) => {
  try {
    const studentUser = req.user;
    const studentId = studentUser._id || studentUser.id;

    const studentQuota = await DoubtQuota.getStudentQuotaStatus(studentId, DAILY_STUDENT_DOUBT_LIMIT);

    return res.json({
      success: true,
      quota: {
        limit: studentQuota.limit,
        used: studentQuota.current,
        remaining: studentQuota.remaining,
        resetsAt: '08:00 UTC (Midnight Pacific Time / 1:30 PM IST)',
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// Export sweeper for server startup
exports.sweepStuckDoubtJobs = sweepStuckDoubtJobs;
