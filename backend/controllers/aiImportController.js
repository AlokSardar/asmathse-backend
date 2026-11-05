const crypto = require('crypto');
const { GoogleGenAI } = require('@google/genai');
const { PDFDocument } = require('pdf-lib');
const { PDFParse } = require('pdf-parse');
const ImportSession = require('../models/ImportSession');
const ImportPage = require('../models/ImportPage');
const ImportItem = require('../models/ImportItem');
const ExtractionCache = require('../models/ExtractionCache');
const Content = require('../models/Content');

const ALL_ENGINEERING_STREAMS = ['CSE', 'ECE', 'ME', 'EE', 'CE', 'IT'];
const PROMPT_VERSION = 'v2-ocr-pure-transcription';
const MODEL_CANDIDATE_CHAIN = [
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-flash-lite-latest',
  'gemini-3.5-flash',
  'gemini-flash-latest',
  'gemini-3.8-flash'
];

/**
 * Text normalization for similarity & duplicate detection
 */
function normalizeMathText(str = '') {
  return str
    .toLowerCase()
    .replace(/\$+/g, ' ')
    .replace(/\\[a-zA-Z]+/g, ' ')
    .replace(/[^a-z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Calculate Jaccard similarity between two texts based on word n-grams
 */
function calculateTextSimilarity(textA = '', textB = '') {
  const normA = normalizeMathText(textA);
  const normB = normalizeMathText(textB);
  if (!normA || !normB) return 0;
  if (normA === normB) return 1.0;

  const wordsA = new Set(normA.split(' '));
  const wordsB = new Set(normB.split(' '));

  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++;
  }

  const union = new Set([...wordsA, ...wordsB]).size;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Extract embedded text from a PDF single-page buffer for anti-hallucination verification
 */
async function extractEmbeddedPageText(pdfBuffer) {
  try {
    const parser = new PDFParse({ data: pdfBuffer });
    const result = await parser.getText();
    const text = (result && result.text) || '';
    await parser.destroy();
    return text.trim();
  } catch (err) {
    console.warn('[Anti-Hallucination] Could not extract embedded text from page buffer:', err.message);
    return '';
  }
}

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'from', 'this', 'are', 'was', 'were',
  'which', 'what', 'how', 'each', 'all', 'any', 'not', 'can', 'may', 'will'
]);

/**
 * Anti-Hallucination verification: Checks if extracted question tokens appear on the actual page
 */
function verifyAntiHallucination(questionText = '', pageEmbeddedText = '') {
  const cleanEmbedded = (pageEmbeddedText || '')
    .replace(/scanned\s+by\s+camscanner/gi, '')
    .replace(/camscanner/gi, '')
    .replace(/adobe\s+scan/gi, '')
    .trim();

  // If text layer is missing or contains fewer than 25 non-stopword tokens,
  // it is a scanned or raster image without reliable text layer - skip check!
  const embeddedTokens = normalizeMathText(cleanEmbedded)
    .split(' ')
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));

  if (embeddedTokens.length < 25) {
    return { verified: true, overlap: 1.0, warning: null };
  }

  const pageWords = new Set(embeddedTokens);
  const qWords = normalizeMathText(questionText)
    .split(' ')
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w)); // Filter out stop-words

  if (qWords.length === 0) {
    return { verified: true, overlap: 1.0, warning: null };
  }

  let matched = 0;
  for (const w of qWords) {
    if (pageWords.has(w)) matched++;
  }

  const overlap = matched / qWords.length;
  // If fewer than 35% of the distinctive question words appear on this page, it's a hallucination
  if (overlap < 0.35) {
    return {
      verified: false,
      overlap,
      warning: 'Not found on page - possible AI error',
    };
  }

  return { verified: true, overlap, warning: null };
}

/**
 * Resilient Gemini Multimodal Caller with exponential backoff & model fallbacks
 */
