const mongoose = require('mongoose');
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
const { uploadBufferToCloudinary } = require('../services/cloudinaryService');

const DAILY_STUDENT_DOUBT_LIMIT = Number(process.env.DAILY_STUDENT_DOUBT_LIMIT) || 5;

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
        // Fetch or read image buffer
        let base64Data = '';
        if (firstAttachment.url.startsWith('data:')) {
          base64Data = firstAttachment.url.split(',')[1];
        } else {
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
        });

        // Record successful query in daily quota
        await DoubtQuota.recordQuery(doubt.student, explanationRes.modelUsed);
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
    if (!studentUser) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

    const {
      topic,
      title,
      questionText,
      latexEquation,
      language = 'en',
      studentNote,
      course,
      branch,
      semester,
      subject = 'Mathematics',
      attachments = [],
    } = req.body || {};

    if (!title && !questionText && (!attachments || attachments.length === 0)) {
      return res.status(400).json({
        success: false,
        message: 'Please provide question text, a mathematical equation, or attach a problem photograph.',
      });
    }

    // 1. Quota Enforcement
    const quotaCheck = await DoubtQuota.canStudentQuery(studentUser._id, DAILY_STUDENT_DOUBT_LIMIT);
    if (!quotaCheck.allowed) {
      return res.status(429).json({
        success: false,
        error: 'STUDENT_QUOTA_EXCEEDED',
        message: `You have reached your daily doubt limit (${quotaCheck.limit} doubts/day). You can escalate directly to your faculty or try again tomorrow.`,
        limit: quotaCheck.limit,
        current: quotaCheck.current,
      });
    }

    // 2. Validate & Secure Attachments
    const processedAttachments = [];
    if (Array.isArray(attachments)) {
      for (const att of attachments) {
        if (!att || (!att.base64Data && !att.url)) continue;

        let buffer = null;
        if (att.base64Data) {
          const rawBase64 = att.base64Data.replace(/^data:[^;]+;base64,/, '');
          buffer = Buffer.from(rawBase64, 'base64');
        }

        if (buffer) {
          // Magic bytes security verification
          const magic = validateImageMagicBytes(buffer);
          if (!magic.valid) {
            return res.status(400).json({
              success: false,
              message: 'Invalid attachment type. Only real JPEG, PNG, WebP or PDF files are accepted.',
            });
          }

          // Strip EXIF / Location metadata
          const sanitizedBuffer = stripExifMetadata(buffer);

          // Upload to secure Cloudinary folder with random unique filename
          try {
            const uploadResult = await uploadBufferToCloudinary(sanitizedBuffer, {
              fileName: `doubt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.jpg`,
              folder: 'as_maths/doubts/private',
              mimeType: magic.mimeType,
            });

            processedAttachments.push({
              url: uploadResult.secure_url,
              publicId: uploadResult.public_id,
              fileName: att.fileName || 'Problem_Snapshot.jpg',
              mimeType: magic.mimeType,
              size: sanitizedBuffer.length,
              storageType: 'cloudinary',
            });
          } catch (uploadErr) {
            console.warn('Cloudinary upload notice (using fallback):', uploadErr.message);
            // In offline environments, save safely as inline data URL
            processedAttachments.push({
              url: `data:${magic.mimeType};base64,${sanitizedBuffer.toString('base64')}`,
              fileName: att.fileName || 'Problem_Snapshot.jpg',
              mimeType: magic.mimeType,
              size: sanitizedBuffer.length,
              storageType: 'local',
            });
          }
        } else if (att.url) {
          processedAttachments.push({
            url: att.url,
            fileName: att.fileName || 'Problem_Image.jpg',
            mimeType: att.mimeType || 'image/jpeg',
            storageType: 'cloudinary',
          });
        }
      }
    }

    const doubtCode = await Doubt.generateDoubtCode();
    const cleanCourse = course || studentUser.targetCourse || studentUser.course || 'Engineering';
    const cleanBranch = branch || studentUser.branch || studentUser.stream || 'CSE';
    const cleanSem = semester || studentUser.semester || 'Semester 1';

    // 3. Create Doubt Record
    const doubt = new Doubt({
      doubtCode,
      student: studentUser._id,
      studentName: studentUser.name || 'Student',
      studentEmail: studentUser.email || '',
      studentRoll: studentUser.studentRoll || studentUser.rollNumber || 'CSE-001',
      course: cleanCourse,
      branch: cleanBranch,
      semester: cleanSem,
      subject,
      topic: topic || 'General Mathematics',
      title: title || questionText?.slice(0, 80) || 'Mathematical Doubt',
      language: language === 'bn' ? 'bn' : 'en',
      status: 'processing',
      attachments: processedAttachments,
      auditTrail: [
        {
          status: 'processing',
          changedBy: studentUser.name || 'Student',
          role: 'student',
          note: 'Doubt submitted. AI job queued.',
        },
      ],
    });

    await doubt.save();

    // 4. Save initial student message
    await DoubtMessage.create({
      doubt: doubt._id,
      authorRole: 'student',
      authorId: studentUser._id,
      authorName: studentUser.name || 'Student',
      messageType: 'student_question',
      contentPlain: questionText || title || '',
      contentLatex: latexEquation || '',
      attachments: processedAttachments.map((a) => ({ url: a.url, fileName: a.fileName, mimeType: a.mimeType })),
    });

    // 5. Asynchronous Background Execution (Render Free-Tier Friendly)
    setImmediate(() => {
      processDoubtJob(doubt._id, 'initial');
    });

    return res.status(202).json({
      success: true,
      message: 'Doubt received. AI tutor is analyzing your problem.',
      doubtId: doubt._id,
      doubtCode: doubt.doubtCode,
      status: 'processing',
    });
  } catch (error) {
    console.error('Error in askDoubt API handler:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @desc    Confirm or edit AI transcription from photograph
 * @route   POST /api/doubts/:id/confirm-transcription
 * @access  Protected (Student Owner)
 */
exports.confirmTranscription = async (req, res) => {
  try {
    const studentUser = req.user;
    const { id } = req.params;
    const { correctedText, correctedLatex } = req.body || {};

    const doubt = await Doubt.findById(id);
    if (!doubt) {
      return res.status(404).json({ success: false, message: 'Doubt not found' });
    }

    if (String(doubt.student) !== String(studentUser._id)) {
      return res.status(403).json({ success: false, message: 'Access denied: You do not own this doubt.' });
    }

    if (correctedText) {
      doubt.aiTranscription.problemText = String(correctedText).trim();
    }
    if (correctedLatex !== undefined) {
      doubt.aiTranscription.latexEquation = String(correctedLatex).trim();
    }

    doubt.aiTranscription.confirmedByUser = true;
    doubt.status = 'processing';
    doubt.auditTrail.push({
      status: 'processing',
      changedBy: studentUser.name,
      role: 'student',
      note: 'Problem transcription confirmed by student. Generating pedagogical explanation.',
    });
    await doubt.save();

    setImmediate(() => {
      processDoubtJob(doubt._id, 'confirmed');
    });

    return res.status(202).json({
      success: true,
      message: 'Transcription confirmed. Generating step-by-step solution.',
      doubtId: doubt._id,
      status: 'processing',
    });
  } catch (error) {
    console.error('Error in confirmTranscription:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @desc    Submit an interactive follow-up question (up to 3 follow-ups)
 * @route   POST /api/doubts/:id/followup
 * @access  Protected (Student Owner)
 */
exports.askFollowup = async (req, res) => {
  try {
    const studentUser = req.user;
    const { id } = req.params;
    const { followupText, stepNumber } = req.body || {};

    if (!followupText || !followupText.trim()) {
      return res.status(400).json({ success: false, message: 'Please enter your follow-up question.' });
    }

    const doubt = await Doubt.findById(id);
    if (!doubt) {
      return res.status(404).json({ success: false, message: 'Doubt not found' });
    }

    if (String(doubt.student) !== String(studentUser._id)) {
      return res.status(403).json({ success: false, message: 'Access denied: You do not own this doubt.' });
    }

    if (doubt.followupCount >= 3) {
      return res.status(400).json({
        success: false,
        message: 'Maximum follow-up limit (3) reached for this doubt. Please escalate to faculty for 1-on-1 personalized review.',
      });
    }

    doubt.followupCount += 1;
    doubt.status = 'processing';
    doubt.auditTrail.push({
      status: 'followup_pending',
      changedBy: studentUser.name,
      role: 'student',
      note: `Follow-up #${doubt.followupCount} asked${stepNumber ? ` on Step ${stepNumber}` : ''}`,
    });
    await doubt.save();

    await DoubtMessage.create({
      doubt: doubt._id,
      authorRole: 'student',
      authorId: studentUser._id,
      authorName: studentUser.name || 'Student',
      messageType: 'followup',
      contentPlain: followupText.trim(),
    });

    setImmediate(() => {
      processDoubtJob(doubt._id, 'followup');
    });

    return res.status(202).json({
      success: true,
      message: 'Follow-up query registered. AI is generating clarification.',
      doubtId: doubt._id,
      status: 'processing',
    });
  } catch (error) {
    console.error('Error in askFollowup:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @desc    Escalate doubt to faculty review queue
 * @route   POST /api/doubts/:id/escalate
 * @access  Protected (Student Owner)
 */
exports.escalateDoubt = async (req, res) => {
  try {
    const studentUser = req.user;
    const { id } = req.params;
    const { reason, priority = 'normal' } = req.body || {};

    const doubt = await Doubt.findById(id);
    if (!doubt) {
      return res.status(404).json({ success: false, message: 'Doubt not found' });
    }

    if (String(doubt.student) !== String(studentUser._id)) {
      return res.status(403).json({ success: false, message: 'Access denied: You do not own this doubt.' });
    }

    doubt.status = 'escalated';
    doubt.priority = ['low', 'normal', 'high'].includes(priority) ? priority : 'normal';
    doubt.escalationReason = reason || 'Student requested faculty review.';
    doubt.escalatedAt = new Date();
    doubt.slaDueAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 Hours SLA
    doubt.unreadByTeacher = true;

    doubt.auditTrail.push({
      status: 'escalated',
      changedBy: studentUser.name,
      role: 'student',
      note: `Escalated to faculty: ${doubt.escalationReason}`,
    });
    await doubt.save();

    // Trigger Notification for Teachers
    try {
      await Notification.create({
        id: `notif_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
        title: 'New Escalated Doubt',
        message: `Student ${studentUser.name} escalated doubt ${doubt.doubtCode} (${doubt.topic}) for faculty review.`,
        type: 'classtest',
        course: doubt.course,
        branch: doubt.branch,
        semester: doubt.semester,
        contentId: String(doubt._id),
      });
    } catch (_) {}

    return res.json({
      success: true,
      message: 'Doubt escalated successfully to faculty queue.',
      doubt,
    });
  } catch (error) {
    console.error('Error in escalateDoubt:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @desc    Mark doubt as resolved
 * @route   POST /api/doubts/:id/resolve
 * @access  Protected (Student Owner or Assigned Faculty)
 */
exports.resolveDoubt = async (req, res) => {
  try {
    const user = req.user;
    const { id } = req.params;

    const doubt = await Doubt.findById(id);
    if (!doubt) {
      return res.status(404).json({ success: false, message: 'Doubt not found' });
    }

    const isStudentOwner = String(doubt.student) === String(user._id);
    const isTeacher = user.role === 'admin' || user.role === 'teacher' || user.id === 'master_admin_id';

    if (!isStudentOwner && !isTeacher) {
      return res.status(403).json({ success: false, message: 'Not authorized to resolve this doubt.' });
    }

    doubt.status = 'resolved';
    doubt.resolvedAt = new Date();
    doubt.resolvedBy = isStudentOwner ? 'student' : 'teacher';
    doubt.auditTrail.push({
      status: 'resolved',
      changedBy: user.name || 'User',
      role: user.role || 'student',
      note: `Marked resolved by ${isStudentOwner ? 'student' : 'faculty'}`,
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
 * @desc    Student reopens doubt (allowed once)
 * @route   POST /api/doubts/:id/reopen
 * @access  Protected (Student Owner)
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

    if (String(doubt.student) !== String(studentUser._id)) {
      return res.status(403).json({ success: false, message: 'Access denied: You do not own this doubt.' });
    }

    if (doubt.reopenCount >= 1) {
      return res.status(400).json({
        success: false,
        message: 'This doubt has already been reopened once. Please ask a new doubt for further questions.',
      });
    }

    doubt.status = 'reopened';
    doubt.reopenCount += 1;
    doubt.unreadByTeacher = true;
    doubt.auditTrail.push({
      status: 'reopened',
      changedBy: studentUser.name,
      role: 'student',
      note: `Reopened: ${message || 'Student requested further clarification.'}`,
    });
    await doubt.save();

    if (message) {
      await DoubtMessage.create({
        doubt: doubt._id,
        authorRole: 'student',
        authorId: studentUser._id,
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
 * @desc    Faculty claims/assigns doubt to self
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

    doubt.status = 'teacher_assigned';
    doubt.assignedTeacher = {
      id: teacherUser._id,
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
 * @desc    Faculty publishes solution to student doubt
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
      authorId: teacherUser._id,
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
        branch: doubt.branch,
        semester: doubt.semester,
        contentId: String(doubt._id),
      });
    } catch (_) {}

    return res.json({
      success: true,
      message: 'Teacher resolution published successfully.',
      doubt,
      messageDoc: replyMsg,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @desc    Get all doubts for the logged-in student
 * @route   GET /api/doubts/my
 * @access  Protected (Student)
 */
exports.getMyDoubts = async (req, res) => {
  try {
    const studentUser = req.user;
    const { status, subject, search } = req.query || {};

    const filter = { student: studentUser._id };
    if (status && status !== 'all') {
      filter.status = status;
    }
    if (subject && subject !== 'all') {
      filter.subject = new RegExp(`^${subject}$`, 'i');
    }
    if (search) {
      const regex = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ title: regex }, { topic: regex }, { doubtCode: regex }];
    }

    const doubts = await Doubt.find(filter).sort({ updatedAt: -1 }).limit(100);
    return res.json({ success: true, count: doubts.length, doubts });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @desc    Get teacher escalation queue with course/branch isolation
 * @route   GET /api/doubts/teacher/queue
 * @access  Protected (Teacher/Admin)
 */
exports.getTeacherQueue = async (req, res) => {
  try {
    const user = req.user;
    const isAdmin = user.role === 'admin' || user.id === 'master_admin_id';
    const { status, priority, subject, search, course, branch } = req.query || {};

    const filter = {};

    // Teacher course/branch isolation
    if (!isAdmin) {
      const assignedCourse = user.targetCourse || user.course;
      const assignedBranch = user.branch || user.stream;
      if (assignedCourse) filter.course = new RegExp(`^${assignedCourse}$`, 'i');
      if (assignedBranch && assignedBranch !== 'All Branches') {
        filter.branch = new RegExp(`^${assignedBranch}$`, 'i');
      }
    } else {
      if (course && course !== 'all') filter.course = new RegExp(`^${course}$`, 'i');
      if (branch && branch !== 'all') filter.branch = new RegExp(`^${branch}$`, 'i');
    }

    if (status && status !== 'all') {
      filter.status = status;
    } else if (!status) {
      // By default show escalated, assigned and reopened tickets in queue
      filter.status = { $in: ['escalated', 'teacher_assigned', 'reopened'] };
    }

    if (priority && priority !== 'all') {
      filter.priority = priority;
    }
    if (subject && subject !== 'all') {
      filter.subject = new RegExp(`^${subject}$`, 'i');
    }
    if (search) {
      const regex = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ title: regex }, { topic: regex }, { doubtCode: regex }, { studentName: regex }];
    }

    const doubts = await Doubt.find(filter).sort({ priority: -1, escalatedAt: -1, createdAt: -1 }).limit(150);

    // Summary counters
    const escalatedCount = await Doubt.countDocuments({ ...filter, status: 'escalated' });
    const assignedCount = await Doubt.countDocuments({ ...filter, status: 'teacher_assigned' });
    const resolvedCount = await Doubt.countDocuments({ ...filter, status: 'resolved' });

    return res.json({
      success: true,
      counts: {
        escalated: escalatedCount,
        assigned: assignedCount,
        resolved: resolvedCount,
        totalInQueue: doubts.length,
      },
      doubts,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @desc    Get doubt detail with threaded conversation history & strict ownership check
 * @route   GET /api/doubts/:id
 * @access  Protected (Student Owner or Authorized Teacher/Admin)
 */
exports.getDoubtById = async (req, res) => {
  try {
    const user = req.user;
    const { id } = req.params;

    const doubt = await Doubt.findById(id);
    if (!doubt) {
      return res.status(404).json({ success: false, message: 'Doubt not found' });
    }

    const isStudentOwner = String(doubt.student) === String(user._id);
    const isTeacher = user.role === 'admin' || user.role === 'teacher' || user.id === 'master_admin_id';

    if (!isStudentOwner && !isTeacher) {
      return res.status(403).json({ success: false, message: 'Access denied: You are not authorized to view this doubt.' });
    }

    // Mark unread flags as read
    if (isStudentOwner && doubt.unreadByStudent) {
      doubt.unreadByStudent = false;
      await doubt.save();
    } else if (isTeacher && doubt.unreadByTeacher) {
      doubt.unreadByTeacher = false;
      await doubt.save();
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
 * @desc    Get student quota & capacity telemetry
 * @route   GET /api/doubts/quota
 * @access  Protected
 */
exports.getQuotaStatus = async (req, res) => {
  try {
    const user = req.user;
    const studentQuota = await DoubtQuota.canStudentQuery(user._id, DAILY_STUDENT_DOUBT_LIMIT);

    let adminTelemetry = null;
    if (user.role === 'admin' || user.id === 'master_admin_id') {
      const todayRecord = await DoubtQuota.getTodayRecord();
      adminTelemetry = {
        date: todayRecord.date,
        totalQueries: todayRecord.totalQueries,
        modelCounts: Object.fromEntries(todayRecord.modelCounts || new Map()),
        studentCount: (todayRecord.studentCounts && todayRecord.studentCounts.size) || 0,
      };
    }

    return res.json({
      success: true,
      quota: {
        limit: studentQuota.limit,
        current: studentQuota.current,
        remaining: studentQuota.remaining,
      },
      adminTelemetry,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
