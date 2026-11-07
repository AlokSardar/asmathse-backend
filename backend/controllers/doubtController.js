const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs');
const Doubt = require('../models/Doubt');
const DoubtMessage = require('../models/DoubtMessage');
const DoubtQuota = require('../models/DoubtQuota');
const Notification = require('../models/Notification');
const DoubtTemplate = require('../models/DoubtTemplate');
const DoubtFaq = require('../models/DoubtFaq');
const User = require('../models/User');
const {
  validateImageMagicBytes,
  stripExifMetadata,
  compressImageBuffer,
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

    // Clean abandoned drafts older than 7 days; strictly never touch answered or resolved doubts
    const draftThreshold = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const deletedDrafts = await Doubt.deleteMany({
      status: 'draft',
      createdAt: { $lt: draftThreshold },
    });
    if (deletedDrafts && deletedDrafts.deletedCount > 0) {
      console.log(`🧹 [DOUBT CLEANUP]: Deleted ${deletedDrafts.deletedCount} abandoned drafts older than 7 days.`);
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
        const isQuota429 = String(transcribeErr.message).includes('429') || String(transcribeErr.message).includes('RESOURCE_EXHAUSTED');
        const failType = isQuota429 ? '429' : (String(transcribeErr.message).includes('timed out') ? 'timeout' : '5xx');
        await DoubtQuota.recordFailure(failType).catch(() => {});

        if (isQuota429) {
          const slaDeadline = new Date(Date.now() + 24 * 60 * 60 * 1000);
          doubt.status = 'escalated';
          doubt.priority = 'normal';
          doubt.slaDeadline = slaDeadline;
          doubt.slaDueAt = slaDeadline;
          doubt.escalatedAt = new Date();
          doubt.escalationReason = 'Gemini free-tier quota reached during transcription. Forwarded directly to faculty queue for verified review.';
          doubt.unreadByTeacher = true;
          doubt.auditTrail.push({
            status: 'escalated',
            changedBy: 'System (Quota Fallback)',
            role: 'system',
            note: 'Daily Gemini quota exhausted across models. Forwarded directly to faculty with 24-hour SLA. Zero synthetic answers.',
          });
        } else {
          doubt.status = 'error';
          doubt.lastErrorMessage = transcribeErr.message;
          doubt.auditTrail.push({
            status: 'error',
            changedBy: 'System',
            role: 'system',
            note: `Transcription error: ${transcribeErr.message}`,
          });
        }
        await doubt.save();
        // Refund student AI quota (total daily cap is not refunded)
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
        await DoubtQuota.recordSuccessfulQuery(explanationRes.modelUsed, explanationRes.isFallbackModel);
      } catch (explainErr) {
        console.error(`Explanation job failed for doubt ${doubtId}:`, explainErr.message);
        const isQuota429 = String(explainErr.message).includes('429') || String(explainErr.message).includes('RESOURCE_EXHAUSTED');
        const failType = isQuota429 ? '429' : (String(explainErr.message).includes('timed out') ? 'timeout' : '5xx');
        await DoubtQuota.recordFailure(failType).catch(() => {});

        if (isQuota429) {
          const slaDeadline = new Date(Date.now() + 24 * 60 * 60 * 1000);
          doubt.status = 'escalated';
          doubt.priority = 'normal';
          doubt.slaDeadline = slaDeadline;
          doubt.slaDueAt = slaDeadline;
          doubt.escalatedAt = new Date();
          doubt.escalationReason = 'Gemini free-tier quota reached across all fallback models. Forwarded directly to faculty queue for verified solution.';
          doubt.unreadByTeacher = true;
          doubt.auditTrail.push({
            status: 'escalated',
            changedBy: 'System (Quota Fallback)',
            role: 'system',
            note: 'Daily Gemini free-tier quota exhausted across all models. Escalated directly to faculty queue with 24-hour SLA. Zero synthetic answers.',
          });
        } else {
          doubt.status = 'error';
          doubt.lastErrorMessage = explainErr.message;
          doubt.auditTrail.push({
            status: 'error',
            changedBy: 'System',
            role: 'system',
            note: `AI Explanation error: ${explainErr.message}`,
          });
        }
        await doubt.save();
        // Refund student AI quota (total daily cap is not refunded)
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

    // 0. Atomic Total Daily Cap (Direct-to-faculty + AI, default: 10 per day)
    // Prevents escalation flooding during AI maintenance or direct teacher bursts
    const DAILY_STUDENT_TOTAL_DOUBT_LIMIT = parseInt(process.env.DAILY_STUDENT_TOTAL_DOUBT_LIMIT || '10', 10);
    const totalCheck = await DoubtQuota.reserveTotalStudentLimit(studentId, DAILY_STUDENT_TOTAL_DOUBT_LIMIT);
    if (!totalCheck.allowed) {
      return res.status(429).json({
        success: false,
        error: 'DAILY_TOTAL_LIMIT_EXCEEDED',
        message: `You have reached your daily limit of ${totalCheck.limit} total doubts for today. Our faculty and mentors are working to provide thorough solutions—please review your existing tickets or ask again tomorrow!`,
        limit: totalCheck.limit,
        current: totalCheck.current,
      });
    }

    // 1. Atomic AI Quota Reservation
    const quotaCheck = await DoubtQuota.reserveStudentQuota(studentId, DAILY_STUDENT_DOUBT_LIMIT);
    if (!quotaCheck.allowed) {
      await DoubtQuota.rollbackTotalStudentLimit(studentId);
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

    // Enforce maximum 3 images per doubt
    if (filesToProcess.length > 3) {
      await DoubtQuota.rollbackStudentQuota(studentId);
      await DoubtQuota.rollbackTotalStudentLimit(studentId);
      return res.status(400).json({
        success: false,
        message: 'Maximum 3 images allowed per doubt. Please select at most 3 images.',
      });
    }

    // Process all files with magic bytes security check, EXIF stripping, and compression (~300-500 KB)
    for (let i = 0; i < filesToProcess.length; i++) {
      const item = filesToProcess[i];
      const magic = validateImageMagicBytes(item.buffer);
      if (!magic.valid) {
        // Rollback reserved quota on validation failure
        await DoubtQuota.rollbackStudentQuota(studentId);
        await DoubtQuota.rollbackTotalStudentLimit(studentId);
        return res.status(400).json({
          success: false,
          message: 'Invalid attachment type. Only real JPEG, PNG, WebP or PDF files are accepted.',
        });
      }

      // Strip EXIF metadata
      const sanitizedBuffer = stripExifMetadata(item.buffer);

      // Compress to ~300-500 KB before storing in MongoDB
      let compressedResult;
      try {
        compressedResult = await compressImageBuffer(sanitizedBuffer, magic.mimeType);
      } catch (compErr) {
        await DoubtQuota.rollbackStudentQuota(studentId);
        await DoubtQuota.rollbackTotalStudentLimit(studentId);
        return res.status(400).json({
          success: false,
          message: `Attachment error for "${item.fileName}": ${compErr.message}`,
        });
      }

      if (compressedResult.buffer.length > 512 * 1024) {
        await DoubtQuota.rollbackStudentQuota(studentId);
        await DoubtQuota.rollbackTotalStudentLimit(studentId);
        return res.status(400).json({
          success: false,
          message: `Attachment "${item.fileName}" exceeds maximum allowed size of 500 KB after compression. Please upload a smaller or clearer photo.`,
        });
      }

      // Store private attachment data
      processedAttachments.push({
        url: '', // will be set after doubt creation to /api/doubts/:id/attachments/:index
        base64Data: `data:${compressedResult.mimeType};base64,${compressedResult.buffer.toString('base64')}`,
        fileName: item.fileName || `Problem_Snapshot_${i + 1}.jpg`,
        mimeType: compressedResult.mimeType,
        size: compressedResult.buffer.length,
        storageType: 'private_stream',
      });
    }

    // Ensure question has content
    if (!effectiveTitle && !effectiveLatex && processedAttachments.length === 0) {
      await DoubtQuota.rollbackStudentQuota(studentId);
      await DoubtQuota.rollbackTotalStudentLimit(studentId);
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

    // 5. Check if AI Kill Switch is active (DOUBTS_AI_ENABLED=false), API key is missing, or global capacity reached
    const doubtsApiKey = (process.env.GEMINI_DOUBTS_API_KEY && process.env.GEMINI_DOUBTS_API_KEY.trim()) ||
                         (process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim()) || '';
    const hasApiKey = Boolean(doubtsApiKey);
    const isAiEnabled = process.env.DOUBTS_AI_ENABLED !== 'false' && hasApiKey;

    const GLOBAL_DAILY_AI_REQUEST_CAP = parseInt(process.env.GLOBAL_DAILY_AI_REQUEST_CAP || '40', 10);
    const globalCapStatus = await DoubtQuota.isGlobalAiCapReached(GLOBAL_DAILY_AI_REQUEST_CAP);

    if (!isAiEnabled || globalCapStatus.capReached) {
      // Direct Escalation to Teacher Queue (Bypass AI step entirely; NEVER fabricate answers)
      const slaDeadline = new Date(Date.now() + 24 * 60 * 60 * 1000);
      doubt.status = 'escalated';
      doubt.priority = 'normal';
      doubt.slaDeadline = slaDeadline;
      doubt.slaDueAt = slaDeadline;
      doubt.escalatedAt = new Date();

      if (globalCapStatus.capReached) {
        doubt.escalationReason = `Daily platform AI capacity reached for today (${globalCapStatus.totalCalls}/${globalCapStatus.cap} calls used). Routed directly to your faculty mentor for personal attention.`;
        doubt.auditTrail.push({
          status: 'escalated',
          changedBy: 'Global Capacity Policy Guard',
          role: 'system',
          note: `Global daily AI capacity limit reached (${globalCapStatus.totalCalls}/${globalCapStatus.cap}). Escalated directly to faculty queue with 24-hour SLA. Zero synthetic answers.`,
        });
      } else {
        doubt.escalationReason = !hasApiKey
          ? 'Direct routing to faculty (AI service key unconfigured; never fabricating answers).'
          : 'Direct routing to faculty (AI doubt solver is currently paused via maintenance policy).';
        doubt.auditTrail.push({
          status: 'escalated',
          changedBy: 'System Policy Guard (AI Bypass / Missing Key)',
          role: 'system',
          note: !hasApiKey
            ? 'GEMINI_DOUBTS_API_KEY and GEMINI_API_KEY are missing. Never fabricating answers; routed directly to faculty queue with 24-hour SLA.'
            : 'AI solver disabled via maintenance policy. Routed directly to faculty queue with 24-hour SLA.',
        });
      }
      doubt.unreadByTeacher = true;
      await doubt.save();

      // Refund student AI quota since AI was bypassed (total daily cap remains consumed)
      await DoubtQuota.rollbackStudentQuota(studentId);

      // Create notification for teachers
      try {
        await Notification.create({
          id: `notif_esc_${doubt._id}_${Date.now()}`,
          title: `New Direct Faculty Doubt: ${doubt.doubtCode}`,
          message: `Doubt ${doubt.doubtCode} (${doubt.topic}) was submitted directly to faculty. SLA: 24 hours.`,
          type: 'doubt_escalated',
          course: doubt.course,
          branch: doubt.branch,
          doubtId: doubt._id,
          targetRole: 'teacher',
          isRead: false,
        });
      } catch (_) {}

      return res.status(202).json({
        success: true,
        message: 'AI solver is currently offline. Your question has been forwarded directly to faculty for review within 24 hours.',
        doubtId: doubt._id,
        doubtCode: doubt.doubtCode,
        status: 'escalated',
        hasImages,
        remainingQuota: quotaCheck.remaining + 1,
      });
    }

    // 6. Fire Background Worker (Non-blocking HTTP 202)
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
    doubt.slaDueAt = slaDeadline;
    doubt.escalatedAt = new Date();
    doubt.unreadByTeacher = true;
    doubt.auditTrail.push({
      status: 'escalated',
      changedBy: studentUser.name || 'Student',
      role: 'student',
      note: `Escalated to faculty queue: ${reason}`,
      timestamp: new Date(),
    });
    await doubt.save();

    // Create targeted notification for teachers of this course & branch
    try {
      await Notification.create({
        id: `notif_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
        title: 'New Student Doubt Escalated',
        message: `${studentUser.name} escalated doubt ${doubt.doubtCode} (${doubt.topic}) with 24h SLA.`,
        type: 'doubt_escalation',
        course: doubt.course,
        branch: doubt.branch,
        doubtId: doubt._id,
        targetRole: 'teacher',
        isRead: false,
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
 * @desc    Faculty claims/assigns doubt to self with atomic race-condition guard & course/branch isolation
 * @route   POST /api/doubts/:id/claim
 * @access  Protected (Teacher/Admin)
 */
exports.claimDoubt = async (req, res) => {
  try {
    const teacherUser = req.user;
    const { id } = req.params;
    const teacherId = teacherUser._id || teacherUser.id;
    const userRole = String(teacherUser?.role || '').toLowerCase();

    const doubt = await Doubt.findById(id);
    if (!doubt) {
      return res.status(404).json({ success: false, message: 'Doubt not found' });
    }

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

    // Race-condition proof atomic claim: only claim if unassigned or already claimed by this teacher
    const claimedDoubt = await Doubt.findOneAndUpdate(
      {
        _id: id,
        $or: [
          { 'assignedTeacher.id': { $exists: false } },
          { 'assignedTeacher.id': null },
          { 'assignedTeacher.id': teacherId },
        ],
      },
      {
        $set: {
          status: 'teacher_assigned',
          unreadByTeacher: false,
          assignedTeacher: {
            id: teacherId,
            name: teacherUser.name || 'Faculty',
            email: teacherUser.email || '',
            assignedAt: new Date(),
          },
        },
        $push: {
          auditTrail: {
            status: 'teacher_assigned',
            changedBy: teacherUser.name || 'Faculty',
            role: 'teacher',
            note: `Ticket claimed by faculty ${teacherUser.name}`,
            timestamp: new Date(),
          },
        },
      },
      { new: true }
    );

    if (!claimedDoubt) {
      const fresh = await Doubt.findById(id);
      if (fresh && fresh.assignedTeacher && fresh.assignedTeacher.id) {
        return res.status(409).json({
          success: false,
          message: `Conflict: This ticket has already been claimed by faculty ${fresh.assignedTeacher.name || 'another teacher'}.`,
        });
      }
      return res.status(400).json({
        success: false,
        message: 'Ticket cannot be claimed in its current status.',
      });
    }

    // Notify student that faculty claimed the doubt
    try {
      await Notification.create({
        id: `notif_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
        title: 'Faculty Claimed Your Doubt',
        message: `Faculty ${teacherUser.name} has claimed your doubt ${claimedDoubt.doubtCode} and is reviewing it.`,
        type: 'doubt_claimed',
        course: claimedDoubt.course,
        userId: claimedDoubt.student,
        doubtId: claimedDoubt._id,
        targetRole: 'student',
        isRead: false,
      });
    } catch (_) {}

    return res.json({
      success: true,
      message: 'Doubt assigned to you.',
      doubt: claimedDoubt,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @desc    Faculty unclaims doubt and returns it to the pool
 * @route   POST /api/doubts/:id/unclaim
 * @access  Protected (Assigned Teacher or Admin)
 */
exports.unclaimDoubt = async (req, res) => {
  try {
    const user = req.user;
    const { id } = req.params;
    const doubt = await Doubt.findById(id);
    if (!doubt) {
      return res.status(404).json({ success: false, message: 'Doubt not found' });
    }

    const userId = String(user._id || user.id);
    const assignedId = String(doubt.assignedTeacher?.id || '');
    const isAdmin = String(user.role || '').toLowerCase() === 'admin' || user.id === 'master_admin_id';

    if (assignedId !== userId && !isAdmin) {
      return res.status(403).json({
        success: false,
        message: 'Access denied: Only the assigned faculty or an admin can unclaim this ticket.',
      });
    }

    doubt.status = 'escalated';
    doubt.assignedTeacher = null;
    doubt.auditTrail.push({
      status: 'escalated',
      changedBy: user.name || 'Faculty',
      role: 'teacher',
      note: `Ticket unclaimed by ${user.name} and returned to the faculty pool.`,
      timestamp: new Date(),
    });
    await doubt.save();

    return res.json({
      success: true,
      message: 'Ticket unclaimed and returned to faculty queue.',
      doubt,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @desc    Reassign doubt ticket to another faculty member
 * @route   POST /api/doubts/:id/reassign
 * @access  Protected (Assigned Teacher or Admin)
 */
exports.reassignDoubt = async (req, res) => {
  try {
    const user = req.user;
    const { id } = req.params;
    const { newTeacherId, note } = req.body || {};

    if (!newTeacherId) {
      return res.status(400).json({ success: false, message: 'Please provide newTeacherId for reassignment.' });
    }

    const doubt = await Doubt.findById(id);
    if (!doubt) {
      return res.status(404).json({ success: false, message: 'Doubt not found' });
    }

    const userId = String(user._id || user.id);
    const assignedId = String(doubt.assignedTeacher?.id || '');
    const isAdmin = String(user.role || '').toLowerCase() === 'admin' || user.id === 'master_admin_id';

    if (assignedId && assignedId !== userId && !isAdmin) {
      return res.status(403).json({
        success: false,
        message: 'Access denied: Only the assigned faculty or an admin can reassign this ticket.',
      });
    }

    const targetUser = await User.findById(newTeacherId);
    if (!targetUser || !['teacher', 'admin'].includes(String(targetUser.role || '').toLowerCase())) {
      return res.status(404).json({ success: false, message: 'Target faculty member not found.' });
    }

    doubt.assignedTeacher = {
      id: targetUser._id,
      name: targetUser.name,
      email: targetUser.email,
      assignedAt: new Date(),
    };
    doubt.status = 'teacher_assigned';
    doubt.auditTrail.push({
      status: 'teacher_assigned',
      changedBy: user.name || 'Faculty',
      role: 'teacher',
      note: `Reassigned from ${user.name} to ${targetUser.name}. ${note || ''}`.trim(),
      timestamp: new Date(),
    });
    await doubt.save();

    // Notify new teacher
    try {
      await Notification.create({
        id: `notif_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
        title: 'Doubt Reassigned to You',
        message: `Faculty ${user.name} reassigned doubt ${doubt.doubtCode} to you.`,
        type: 'doubt_assigned',
        course: doubt.course,
        userId: targetUser._id,
        doubtId: doubt._id,
        targetRole: 'teacher',
        isRead: false,
      });
    } catch (_) {}

    return res.json({
      success: true,
      message: `Ticket successfully reassigned to ${targetUser.name}.`,
      doubt,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @desc    Faculty requests clarification from student
 * @route   POST /api/doubts/:id/request-clarification
 * @access  Protected (Assigned Teacher or Admin)
 */
exports.requestClarification = async (req, res) => {
  try {
    const user = req.user;
    const { id } = req.params;
    const { prompt } = req.body || {};

    if (!prompt || !prompt.trim()) {
      return res.status(400).json({ success: false, message: 'Please provide a clarification prompt.' });
    }

    const doubt = await Doubt.findById(id);
    if (!doubt) {
      return res.status(404).json({ success: false, message: 'Doubt not found' });
    }

    const userId = String(user._id || user.id);
    const assignedId = String(doubt.assignedTeacher?.id || '');
    const isAdmin = String(user.role || '').toLowerCase() === 'admin' || user.id === 'master_admin_id';

    if (assignedId && assignedId !== userId && !isAdmin) {
      return res.status(403).json({
        success: false,
        message: 'Access denied: You are not the assigned faculty for this doubt.',
      });
    }

    doubt.status = 'clarification_requested';
    doubt.clarificationPrompt = prompt.trim();
    doubt.clarificationRequestedAt = new Date();
    doubt.unreadByStudent = true;
    doubt.auditTrail.push({
      status: 'clarification_requested',
      changedBy: user.name || 'Faculty',
      role: 'teacher',
      note: `Faculty requested clarification: "${prompt.trim().slice(0, 100)}..."`,
      timestamp: new Date(),
    });
    await doubt.save();

    const msg = await DoubtMessage.create({
      doubt: doubt._id,
      authorRole: 'teacher',
      authorId: user._id || user.id,
      authorName: user.name || 'Faculty',
      messageType: 'clarification_request',
      contentPlain: prompt.trim(),
    });

    // Notify student
    try {
      await Notification.create({
        id: `notif_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
        title: 'Faculty Requested Clarification',
        message: `Faculty ${user.name} needs clarification on your doubt ${doubt.doubtCode}.`,
        type: 'doubt_clarification',
        course: doubt.course,
        userId: doubt.student,
        doubtId: doubt._id,
        targetRole: 'student',
        isRead: false,
      });
    } catch (_) {}

    return res.json({
      success: true,
      message: 'Clarification request sent to student.',
      doubt,
      messageRecord: msg,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @desc    Student responds to faculty clarification request
 * @route   POST /api/doubts/:id/respond-clarification
 * @access  Protected (Student Owner)
 */
exports.respondToClarification = async (req, res) => {
  try {
    const studentUser = req.user;
    const { id } = req.params;
    const { message, mathLatex } = req.body || {};

    if (!message && !mathLatex) {
      return res.status(400).json({ success: false, message: 'Please provide your clarification response.' });
    }

    const doubt = await Doubt.findById(id);
    if (!doubt) {
      return res.status(404).json({ success: false, message: 'Doubt not found' });
    }

    if (String(doubt.student) !== String(studentUser._id || studentUser.id)) {
      return res.status(403).json({ success: false, message: 'Access denied: You do not own this doubt ticket.' });
    }

    doubt.status = 'teacher_assigned';
    doubt.unreadByTeacher = true;
    doubt.clarificationPrompt = '';
    doubt.auditTrail.push({
      status: 'teacher_assigned',
      changedBy: studentUser.name || 'Student',
      role: 'student',
      note: `Student responded to faculty clarification: "${(message || '').slice(0, 100)}..."`,
      timestamp: new Date(),
    });
    await doubt.save();

    const msg = await DoubtMessage.create({
      doubt: doubt._id,
      authorRole: 'student',
      authorId: studentUser._id || studentUser.id,
      authorName: studentUser.name || 'Student',
      messageType: 'clarification_response',
      contentPlain: message || '',
      contentLatex: mathLatex || '',
    });

    // Notify assigned teacher
    if (doubt.assignedTeacher?.id) {
      try {
        await Notification.create({
          id: `notif_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
          title: 'Student Clarification Received',
          message: `${studentUser.name} responded to your clarification request on ${doubt.doubtCode}.`,
          type: 'doubt_clarification_reply',
          course: doubt.course,
          userId: doubt.assignedTeacher.id,
          doubtId: doubt._id,
          targetRole: 'teacher',
          isRead: false,
        });
      } catch (_) {}
    }

    return res.json({
      success: true,
      message: 'Clarification sent to faculty.',
      doubt,
      messageRecord: msg,
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
    const { solutionPlain, solutionLatex, markResolved = true } = req.body || {};

    if (!solutionPlain && !solutionLatex) {
      return res.status(400).json({ success: false, message: 'Please provide solution content or LaTeX equations.' });
    }

    const doubt = await Doubt.findById(id);
    if (!doubt) {
      return res.status(404).json({ success: false, message: 'Doubt not found' });
    }

    const userRole = String(teacherUser?.role || '').toLowerCase();
    const userId = String(teacherUser._id || teacherUser.id);
    const assignedId = String(doubt.assignedTeacher?.id || '');
    const isAdmin = userRole === 'admin' || teacherUser.id === 'master_admin_id';

    // Academic Course & Branch Isolation checks
    if (userRole === 'teacher' && !isAdmin) {
      const teacherCourse = teacherUser.targetCourse || teacherUser.course;
      if (teacherCourse && doubt.course && teacherCourse.toLowerCase() !== doubt.course.toLowerCase()) {
        return res.status(403).json({
          success: false,
          message: `Access denied: You cannot submit solutions to doubts outside your assigned course "${teacherCourse}".`,
        });
      }
      const teacherBranch = teacherUser.branch || teacherUser.stream;
      if (teacherBranch && doubt.branch && teacherBranch.toLowerCase() !== doubt.branch.toLowerCase()) {
        return res.status(403).json({
          success: false,
          message: `Access denied: You are assigned to branch "${teacherBranch}" and cannot submit solutions to doubts from branch "${doubt.branch}".`,
        });
      }
      // Must not publish on a doubt claimed by another teacher
      if (assignedId && assignedId !== userId) {
        return res.status(403).json({
          success: false,
          message: `Access denied: This ticket is currently claimed by faculty ${doubt.assignedTeacher.name || 'another teacher'}.`,
        });
      }
    }

    // Process file attachments if uploaded
    let processedAttachments = [];
    if (req.files && Array.isArray(req.files) && req.files.length > 0) {
      if (req.files.length > 3) {
        return res.status(400).json({ success: false, message: 'Maximum 3 attachments allowed per reply.' });
      }
      for (const file of req.files) {
        const isValid = validateImageMagicBytes(file.buffer);
        if (!isValid) {
          return res.status(400).json({
            success: false,
            message: `File ${file.originalname} has invalid magic bytes or unsupported format. Only JPEG, PNG, WEBP, or PDF allowed.`,
          });
        }
        let finalBuffer = file.buffer;
        let mimeType = file.mimetype || 'image/jpeg';
        if (mimeType.startsWith('image/')) {
          finalBuffer = await stripExifMetadata(finalBuffer);
          finalBuffer = await compressImageBuffer(finalBuffer, 500 * 1024);
        }
        const b64 = finalBuffer.toString('base64');
        processedAttachments.push({
          url: `data:${mimeType};base64,${b64}`,
          fileName: file.originalname || 'Solution_Attachment.jpg',
          mimeType,
          size: finalBuffer.length,
        });
      }
    } else if (Array.isArray(req.body.attachments)) {
      processedAttachments = req.body.attachments.slice(0, 3);
    }

    const willResolve = markResolved === true || markResolved === 'true';
    doubt.status = willResolve ? 'resolved' : 'teacher_answered';
    doubt.unreadByStudent = true;
    doubt.unreadByTeacher = false;
    if (willResolve) {
      doubt.resolvedAt = new Date();
      doubt.resolvedBy = 'teacher';
    }

    doubt.auditTrail.push({
      status: doubt.status,
      changedBy: teacherUser.name || 'Faculty',
      role: 'teacher',
      note: `Faculty solution published by ${teacherUser.name} (${willResolve ? 'marked resolved' : 'pending student review'})`,
      timestamp: new Date(),
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
      attachments: processedAttachments,
      isFallbackModel: false,
    });

    // Notify Student
    try {
      await Notification.create({
        id: `notif_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
        title: 'Faculty Answered Your Doubt',
        message: `Faculty ${teacherUser.name} has provided a verified resolution for ${doubt.doubtCode}.`,
        type: 'doubt_reply',
        course: doubt.course,
        userId: doubt.student,
        doubtId: doubt._id,
        targetRole: 'student',
        isRead: false,
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
 * @desc    Get faculty review queue with comprehensive filters, counters, SLA calculations & course/branch isolation
 * @route   GET /api/doubts/teacher/queue
 * @access  Protected (Teacher/Admin)
 */
exports.getTeacherQueue = async (req, res) => {
  try {
    const user = req.user;
    const userRole = String(user?.role || '').toLowerCase();
    const {
      status = 'all',
      subject = 'all',
      chapter,
      topic,
      branch,
      priority = 'all',
      slaState = 'all',
      search = '',
      assigned = 'all',
      sort = 'oldest',
      page = 1,
      limit = 30,
    } = req.query;

    const filter = {};

    // Filter by status
    if (status && status !== 'all') {
      filter.status = status;
    } else {
      filter.status = {
        $in: ['escalated', 'teacher_assigned', 'teacher_answered', 'clarification_requested', 'reopened', 'resolved'],
      };
    }

    if (subject && subject !== 'all') {
      filter.subject = new RegExp(`^${subject}$`, 'i');
    }

    if (chapter || topic) {
      const term = chapter || topic;
      filter.$or = [
        { topic: new RegExp(term, 'i') },
        { title: new RegExp(term, 'i') },
      ];
    }

    if (priority && priority !== 'all') {
      filter.priority = priority;
    }

    // Teacher course/branch isolation: Admin sees all, teacher sees assigned course & branch
    if (userRole === 'teacher' && user?.id !== 'master_admin_id') {
      const teacherCourse = user?.targetCourse || user?.course;
      if (teacherCourse) {
        filter.course = new RegExp(`^${teacherCourse}$`, 'i');
      }
      const teacherBranch = user?.branch || user?.stream;
      if (teacherBranch) {
        filter.branch = new RegExp(`^${teacherBranch}$`, 'i');
      }
    } else if (branch && branch !== 'all') {
      filter.branch = new RegExp(`^${branch}$`, 'i');
    }

    // Assigned filter
    const userId = user._id || user.id;
    if (assigned === 'mine') {
      filter['assignedTeacher.id'] = userId;
    } else if (assigned === 'unassigned') {
      filter.$and = filter.$and || [];
      filter.$and.push({
        $or: [
          { 'assignedTeacher.id': { $exists: false } },
          { 'assignedTeacher.id': null },
        ],
      });
    }

    // Search query
    if (search && search.trim()) {
      const term = search.trim();
      const searchRegex = new RegExp(term, 'i');
      const searchCond = [
        { doubtCode: searchRegex },
        { title: searchRegex },
        { topic: searchRegex },
        { studentName: searchRegex },
        { studentRoll: searchRegex },
      ];
      if (filter.$or) {
        filter.$and = filter.$and || [];
        filter.$and.push({ $or: searchCond });
      } else {
        filter.$or = searchCond;
      }
    }

    // Sort order
    let sortObj = { createdAt: 1 }; // Oldest first default
    if (sort === 'newest') sortObj = { createdAt: -1 };
    else if (sort === 'sla') sortObj = { slaDeadline: 1, slaDueAt: 1, createdAt: 1 };
    else if (sort === 'priority') sortObj = { priority: -1, createdAt: 1 };

    const skip = (Math.max(1, parseInt(page, 10)) - 1) * parseInt(limit, 10);

    const allMatched = await Doubt.find(filter)
      .sort(sortObj)
      .populate('student', 'name email rollNumber course stream');

    const now = Date.now();
    // Enrich with SLA fields & filter by SLA state
    const enriched = allMatched.map((doc) => {
      const d = doc.toObject();
      const deadline = d.slaDeadline || d.slaDueAt || (d.escalatedAt ? new Date(new Date(d.escalatedAt).getTime() + 24 * 3600 * 1000) : new Date(new Date(d.createdAt).getTime() + 24 * 3600 * 1000));
      const remainingMs = new Date(deadline).getTime() - now;
      const isBreached = remainingMs <= 0 && !['resolved', 'closed'].includes(d.status);
      const isDueSoon = remainingMs > 0 && remainingMs < 4 * 3600 * 1000 && !['resolved', 'closed'].includes(d.status);
      const computedSlaState = isBreached ? 'breached' : (isDueSoon ? 'due_soon' : 'on_time');

      d.slaDeadline = deadline;
      d.slaRemainingMs = remainingMs;
      d.isBreached = isBreached;
      d.isDueSoon = isDueSoon;
      d.slaState = computedSlaState;
      return d;
    });

    let finalFiltered = enriched;
    if (slaState && slaState !== 'all') {
      finalFiltered = enriched.filter((d) => d.slaState === slaState);
    }

    // Global summary counters across scoped doubts (unfiltered by view filters)
    const scopeFilter = {};
    if (userRole === 'teacher' && user?.id !== 'master_admin_id') {
      const teacherCourse = user?.targetCourse || user?.course;
      if (teacherCourse) scopeFilter.course = new RegExp(`^${teacherCourse}$`, 'i');
      const teacherBranch = user?.branch || user?.stream;
      if (teacherBranch) scopeFilter.branch = new RegExp(`^${teacherBranch}$`, 'i');
    }
    const allScoped = await Doubt.find({
      ...scopeFilter,
      status: { $in: ['escalated', 'teacher_assigned', 'teacher_answered', 'clarification_requested', 'reopened', 'resolved'] },
    });

    const counters = {
      total: allScoped.length,
      escalated: allScoped.filter((d) => d.status === 'escalated').length,
      teacher_assigned: allScoped.filter((d) => d.status === 'teacher_assigned').length,
      teacher_answered: allScoped.filter((d) => d.status === 'teacher_answered').length,
      reopened: allScoped.filter((d) => d.status === 'reopened').length,
      resolved: allScoped.filter((d) => d.status === 'resolved').length,
      unassigned: allScoped.filter((d) => !d.assignedTeacher?.id && ['escalated', 'reopened'].includes(d.status)).length,
      assignedToMe: allScoped.filter((d) => d.assignedTeacher?.id && String(d.assignedTeacher.id) === String(userId)).length,
      dueSoon: 0,
      breached: 0,
    };

    allScoped.forEach((d) => {
      if (['resolved', 'closed'].includes(d.status)) return;
      const dl = d.slaDeadline || d.slaDueAt || new Date(new Date(d.createdAt).getTime() + 24 * 3600 * 1000);
      const rem = new Date(dl).getTime() - now;
      if (rem <= 0) counters.breached += 1;
      else if (rem < 4 * 3600 * 1000) counters.dueSoon += 1;
    });

    const paginated = finalFiltered.slice(skip, skip + parseInt(limit, 10));

    return res.json({
      success: true,
      queue: paginated,
      counters,
      pagination: {
        total: finalFiltered.length,
        page: parseInt(page, 10),
        pages: Math.ceil(finalFiltered.length / parseInt(limit, 10)),
        limit: parseInt(limit, 10),
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @desc    Get full doubt thread with messages and audit trail (owner or faculty in scope only)
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

    // Course and branch isolation for teachers
    if (userRole === 'teacher' && req.user.id !== 'master_admin_id') {
      const teacherCourse = req.user.targetCourse || req.user.course;
      if (teacherCourse && doubt.course && teacherCourse.toLowerCase() !== doubt.course.toLowerCase()) {
        return res.status(403).json({
          success: false,
          message: `Access denied: You are assigned to course "${teacherCourse}" and cannot view doubts from course "${doubt.course}".`,
        });
      }
      const teacherBranch = req.user.branch || req.user.stream;
      if (teacherBranch && doubt.branch && teacherBranch.toLowerCase() !== doubt.branch.toLowerCase()) {
        return res.status(403).json({
          success: false,
          message: `Access denied: You are assigned to branch "${teacherBranch}" and cannot view doubts from branch "${doubt.branch}".`,
        });
      }
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
 * @access  Protected (Student Owner or Faculty/Admin in scope)
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

    if (userRole === 'teacher' && req.user.id !== 'master_admin_id') {
      const teacherCourse = req.user.targetCourse || req.user.course;
      if (teacherCourse && doubt.course && teacherCourse.toLowerCase() !== doubt.course.toLowerCase()) {
        return res.status(403).json({
          success: false,
          message: `Access denied: You are not authorized to view attachments outside your course "${teacherCourse}".`,
        });
      }
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
 * @desc    Get faculty saved reply templates
 * @route   GET /api/doubts/templates
 * @access  Protected (Teacher/Admin)
 */
exports.getTemplates = async (req, res) => {
  try {
    const teacherId = req.user._id || req.user.id;
    const templates = await DoubtTemplate.find({ teacher: teacherId }).sort({ createdAt: -1 });
    return res.json({ success: true, templates });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * @desc    Create a new saved reply template
 * @route   POST /api/doubts/templates
 * @access  Protected (Teacher/Admin)
 */
exports.createTemplate = async (req, res) => {
  try {
    const teacherId = req.user._id || req.user.id;
    const { title, category = 'General', contentPlain = '', contentLatex = '' } = req.body || {};
    if (!title || !title.trim()) {
      return res.status(400).json({ success: false, message: 'Template title is required.' });
    }
    const template = await DoubtTemplate.create({
      teacher: teacherId,
      title: title.trim(),
      category: category.trim(),
      contentPlain: contentPlain.trim(),
      contentLatex: contentLatex.trim(),
    });
    return res.json({ success: true, message: 'Template saved.', template });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * @desc    Delete a saved reply template
 * @route   DELETE /api/doubts/templates/:id
 * @access  Protected (Teacher/Admin)
 */
exports.deleteTemplate = async (req, res) => {
  try {
    const teacherId = req.user._id || req.user.id;
    const { id } = req.params;
    const deleted = await DoubtTemplate.findOneAndDelete({ _id: id, teacher: teacherId });
    if (!deleted) {
      return res.status(404).json({ success: false, message: 'Template not found or not owned by you.' });
    }
    return res.json({ success: true, message: 'Template deleted.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * @desc    Get user notifications with SLA breach checks
 * @route   GET /api/doubts/notifications
 * @access  Protected
 */
exports.getDoubtNotifications = async (req, res) => {
  try {
    const user = req.user;
    const userId = user._id || user.id;
    const userRole = String(user.role || '').toLowerCase();

    // Background SLA breach detection: if unresolved doubt has passed deadline, alert assigned teacher & admin
    const now = new Date();
    const breachedDoubts = await Doubt.find({
      status: { $in: ['escalated', 'teacher_assigned', 'reopened', 'clarification_requested'] },
      $or: [
        { slaDeadline: { $lt: now } },
        { slaDueAt: { $lt: now } },
      ],
    });

    for (const d of breachedDoubts) {
      const existingBreachNotif = await Notification.findOne({
        doubtId: d._id,
        type: 'doubt_sla_breach',
      });
      if (!existingBreachNotif) {
        const targets = [];
        if (d.assignedTeacher?.id) targets.push(d.assignedTeacher.id);
        targets.push('master_admin_id');

        for (const tId of targets) {
          try {
            await Notification.create({
              id: `notif_breach_${d._id}_${Date.now()}`,
              title: `SLA Breached: ${d.doubtCode}`,
              message: `Doubt ${d.doubtCode} (${d.topic}) has breached its 24-hour SLA deadline. Immediate action required.`,
              type: 'doubt_sla_breach',
              course: d.course,
              branch: d.branch,
              userId: tId,
              doubtId: d._id,
              targetRole: 'teacher',
              isRead: false,
            });
          } catch (_) {}
        }
      }
    }

    // Query notifications for this user
    const query = {
      $or: [
        { userId: userId },
        { userId: String(userId) },
      ],
    };

    if (['teacher', 'admin'].includes(userRole)) {
      const teacherCourse = user.targetCourse || user.course;
      const roleQuery = { targetRole: 'teacher', userId: { $exists: false } };
      if (userRole === 'teacher' && teacherCourse) {
        roleQuery.course = new RegExp(`^${teacherCourse}$`, 'i');
      }
      query.$or.push(roleQuery);
    }

    const notifications = await Notification.find(query)
      .sort({ createdAt: -1 })
      .limit(40);

    const unreadCount = notifications.filter((n) => !n.isRead && !n.readAt).length;

    return res.json({
      success: true,
      notifications,
      unreadCount,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * @desc    Mark single notification as read
 * @route   PUT /api/doubts/notifications/:id/read
 * @access  Protected
 */
exports.markDoubtNotificationRead = async (req, res) => {
  try {
    const { id } = req.params;
    const notif = await Notification.findOneAndUpdate(
      { $or: [{ _id: mongoose.Types.ObjectId.isValid(id) ? id : null }, { id }] },
      { $set: { isRead: true, readAt: new Date() } },
      { new: true }
    );
    if (!notif) {
      return res.status(404).json({ success: false, message: 'Notification not found' });
    }
    return res.json({ success: true, notification: notif });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * @desc    Mark all user notifications as read
 * @route   PUT /api/doubts/notifications/read-all
 * @access  Protected
 */
exports.markAllDoubtNotificationsRead = async (req, res) => {
  try {
    const userId = req.user._id || req.user.id;
    await Notification.updateMany(
      {
        $or: [
          { userId },
          { userId: String(userId) },
        ],
        isRead: false,
      },
      { $set: { isRead: true, readAt: new Date() } }
    );
    return res.json({ success: true, message: 'All notifications marked as read.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
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

/**
 * @desc    Get comprehensive Doubt Escalator analytics (metrics, topics, SLA)
 * @route   GET /api/doubts/analytics/overview
 * @access  Protected (Teacher - Course/Branch Scoped, Admin - Global)
 */
exports.getAnalyticsOverview = async (req, res) => {
  try {
    const user = req.user;
    const userRole = String(user.role || '').toLowerCase();
    const isAdmin = userRole === 'admin' || user.id === 'master_admin_id';
    const isTeacher = !isAdmin;

    const filter = {};
    if (isTeacher) {
      const tCourse = user.targetCourse || user.course;
      const tBranch = user.branch;
      if (tCourse) filter.course = new RegExp(`^${tCourse}$`, 'i');
      if (tBranch) filter.branch = new RegExp(`^${tBranch}$`, 'i');
    } else {
      if (req.query.course) filter.course = new RegExp(`^${req.query.course}$`, 'i');
      if (req.query.branch) filter.branch = new RegExp(`^${req.query.branch}$`, 'i');
    }

    if (req.query.subject) filter.subject = new RegExp(`^${req.query.subject}$`, 'i');
    if (req.query.semester) filter.semester = req.query.semester;

    if (req.query.startDate || req.query.endDate) {
      filter.createdAt = {};
      if (req.query.startDate) filter.createdAt.$gte = new Date(req.query.startDate);
      if (req.query.endDate) {
        const endD = new Date(req.query.endDate);
        endD.setHours(23, 59, 59, 999);
        filter.createdAt.$lte = endD;
      }
    }

    const doubts = await Doubt.find(filter).lean();
    const totalDoubts = doubts.length;

    if (totalDoubts === 0) {
      return res.json({
        success: true,
        metrics: {
          totalDoubts: 0,
          aiResolvedCount: 0,
          aiResolvedRate: 0,
          escalatedCount: 0,
          escalatedRate: 0,
          avgTimeToAiAnswerMs: 0,
          medianTimeToAiAnswerMs: 0,
          avgTeacherResponseTimeMs: 0,
          slaBreachCount: 0,
          slaBreachRate: 0,
          reopenCount: 0,
          reopenRate: 0,
          studentSatisfactionRate: 100,
          totalRatings: 0,
          averageRating: 0,
        },
        mostConfusingTopics: [],
        statusDistribution: {},
        scope: {
          role: userRole,
          course: isTeacher ? (user.targetCourse || user.course || 'All') : (req.query.course || 'All'),
          branch: isTeacher ? (user.branch || 'All') : (req.query.branch || 'All'),
        },
      });
    }

    // 1. Resolution & Escalation Rates
    const aiResolvedDoubts = doubts.filter(
      (d) => (d.status === 'resolved' || d.status === 'ai_answered') && !d.escalatedAt && !d.assignedTeacher?.id
    );
    const escalatedDoubts = doubts.filter(
      (d) => d.escalatedAt || ['escalated', 'teacher_assigned', 'teacher_answered', 'clarification_requested'].includes(d.status)
    );

    const aiResolvedCount = aiResolvedDoubts.length;
    const escalatedCount = escalatedDoubts.length;
    const aiResolvedRate = Number(((aiResolvedCount / totalDoubts) * 100).toFixed(1));
    const escalatedRate = Number(((escalatedCount / totalDoubts) * 100).toFixed(1));

    // 2. Time to First AI Answer
    const aiTimes = doubts
      .filter((d) => d.aiExplanation?.generatedAt && d.createdAt)
      .map((d) => new Date(d.aiExplanation.generatedAt).getTime() - new Date(d.createdAt).getTime())
      .filter((t) => t > 0);

    let avgTimeToAiAnswerMs = 0;
    let medianTimeToAiAnswerMs = 0;
    if (aiTimes.length > 0) {
      avgTimeToAiAnswerMs = Math.round(aiTimes.reduce((a, b) => a + b, 0) / aiTimes.length);
      aiTimes.sort((a, b) => a - b);
      const mid = Math.floor(aiTimes.length / 2);
      medianTimeToAiAnswerMs =
        aiTimes.length % 2 === 0
          ? Math.round((aiTimes[mid - 1] + aiTimes[mid]) / 2)
          : aiTimes[mid];
    }

    // 3. Teacher Response Time
    const teacherTimes = [];
    for (const d of escalatedDoubts) {
      const escEntry = (d.auditTrail || []).find((a) => a.status === 'escalated');
      const ansEntry = (d.auditTrail || []).find((a) => a.status === 'teacher_answered');
      if (escEntry && ansEntry) {
        const diff = new Date(ansEntry.timestamp).getTime() - new Date(escEntry.timestamp).getTime();
        if (diff > 0) teacherTimes.push(diff);
      }
    }
    const avgTeacherResponseTimeMs =
      teacherTimes.length > 0
        ? Math.round(teacherTimes.reduce((a, b) => a + b, 0) / teacherTimes.length)
        : 0;

    // 4. SLA Breach Count and Rate
    const now = new Date();
    const breachedDoubts = escalatedDoubts.filter((d) => {
      if (!d.slaDeadline) return false;
      const ansEntry = (d.auditTrail || []).find((a) => a.status === 'teacher_answered');
      const resEntry = (d.auditTrail || []).find((a) => a.status === 'resolved');
      const compareTime = ansEntry ? new Date(ansEntry.timestamp) : (resEntry ? new Date(resEntry.timestamp) : now);
      return compareTime > new Date(d.slaDeadline);
    });
    const slaBreachCount = breachedDoubts.length;
    const slaBreachRate = escalatedCount > 0 ? Number(((slaBreachCount / escalatedCount) * 100).toFixed(1)) : 0;

    // 5. Reopen Rate
    const reopenedDoubts = doubts.filter(
      (d) => (d.reopenCount && d.reopenCount > 0) || (d.auditTrail || []).some((a) => a.status === 'reopened')
    );
    const reopenCount = reopenedDoubts.length;
    const resolvedDoubts = doubts.filter(
      (d) => d.status === 'resolved' || (d.auditTrail || []).some((a) => a.status === 'resolved')
    );
    const reopenRate = resolvedDoubts.length > 0 ? Number(((reopenCount / resolvedDoubts.length) * 100).toFixed(1)) : 0;

    // 6. Student Satisfaction ("Solved" vs "Still Confused" & Ratings)
    const ratedDoubts = doubts.filter((d) => d.studentRating && (d.studentRating.score || d.studentRating.feedback));
    const totalRatings = ratedDoubts.length;
    let averageRating = 0;
    if (totalRatings > 0) {
      const scoreSum = ratedDoubts.reduce((acc, d) => acc + (d.studentRating.score || 0), 0);
      averageRating = Number((scoreSum / totalRatings).toFixed(1));
    }

    const satisfiedCount = doubts.filter((d) => {
      if (d.studentRating?.score && d.studentRating.score >= 4) return true;
      if (d.studentRating?.feedback && ['helpful', 'solved', 'great'].includes(d.studentRating.feedback.toLowerCase())) return true;
      if (d.status === 'resolved' && !d.escalatedAt && (d.reopenCount || 0) === 0) return true;
      return false;
    }).length;

    const dissatisfiedCount = doubts.filter((d) => {
      if (d.studentRating?.score && d.studentRating.score <= 2) return true;
      if (d.studentRating?.feedback && ['still_confused', 'unclear', 'not_helpful'].includes(d.studentRating.feedback.toLowerCase())) return true;
      if (d.escalationReason && d.escalationReason.toLowerCase().includes('confused')) return true;
      return false;
    }).length;

    const totalSentiment = satisfiedCount + dissatisfiedCount;
    const studentSatisfactionRate = totalSentiment > 0 ? Number(((satisfiedCount / totalSentiment) * 100).toFixed(1)) : 100;

    // 7. Most Confusing Topics
    const topicMap = {};
    for (const d of doubts) {
      const topicKey = d.topic || d.chapter || 'General Mathematics';
      if (!topicMap[topicKey]) {
        topicMap[topicKey] = {
          topic: topicKey,
          chapter: d.chapter || '',
          subject: d.subject || 'Mathematics',
          totalDoubts: 0,
          escalatedCount: 0,
          stillConfusedCount: 0,
        };
      }
      topicMap[topicKey].totalDoubts += 1;
      if (d.escalatedAt || ['escalated', 'teacher_assigned', 'teacher_answered'].includes(d.status)) {
        topicMap[topicKey].escalatedCount += 1;
      }
      if (
        (d.studentRating?.score && d.studentRating.score <= 2) ||
        d.studentRating?.feedback === 'still_confused' ||
        (d.escalationReason && d.escalationReason.toLowerCase().includes('confused'))
      ) {
        topicMap[topicKey].stillConfusedCount += 1;
      }
    }

    const mostConfusingTopics = Object.values(topicMap)
      .sort((a, b) => b.escalatedCount + b.stillConfusedCount - (a.escalatedCount + a.stillConfusedCount))
      .slice(0, 10);

    // 8. Status Distribution
    const statusDistribution = doubts.reduce((acc, d) => {
      acc[d.status] = (acc[d.status] || 0) + 1;
      return acc;
    }, {});

    return res.json({
      success: true,
      metrics: {
        totalDoubts,
        aiResolvedCount,
        aiResolvedRate,
        escalatedCount,
        escalatedRate,
        avgTimeToAiAnswerMs,
        medianTimeToAiAnswerMs,
        avgTeacherResponseTimeMs,
        slaBreachCount,
        slaBreachRate,
        reopenCount,
        reopenRate,
        studentSatisfactionRate,
        totalRatings,
        averageRating,
      },
      mostConfusingTopics,
      statusDistribution,
      scope: {
        role: userRole,
        course: isTeacher ? (user.targetCourse || user.course || 'All') : (req.query.course || 'All'),
        branch: isTeacher ? (user.branch || 'All') : (req.query.branch || 'All'),
      },
    });
  } catch (error) {
    console.error('Error in getAnalyticsOverview:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @desc    Get admin-only AI capacity & quota usage telemetry
 * @route   GET /api/doubts/analytics/capacity
 * @access  Protected (Admin Only)
 */
exports.getAdminCapacity = async (req, res) => {
  try {
    const user = req.user;
    const isAdmin = String(user.role || '').toLowerCase() === 'admin' || user.id === 'master_admin_id';
    if (!isAdmin) {
      return res.status(403).json({ success: false, message: 'Access denied: Admin only telemetry.' });
    }

    const todayStr = new Date().toISOString().slice(0, 10);
    const todayRecord = (await DoubtQuota.findOne({ date: todayStr }).lean()) || {
      totalQueries: 0,
      modelCounts: {},
      failuresByType: {},
      fallbackQueries: 0,
    };

    const studentUsages = await DoubtQuota.getStudentUsageForDate(todayStr);

    const modelCounts =
      todayRecord.modelCounts instanceof Map
        ? Object.fromEntries(todayRecord.modelCounts)
        : todayRecord.modelCounts || {};

    const failuresByType =
      todayRecord.failuresByType instanceof Map
        ? Object.fromEntries(todayRecord.failuresByType)
        : todayRecord.failuresByType || {};

    const totalQueries = todayRecord.totalQueries || 0;
    const fallbackQueries = todayRecord.fallbackQueries || 0;
    const fallbackRate = totalQueries > 0 ? Number(((fallbackQueries / totalQueries) * 100).toFixed(1)) : 0;
    const globalCap = parseInt(process.env.GLOBAL_DAILY_AI_REQUEST_CAP || '40', 10);
    const remainingCapacity = Math.max(0, globalCap - totalQueries);

    return res.json({
      success: true,
      telemetry: {
        date: todayStr,
        dailyGlobalLimit: globalCap,
        totalQueriesToday: totalQueries,
        remainingCapacityToday: remainingCapacity,
        isFreeTier: true,
        modelUsage: modelCounts,
        fallbackQueries,
        fallbackRate,
        failuresByType,
        perStudentLimit: DAILY_STUDENT_DOUBT_LIMIT,
        activeStudentsToday: studentUsages.length,
        topStudents: studentUsages.map((s) => ({
          studentId: s.studentId,
          count: s.count,
          remaining: Math.max(0, DAILY_STUDENT_DOUBT_LIMIT - s.count),
        })),
      },
    });
  } catch (error) {
    console.error('Error in getAdminCapacity:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @desc    Export sanitized CSV of doubts (scoped by teacher course/branch, no student PII)
 * @route   GET /api/doubts/analytics/export
 * @access  Protected (Teacher/Admin)
 */
exports.exportDoubtsCsv = async (req, res) => {
  try {
    const user = req.user;
    const userRole = String(user.role || '').toLowerCase();
    const isAdmin = userRole === 'admin' || user.id === 'master_admin_id';
    const isTeacher = !isAdmin;

    const filter = {};
    if (isTeacher) {
      const tCourse = user.targetCourse || user.course;
      const tBranch = user.branch;
      if (tCourse) filter.course = new RegExp(`^${tCourse}$`, 'i');
      if (tBranch) filter.branch = new RegExp(`^${tBranch}$`, 'i');
    } else {
      if (req.query.course) filter.course = new RegExp(`^${req.query.course}$`, 'i');
      if (req.query.branch) filter.branch = new RegExp(`^${req.query.branch}$`, 'i');
    }

    if (req.query.subject) filter.subject = new RegExp(`^${req.query.subject}$`, 'i');
    if (req.query.semester) filter.semester = req.query.semester;

    const doubts = await Doubt.find(filter).sort({ createdAt: -1 }).lean();

    const headers = [
      'Doubt Code',
      'Created At',
      'Subject',
      'Topic',
      'Chapter',
      'Course',
      'Branch',
      'Semester',
      'Status',
      'Priority',
      'SLA Deadline',
      'Was Escalated',
      'Assigned Teacher',
      'AI Model Used',
      'Is Fallback Model',
      'Student Rating Score',
      'Student Rating Feedback',
    ];

    const escapeCsv = (val) => {
      if (val === null || val === undefined) return '""';
      const str = String(val).replace(/"/g, '""');
      return `"${str}"`;
    };

    const rows = [headers.join(',')];
    for (const d of doubts) {
      const row = [
        escapeCsv(d.doubtCode || ''),
        escapeCsv(d.createdAt ? new Date(d.createdAt).toISOString() : ''),
        escapeCsv(d.subject || 'Mathematics'),
        escapeCsv(d.topic || ''),
        escapeCsv(d.chapter || ''),
        escapeCsv(d.course || ''),
        escapeCsv(d.branch || ''),
        escapeCsv(d.semester || ''),
        escapeCsv(d.status || ''),
        escapeCsv(d.priority || 'standard'),
        escapeCsv(d.slaDeadline ? new Date(d.slaDeadline).toISOString() : ''),
        escapeCsv(Boolean(d.escalatedAt || ['escalated', 'teacher_assigned', 'teacher_answered'].includes(d.status))),
        escapeCsv(d.assignedTeacher?.name || 'Unassigned'),
        escapeCsv(d.aiExplanation?.modelUsed || d.aiTranscription?.modelUsed || 'N/A'),
        escapeCsv(Boolean(d.aiExplanation?.isFallbackModel)),
        escapeCsv(d.studentRating?.score || ''),
        escapeCsv(d.studentRating?.feedback || ''),
      ];
      rows.push(row.join(','));
    }

    const csvData = rows.join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="doubts_export_${new Date().toISOString().slice(0, 10)}.csv"`);
    return res.status(200).send(csvData);
  } catch (error) {
    console.error('Error in exportDoubtsCsv:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @desc    Publish solved doubt as an anonymized FAQ
 * @route   POST /api/doubts/:id/publish-faq
 * @access  Protected (Teacher/Admin)
 */
exports.publishFaqEntry = async (req, res) => {
  try {
    const user = req.user;
    const { id } = req.params;

    const doubt = await Doubt.findById(id);
    if (!doubt) {
      return res.status(404).json({ success: false, message: 'Doubt not found.' });
    }

    // Verify teacher has access to doubt
    const userRole = String(user.role || '').toLowerCase();
    const isAdmin = userRole === 'admin' || user.id === 'master_admin_id';
    if (!isAdmin) {
      const tCourse = user.targetCourse || user.course;
      const tBranch = user.branch;
      if (tCourse && doubt.course && doubt.course.toLowerCase() !== tCourse.toLowerCase()) {
        return res.status(403).json({ success: false, message: 'Forbidden: You cannot publish FAQs for another course.' });
      }
    }

    // Locate verified solution message or explanation
    const teacherMsg = await DoubtMessage.findOne({
      doubt: doubt._id,
      authorRole: 'teacher',
      messageType: 'solution',
    }).sort({ createdAt: -1 });

    const solutionPlain = teacherMsg?.contentPlain || doubt.aiExplanation?.summary || 'Verified pedagogical solution.';
    const solutionLatex = teacherMsg?.contentLatex || doubt.aiExplanation?.finalAnswer || '';

    // Anonymized problem title
    const title = doubt.aiTranscription?.problemText || doubt.title || 'Mathematical Problem';

    const faq = await DoubtFaq.create({
      title: title.trim(),
      topic: doubt.topic || 'General Mathematics',
      chapter: doubt.chapter || '',
      subject: doubt.subject || 'Mathematics',
      course: doubt.course || 'Engineering',
      branch: doubt.branch || 'Common',
      semester: doubt.semester || 1,
      solutionPlain,
      solutionLatex,
      verifiedByTeacherName: user.name || 'Faculty',
      verifiedByTeacherId: user._id || user.id,
      originalDoubtId: doubt._id,
      tags: [doubt.topic, doubt.chapter].filter(Boolean),
    });

    doubt.isFaq = true;
    doubt.faqId = faq._id;
    doubt.auditTrail.push({
      status: doubt.status,
      changedBy: user.name || 'Faculty',
      role: 'teacher',
      note: `Published as anonymized FAQ entry (FAQ ID: ${faq._id})`,
      timestamp: new Date(),
    });
    await doubt.save();

    return res.json({
      success: true,
      message: 'Doubt successfully published as an anonymized FAQ entry.',
      faq,
    });
  } catch (error) {
    console.error('Error in publishFaqEntry:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @desc    Search anonymized FAQs and student's own solved doubts
 * @route   GET /api/doubts/search-faqs
 * @access  Protected (All authenticated users)
 */
exports.searchFaqsAndSimilar = async (req, res) => {
  try {
    const { q, course, branch, subject, topic } = req.query;
    const faqQuery = {};

    if (course) faqQuery.course = new RegExp(`^${course}$`, 'i');
    if (branch) faqQuery.branch = new RegExp(`^${branch}$`, 'i');
    if (subject) faqQuery.subject = new RegExp(`^${subject}$`, 'i');
    if (topic) faqQuery.topic = new RegExp(topic, 'i');

    if (q && q.trim()) {
      const qTrim = q.trim();
      faqQuery.$or = [
        { title: new RegExp(qTrim, 'i') },
        { topic: new RegExp(qTrim, 'i') },
        { solutionPlain: new RegExp(qTrim, 'i') },
      ];
    }

    const faqs = await DoubtFaq.find(faqQuery)
      .sort({ helpfulCount: -1, viewCount: -1 })
      .limit(10)
      .lean();

    // If student is logged in, also find their own solved doubts
    let mySimilarDoubts = [];
    if (req.user && String(req.user.role || '').toLowerCase() === 'student') {
      const studentId = req.user._id || req.user.id;
      const myQuery = {
        student: studentId,
        status: 'resolved',
      };
      if (q && q.trim()) {
        const qTrim = q.trim();
        myQuery.$or = [
          { title: new RegExp(qTrim, 'i') },
          { topic: new RegExp(qTrim, 'i') },
          { 'aiTranscription.problemText': new RegExp(qTrim, 'i') },
        ];
      }
      mySimilarDoubts = await Doubt.find(myQuery)
        .sort({ resolvedAt: -1 })
        .limit(5)
        .select('doubtCode title topic chapter resolvedAt aiExplanation')
        .lean();
    }

    return res.json({
      success: true,
      faqs,
      mySimilarDoubts,
    });
  } catch (error) {
    console.error('Error in searchFaqsAndSimilar:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * @desc    Student rates a doubt solution (helpful / not helpful, 1-5 stars)
 * @route   POST /api/doubts/:id/rate
 * @access  Protected (Student Owner Only)
 */
exports.rateDoubtSolution = async (req, res) => {
  try {
    const studentId = req.user._id || req.user.id;
    const { id } = req.params;
    const { score, feedback } = req.body || {};

    const doubt = await Doubt.findById(id);
    if (!doubt) {
      return res.status(404).json({ success: false, message: 'Doubt not found.' });
    }

    const isOwner = String(doubt.student) === String(studentId);
    const isAdmin = String(req.user.role || '').toLowerCase() === 'admin';
    if (!isOwner && !isAdmin) {
      return res.status(403).json({
        success: false,
        message: 'Forbidden: Only the student who submitted this doubt can rate the solution.',
      });
    }

    const numScore = Number(score);
    if (isNaN(numScore) || numScore < 1 || numScore > 5) {
      return res.status(400).json({
        success: false,
        message: 'Rating score must be an integer between 1 and 5.',
      });
    }

    doubt.studentRating = {
      score: numScore,
      feedback: (feedback || '').trim(),
      ratedAt: new Date(),
    };

    doubt.auditTrail.push({
      status: doubt.status,
      changedBy: req.user.name || 'Student',
      role: 'student',
      note: `Student rated solution ${numScore}/5${feedback ? ` ("${feedback.slice(0, 50)}")` : ''}`,
      timestamp: new Date(),
    });

    await doubt.save();

    // If linked to an FAQ, update helpfulCount if score >= 4
    if (doubt.faqId && numScore >= 4) {
      await DoubtFaq.findByIdAndUpdate(doubt.faqId, { $inc: { helpfulCount: 1 } }).catch(() => {});
    }

    return res.json({
      success: true,
      message: 'Thank you for your rating!',
      rating: doubt.studentRating,
    });
  } catch (error) {
    console.error('Error in rateDoubtSolution:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
};

// Export sweeper for server startup
exports.sweepStuckDoubtJobs = sweepStuckDoubtJobs;