async function callGeminiWithRetry(ai, contents, config, models = MODEL_CANDIDATE_CHAIN) {
  let lastError = null;

  for (const model of models) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const response = await ai.models.generateContent({
          model,
          contents,
          config,
        });
        return { response, model };
      } catch (err) {
        lastError = err;
        const errMsg = (err.message || '').toLowerCase();
        const isQuotaOrDemand =
          errMsg.includes('429') ||
          errMsg.includes('resource_exhausted') ||
          errMsg.includes('quota') ||
          errMsg.includes('503') ||
          errMsg.includes('unavailable') ||
          errMsg.includes('high demand') ||
          errMsg.includes('timeout');

        console.warn(`[Gemini API] Model ${model} attempt ${attempt} failed: ${err.message}`);

        if (!isQuotaOrDemand || attempt === 3) {
          // If non-retryable error or exhausted 3 attempts on this model, try next model in candidate chain
          break;
        }

        const delayMs = Math.pow(2, attempt - 1) * 1000; // 1000ms, 2000ms
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  throw lastError || new Error('All Gemini model candidates exhausted.');
}

/**
 * 0. AI Health Status (Zero-cost, makes no paid API calls)
 */
exports.getAiHealth = (req, res) => {
  const hasKey = Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim());
  return res.status(200).json({
    success: true,
    connected: hasKey,
    model: MODEL_CANDIDATE_CHAIN[0],
    preferredChain: MODEL_CANDIDATE_CHAIN,
  });
};

/**
 * 1. Initialize an Import Session
 * Receives uploaded PDF/scan, slices into individual page records, and establishes session.
 */
exports.initImportSession = async (req, res) => {
  try {
    const {
      fileName = 'Uploaded_Question_Paper.pdf',
      fileSize = 0,
      fileSizeLabel = '',
      fileType = 'application/pdf',
      fileDataUrl = '',
      course = 'Engineering',
      branch = 'CSE',
      semester = 'Semester 1',
      subject = 'Applied Mathematics',
    } = req.body;

    if (!fileDataUrl) {
      return res.status(400).json({ success: false, message: 'Missing fileDataUrl payload.' });
    }

    const sessionId = `SES-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const isPdf =
      fileType === 'application/pdf' ||
      fileName.toLowerCase().endsWith('.pdf') ||
      fileDataUrl.startsWith('data:application/pdf');

    let totalPages = 1;
    const pageUnits = [];

    if (isPdf) {
      try {
        const cleanBase64 = fileDataUrl.replace(/^data:[^;]+;base64,/, '');
        const pdfBuffer = Buffer.from(cleanBase64, 'base64');
        const pdfDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
        totalPages = Math.max(1, pdfDoc.getPageCount());

        for (let i = 0; i < totalPages; i++) {
          const singleDoc = await PDFDocument.create();
          const [copiedPage] = await singleDoc.copyPages(pdfDoc, [i]);
          singleDoc.addPage(copiedPage);
          const singleBytes = await singleDoc.save();
          const singleBase64 = Buffer.from(singleBytes).toString('base64');
          const pageHash = crypto.createHash('sha256').update(singleBytes).digest('hex');

          pageUnits.push({
            pageNumber: i + 1,
            pageDataUrl: `data:application/pdf;base64,${singleBase64}`,
            pageHash,
            status: 'pending',
          });
        }
      } catch (pdfErr) {
        console.warn('PDF splitting fallback to whole document:', pdfErr.message);
        totalPages = 1;
        const cleanBase64 = fileDataUrl.replace(/^data:[^;]+;base64,/, '');
        const pageHash = crypto.createHash('sha256').update(Buffer.from(cleanBase64, 'base64')).digest('hex');
        pageUnits.push({
          pageNumber: 1,
          pageDataUrl: fileDataUrl,
          pageHash,
          status: 'pending',
        });
      }
    } else {
      // Single image scan
      const cleanBase64 = fileDataUrl.replace(/^data:[^;]+;base64,/, '');
      const pageHash = crypto.createHash('sha256').update(Buffer.from(cleanBase64, 'base64')).digest('hex');
      pageUnits.push({
        pageNumber: 1,
        pageDataUrl: fileDataUrl,
        pageHash,
        status: 'pending',
      });
    }

    // Save ImportSession
    const sessionDoc = new ImportSession({
      sessionId,
      fileName,
      fileSize,
      fileSizeLabel: fileSizeLabel || `${(fileSize / (1024 * 1024)).toFixed(1)} MB`,
      fileType,
      fileDataUrl,
      course,
      branch,
      semester,
      subject,
      status: 'uploaded',
      totalPages,
      processedPages: 0,
      extractedCount: 0,
      activePage: 1,
      createdBy: req.user ? { id: req.user.id, name: req.user.name, email: req.user.email } : 'Faculty Admin',
    });
    await sessionDoc.save();

    // Save individual ImportPage records
    for (const pu of pageUnits) {
      await ImportPage.create({
        sessionId,
        pageNumber: pu.pageNumber,
        status: 'pending',
        pageDataUrl: pu.pageDataUrl,
        pageHash: pu.pageHash || '',
      });
    }

    const pages = await ImportPage.find({ sessionId })
      .select('pageNumber status extractedCount errorMessage retries pageHash sourceTelemetry cacheStatus')
      .sort({ pageNumber: 1 });

    return res.status(201).json({
      success: true,
      sessionId,
      totalPages,
      session: sessionDoc,
      pages,
    });
  } catch (error) {
    console.error('initImportSession error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * 2. Get Import Session State (for resume on refresh or page navigation)
 */
exports.getSessionState = async (req, res) => {
  try {
    const { sessionId } = req.params;
    const session = await ImportSession.findOne({ sessionId });
    if (!session) {
      return res.status(404).json({ success: false, message: 'Import session not found' });
    }

    const pages = await ImportPage.find({ sessionId }).sort({ pageNumber: 1 });
    const items = await ImportItem.find({ sessionId }).sort({ pageNumber: 1, itemNumber: 1 });

    return res.status(200).json({
      success: true,
      session,
      pages,
      items,
      totalItems: items.length,
      selectedCount: items.filter((it) => it.included).length,
    });
  } catch (error) {
    console.error('getSessionState error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * 3. Extract a single page via Gemini Multimodal Vision API
 * Strict Anti-Hallucination, Temperature 0, Deterministic Transcriptions Only.
 */
exports.extractPage = async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { pageNumber = 1, forceReExtract = false, apiKey: customApiKey } = req.body;

    const session = await ImportSession.findOne({ sessionId });
    if (!session) {
      return res.status(404).json({ success: false, message: 'Session not found' });
    }

    const pageDoc = await ImportPage.findOne({ sessionId, pageNumber: Number(pageNumber) });
    if (!pageDoc) {
      return res.status(404).json({ success: false, message: `Page ${pageNumber} not found` });
    }

    // Resolve API Key: Strictly require server process.env.GEMINI_API_KEY (or admin custom key)
    let apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey && customApiKey && req.user && req.user.role === 'admin') {
      apiKey = customApiKey;
    }

    if (!apiKey || !apiKey.trim()) {
      pageDoc.status = 'error';
      pageDoc.errorMessage = 'Google Gemini API Key is missing. Configure GEMINI_API_KEY in the server environment.';
      await pageDoc.save();
      return res.status(400).json({
        success: false,
        message: 'Google Gemini API Key is missing. Configure GEMINI_API_KEY in the server environment.',
      });
    }

    pageDoc.status = 'extracting';
    pageDoc.errorMessage = '';
    await pageDoc.save();

    session.status = 'processing';
    session.activePage = Number(pageNumber);
    await session.save();

    const pageDataUrl = pageDoc.pageDataUrl || session.fileDataUrl;
    const cleanBase64 = pageDataUrl.replace(/^data:[^;]+;base64,/, '');
    const pageBuffer = Buffer.from(cleanBase64, 'base64');
    const isPdf =
      pageDataUrl.includes('application/pdf') ||
      session.fileName.toLowerCase().endsWith('.pdf');
    const mimeType = isPdf ? 'application/pdf' : 'image/png';

    // Compute SHA-256 of exact page bytes
    const pageHash = crypto.createHash('sha256').update(pageBuffer).digest('hex');
    pageDoc.pageHash = pageHash;

    // Cache Key computation
    const primaryModel = MODEL_CANDIDATE_CHAIN[0];
    const cacheKey = crypto
      .createHash('sha256')
      .update(pageHash + '::' + PROMPT_VERSION + '::' + primaryModel)
      .digest('hex');

    // Server-side dev mode telemetry
    if (process.env.NODE_ENV !== 'production') {
      console.log(
        `[GEMINI_EXTRACT_PAGE] sessionId=${sessionId}, pageNumber=${pageNumber}, byteLength=${pageBuffer.length}, sha256=${pageHash}, mimeType=${mimeType}`
      );
    }

    let extractedRawItems = [];
    let isCached = false;
    let usedModel = primaryModel;

    // ── Check Cache (Unless forceReExtract is set) ──────────────────────────
    if (!forceReExtract) {
      const cached = await ExtractionCache.findOne({ cacheKey });
      if (cached && Array.isArray(cached.items)) {
        isCached = true;
        usedModel = cached.modelName || primaryModel;
        extractedRawItems = cached.items;
        console.log(`⚡ [EXTRACTION CACHE HIT]: Page ${pageNumber} loaded from cache (hash: ${pageHash.slice(0, 8)})`);
      }
    }

    // ── Execute Live Gemini OCR If Not Cached ──────────────────────────────
    if (!isCached) {
      const promptText = `
You are an OCR and transcription engine.
Transcribe ONLY the questions visibly printed on the attached examination page.
Never invent, complete, solve, extrapolate, or paraphrase.
If the page has no questions (e.g. title page, instructions only, or blank), return an empty JSON array: [].
Do NOT calculate or generate solutions. Transcribe "answer_latex" and "solution_latex" ONLY if they are explicitly printed on the page; otherwise set them to empty strings "".
Scan margins or question ends for individual mark allocations (e.g. "[2 Marks]", "(5M)").
CRITICAL SECTION RULE: Section instructions like "(10 x 1 = 10 Marks)" or "(5 x 2 = 10)" mean that each individual sub-question is worth 1 mark or 2 marks. Do NOT assign the section total (10) as the marks of an individual sub-question. Set "marks": 1 and "marksRawLabel": "[1 Mark]".

OUTPUT JSON SCHEMA:
Return ONLY a valid JSON array of question objects adhering to this schema:
[
  {
    "number": "<string: question number as printed, e.g. '1', '2(a)'>",
    "type": "MCQ" | "Short" | "Long" | "Subjective",
    "marks": <number or 0>,
    "marksRawLabel": "<string label as printed, e.g. '[1 Mark]' or ''>",
    "question_latex": "<full text of the question with mathematical formulas in $...$ or $$...$>",
    "options": ["<option 1>", "<option 2>"],
    "correctOption": <number index or null>,
    "answer_latex": "<only if printed on page, else ''>",
    "solution_latex": "<only if printed on page, else ''>",
    "has_figure": <boolean>,
    "difficulty_guess": "Easy" | "Medium" | "Hard",
    "confidence": <number between 0.0 and 1.0>,
    "warnings": []
  }
]
Do not wrap in markdown or prose. Return ONLY the JSON array.
`.trim();

      const ai = new GoogleGenAI({ apiKey });
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

      try {
        const { response, model } = await callGeminiWithRetry(ai, contents, config);
        usedModel = model;
        const responseText = response.text || '';

        const jsonMatch = responseText.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          try {
            const parsed = JSON.parse(jsonMatch[0]);
            if (Array.isArray(parsed)) {
              extractedRawItems = parsed;
            }
          } catch (jsonErr) {
            console.warn('JSON parsing error from Gemini output:', jsonErr.message);
          }
        }

        // Cache successful response
        await ExtractionCache.findOneAndUpdate(
          { cacheKey },
          {
            cacheKey,
            sha256: pageHash,
            pageNumber: Number(pageNumber),
            modelName: usedModel,
            promptVersion: PROMPT_VERSION,
            items: extractedRawItems,
            rawResponse: responseText,
          },
          { upsert: true, new: true }
        );
      } catch (geminiErr) {
        console.error(`Gemini extraction failed for page ${pageNumber}:`, geminiErr.message);
        pageDoc.status = 'error';
        pageDoc.errorMessage = geminiErr.message;
        await pageDoc.save();

        return res.status(502).json({
          success: false,
          pageNumber: Number(pageNumber),
          status: 'error',
          error: geminiErr.message,
          message: `Gemini OCR failed for page ${pageNumber}: ${geminiErr.message}`,
        });
      }
    }

    // ── Anti-Hallucination Verification Layer ──────────────────────────────
    let pageEmbeddedText = '';
    if (isPdf) {
      pageEmbeddedText = await extractEmbeddedPageText(pageBuffer);
    }

    // Fetch existing Question Bank items for real-time duplicate detection
    const existingBankItems = await Content.find({
      type: 'question',
      course: session.course,
    })
      .select('id title questionText marks topic')
      .limit(200);

    // Save extracted items to ImportItem collection
    const createdItems = [];
    await ImportItem.deleteMany({ sessionId, pageNumber: Number(pageNumber) });

    for (let idx = 0; idx < extractedRawItems.length; idx++) {
      const raw = extractedRawItems[idx];
      const qText = raw.question_latex || raw.text || '';
      const customItemId = `ITEM-${sessionId}-P${pageNumber}-${idx + 1}`;

      // Run anti-hallucination check
      const antiH = verifyAntiHallucination(qText, pageEmbeddedText);
      const warnings = Array.isArray(raw.warnings) ? [...raw.warnings] : [];
      let itemConfidence = Number(raw.confidence) || 0.95;
      let shouldInclude = true;

      if (!antiH.verified && antiH.warning) {
        warnings.push(antiH.warning);
        itemConfidence = Math.min(itemConfidence, 0.3);
        shouldInclude = false; // Do not auto-select suspected hallucinations
      }

      // Duplicate check against existing Question Bank
      let isDuplicate = false;
      let duplicateMatchId = '';
      let duplicateTitle = '';
      let duplicateSimilarity = 0;

      for (const bankQ of existingBankItems) {
        const sim = calculateTextSimilarity(qText, bankQ.questionText || bankQ.title || '');
        if (sim > 0.72) {
          isDuplicate = true;
          duplicateMatchId = bankQ.id;
          duplicateTitle = bankQ.title || 'Similar Question in Bank';
          duplicateSimilarity = Math.round(sim * 100);
          break;
        }
      }

      // Normalize section header formulas in marks (e.g., '10*1=10' or '10 x 1 = 10' -> 1 mark)
      let parsedMarks = Number(raw.marks) || 0;
      let rawLabel = raw.marksRawLabel || (raw.marks ? `[${raw.marks} Marks]` : '');
      const groupFormulaMatch = String(rawLabel).match(/(\d+)\s*[*x×]\s*(\d+)\s*=\s*(\d+)/i);
      if (groupFormulaMatch) {
        const perQ = Number(groupFormulaMatch[2]);
        if (perQ > 0) {
          parsedMarks = perQ;
          rawLabel = `[${perQ} Mark${perQ > 1 ? 's' : ''}]`;
        }
      }

      const itemDoc = new ImportItem({
        sessionId,
        itemId: customItemId,
        pageNumber: Number(pageNumber),
        itemNumber: String(raw.number || raw.questionNumber || `${idx + 1}`),
        type: raw.type || 'Subjective',
        marks: parsedMarks,
        marksRawLabel: rawLabel,
        question_latex: qText,
        options: Array.isArray(raw.options) ? raw.options : [],
        correctOption: raw.correctOption ?? (raw.type === 'MCQ' ? 0 : null),
        answer_latex: raw.answer_latex || raw.answer || '',
        solution_latex: raw.solution_latex || raw.solution || '',
        has_figure: Boolean(raw.has_figure),
        figure_bbox: raw.figure_bbox || null,
        topic_guess: raw.topic_guess || raw.topic || session.subject || 'General',
        chapter_guess: raw.chapter_guess || raw.chapter || '',
        difficulty_guess: raw.difficulty_guess || raw.difficulty || 'Medium',
        confidence: itemConfidence,
        warnings,
        included: shouldInclude,
        includeAnswer: Boolean(raw.answer_latex || raw.answer),
        includeSolution: Boolean(raw.solution_latex || raw.solution),
        includeMarks: Boolean(raw.marks),
        includeDiagram: Boolean(raw.has_figure),
        isDuplicate,
        duplicateMatchId,
        duplicateTitle,
        duplicateSimilarity,
        duplicateAction: isDuplicate ? 'skip' : 'import_anyway',
      });

      const savedItem = await itemDoc.save();
      createdItems.push(savedItem);
    }

    // Update page state with telemetry
    const telemetryStr = `Source: Gemini (${usedModel}) · page hash ${pageHash.slice(0, 8)} · ${isCached ? 'cached' : 'fresh'}`;
    pageDoc.status = 'done';
    pageDoc.extractedCount = createdItems.length;
    pageDoc.errorMessage = '';
    pageDoc.sourceTelemetry = telemetryStr;
    pageDoc.cacheStatus = isCached ? 'cached' : 'fresh';
    pageDoc.processedAt = new Date();
    await pageDoc.save();

    // Update session metrics
    const distinctPagesDone = await ImportPage.countDocuments({ sessionId, status: 'done' });
    const totalSessionItems = await ImportItem.countDocuments({ sessionId });
    session.processedPages = distinctPagesDone;
    session.extractedCount = totalSessionItems;
    if (distinctPagesDone >= session.totalPages) {
      session.status = 'completed';
    }
    await session.save();

    return res.status(200).json({
      success: true,
      pageNumber: Number(pageNumber),
      pageHash,
      sourceTelemetry: telemetryStr,
      cacheStatus: isCached ? 'cached' : 'fresh',
      modelUsed: usedModel,
      items: createdItems,
      totalExtracted: createdItems.length,
      sessionMetrics: {
        processedPages: session.processedPages,
        totalPages: session.totalPages,
        totalItems: session.extractedCount,
      },
    });
  } catch (error) {
    console.error(`extractPage error for session ${req.params.sessionId}:`, error);
    await ImportPage.findOneAndUpdate(
      { sessionId: req.params.sessionId, pageNumber: Number(req.body.pageNumber || 1) },
      { status: 'error', errorMessage: error.message }
    );
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * 4. Update an individual extracted item (toggles, LaTeX text, marks, duplicates)
 */
exports.updateItem = async (req, res) => {
  try {
    const { sessionId, itemId } = req.params;
    const updates = req.body;

    const item = await ImportItem.findOneAndUpdate(
      { sessionId, itemId },
      { $set: updates },
      { new: true }
    );

    if (!item) {
      return res.status(404).json({ success: false, message: 'Item not found' });
    }

    return res.status(200).json({ success: true, item });
  } catch (error) {
    console.error('updateItem error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * 4b. AI-Assisted Repair of a Question Card ("Fix with AI")
 */
exports.fixItemWithAi = async (req, res) => {
  try {
    const { sessionId, itemId } = req.params;
    const { question_latex, errorNote, apiKey: customApiKey } = req.body;

    const item = await ImportItem.findOne({ sessionId, itemId });
    if (!item) {
      return res.status(404).json({ success: false, message: 'Item not found' });
    }

    let apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey && customApiKey && req.user && req.user.role === 'admin') {
      apiKey = customApiKey;
    }

    if (!apiKey) {
      const cleaned = (question_latex || item.question_latex || '')
        .replace(/\\\[/g, '$$')
        .replace(/\\\]/g, '$$')
        .replace(/\\\(/g, '$')
        .replace(/\\\)/g, '$');
      item.question_latex = cleaned;
      item.warnings = [];
      await item.save();
      return res.status(200).json({ success: true, item, repairedVia: 'Heuristic Syntax Engine' });
    }

    const ai = new GoogleGenAI({ apiKey });
    const promptText = `
You are a LaTeX and Mathematics OCR Repair Specialist.
Fix the following mathematical question text so that all mathematical formulas, matrices, integrals, fractions, limits, and symbols are in 100% syntactically correct standard KaTeX LaTeX enclosed in $...$ (inline) or $$...$$ (display).
Do not change the mathematical meaning of the question.

Original Question:
${question_latex || item.question_latex}

${errorNote ? `Reported Error: ${errorNote}` : ''}

Respond ONLY with the repaired text. Do not include markdown code block formatting or conversational text.
`.trim();

    const response = await ai.models.generateContent({
      model: 'gemini-3.5-flash',
      contents: promptText,
      config: {
        temperature: 0,
      },
    });

    const repairedText = (response.text || '').trim();
    if (repairedText) {
      item.question_latex = repairedText;
      item.warnings = [];
      await item.save();
    }

    return res.status(200).json({ success: true, item, repairedVia: 'Gemini 3.5 Flash' });
  } catch (error) {
    console.error('fixItemWithAi error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * 5. Commit & Synchronize Selected Items into the Question Bank
 */
exports.commitSessionToBank = async (req, res) => {
  try {
    const { sessionId } = req.params;
    const session = await ImportSession.findOne({ sessionId });
    if (!session) {
      return res.status(404).json({ success: false, message: 'Session not found' });
    }

    const candidateItems = await ImportItem.find({ sessionId, included: true });
    if (candidateItems.length === 0) {
      return res.status(400).json({ success: false, message: 'No questions selected for import.' });
    }

    const savedRecords = [];
    let skippedCount = 0;
    let replacedCount = 0;

    const isEngAll =
      (session.course === 'Engineering' || session.course === 'B.Tech') &&
      (session.branch === 'ALL' || session.branch === 'All Branches (Common First Year)');
    const targetBranches = isEngAll ? ALL_ENGINEERING_STREAMS : [session.branch];

    for (const item of candidateItems) {
      if (item.isDuplicate && item.duplicateAction === 'skip') {
        skippedCount++;
        continue;
      }

      if (item.isDuplicate && item.duplicateAction === 'replace' && item.duplicateMatchId) {
        await Content.findOneAndUpdate(
          { id: item.duplicateMatchId },
          {
            $set: {
              questionText: item.question_latex,
              marks: item.includeMarks ? item.marks : 4,
              finalAnswer: item.includeAnswer ? item.answer_latex : '',
              steps: item.includeSolution && item.solution_latex ? [item.solution_latex] : [],
              explanation: item.includeSolution ? item.solution_latex : '',
              options: item.type === 'MCQ' ? item.options : [],
              correctOption: item.correctOption ?? 0,
              updatedAt: new Date(),
            },
          }
        );
        replacedCount++;
        savedRecords.push(item.duplicateMatchId);
        continue;
      }

      for (const tBranch of targetBranches) {
        const customId = `QB-AI-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
        const contentDoc = new Content({
          id: customId,
          itemId: customId,
          customId,
          title: `${item.topic_guess || session.subject} - Q${item.itemNumber}`,
          type: 'question',
          qType: item.type || 'Subjective',
          course: session.course,
          branch: tBranch,
          stream: tBranch,
          semester: session.semester,
          topic: item.topic_guess || 'Mathematics',
          difficulty: item.difficulty_guess || 'Medium',
          marks: item.includeMarks ? item.marks : 4,
          questionText: item.question_latex,
          options: item.type === 'MCQ' ? item.options : [],
          correctOption: item.correctOption ?? 0,
          finalAnswer: item.includeAnswer ? item.answer_latex : '',
          steps: item.includeSolution && item.solution_latex ? [item.solution_latex] : [],
          explanation: item.includeSolution ? item.solution_latex : '',
          source: `${session.fileName} (Page ${item.pageNumber})`,
          description: `Extracted via Gemini Multimodal OCR from ${session.fileName}, Page ${item.pageNumber}.`,
          isCommon: isEngAll,
          uploadedBy: session.createdBy || 'Faculty Admin',
          uploadedAt: new Date(),
        });

        const saved = await contentDoc.save();
        savedRecords.push(saved.id);
      }
    }

    session.importedAt = new Date();
    session.lastImportedBatch = savedRecords;
    session.status = 'completed';
    await session.save();

    return res.status(200).json({
      success: true,
      message: `Successfully synchronized ${savedRecords.length} questions into the Central Question Bank!`,
      importedCount: savedRecords.length,
      skippedCount,
      replacedCount,
      batchId: sessionId,
    });
  } catch (error) {
    console.error('commitSessionToBank error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * 6. Undo the last imported batch from this session
 */
exports.undoImport = async (req, res) => {
  try {
    const { sessionId } = req.params;
    const session = await ImportSession.findOne({ sessionId });
    if (!session || !session.lastImportedBatch || session.lastImportedBatch.length === 0) {
      return res.status(400).json({ success: false, message: 'No active import batch to undo.' });
    }

    const deleteResult = await Content.deleteMany({ id: { $in: session.lastImportedBatch } });
    const undoneCount = deleteResult.deletedCount || 0;

    session.lastImportedBatch = [];
    session.importedAt = null;
    await session.save();

    return res.status(200).json({
      success: true,
      message: `Reverted ${undoneCount} imported questions from the Question Bank.`,
      undoneCount,
    });
  } catch (error) {
    console.error('undoImport error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};
