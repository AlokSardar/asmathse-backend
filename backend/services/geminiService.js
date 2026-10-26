const fs = require('fs');
const path = require('path');
const { PDFDocument } = require('pdf-lib');

// Universal & Robust Google Gemini API Key Resolver
const getGeminiApiKey = () => {
  if (process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim()) {
    return process.env.GEMINI_API_KEY.trim();
  }

  // Safe fallback to inspect .env files if process.env is not yet populated
  try {
    const candidatePaths = [
      path.join(__dirname, '..', '.env'),
      path.join(__dirname, '..', '..', '.env'),
      path.join(process.cwd(), '.env'),
      path.join(process.cwd(), 'backend', '.env'),
    ];
    for (const envPath of candidatePaths) {
      if (fs.existsSync(envPath)) {
        const content = fs.readFileSync(envPath, 'utf8');
        const match = content.match(/^GEMINI_API_KEY\s*=\s*(.+)$/m);
        if (match && match[1]) {
          const key = match[1].trim().replace(/^['"]|['"]$/g, '');
          if (key) {
            process.env.GEMINI_API_KEY = key;
            return key;
          }
        }
      }
    }
  } catch (_) {}

  return null;
};

// Cache for active supported models
let cachedAvailableModels = null;

/**
 * Dynamically discover and resolve supported Gemini models for the active API key
 */
const getAvailableGeminiModels = async (apiKey) => {
  if (cachedAvailableModels && cachedAvailableModels.length > 0) {
    return cachedAvailableModels;
  }

  const preferredOrder = [
    'gemini-1.5-pro',
    'gemini-pro',
    'gemini-1.5-flash-latest',
    'gemini-2.0-flash',
    'gemini-1.5-flash',
  ];

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4000);

    const listResp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`,
      { signal: controller.signal }
    );
    clearTimeout(timeoutId);

    if (listResp.ok) {
      const data = await listResp.json();
      const serverModels = (data.models || [])
        .filter(m => m.supportedGenerationMethods?.includes('generateContent'))
        .map(m => m.name.replace(/^models\//, ''));

      console.log(`📋 [GEMINI API]: Server reported ${serverModels.length} models available for key:`, serverModels);

      const resolved = [];
      // Add preferred models that are available on the server
      for (const pref of preferredOrder) {
        if (serverModels.includes(pref)) {
          resolved.push(pref);
        }
      }
      // Add any other models starting with gemini
      for (const sm of serverModels) {
        if (sm.startsWith('gemini') && !resolved.includes(sm)) {
          resolved.push(sm);
        }
      }

      if (resolved.length > 0) {
        cachedAvailableModels = resolved;
        console.log(`✨ [GEMINI API]: Prioritized model candidate chain:`, resolved);
        return resolved;
      }
    } else {
      console.warn(`Gemini models query returned HTTP ${listResp.status}`);
    }
  } catch (err) {
    console.warn('Dynamic Gemini model discovery notice:', err.message);
  }

  // Universal stable fallback list (prioritizing gemini-1.5-pro and gemini-pro as requested)
  return preferredOrder;
};

/**
 * Robust JSON parser that can salvage completed questions even if response ended near token boundary
 */
const parseGeminiJsonWithRecovery = (text) => {
  if (!text || typeof text !== 'string') return null;
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();

  // 1. Direct standard parse
  try {
    const parsed = JSON.parse(cleaned);
    if (parsed) return parsed;
  } catch (_) {}

  // 2. Automated partial JSON recovery for questions array
  try {
    const qIndex = cleaned.indexOf('"questions"');
    const arrStart = cleaned.indexOf('[', qIndex !== -1 ? qIndex : 0);
    if (arrStart !== -1) {
      let lastClosingBrace = cleaned.lastIndexOf('}');
      while (lastClosingBrace > arrStart) {
        const candidate = cleaned.substring(arrStart, lastClosingBrace + 1) + ']';
        try {
          const recoveredArr = JSON.parse(candidate);
          if (Array.isArray(recoveredArr) && recoveredArr.length > 0) {
            console.log(`🔧 [GEMINI API RECOVERY]: Salvaged ${recoveredArr.length} completed question solutions from cutoff!`);
            return { questions: recoveredArr };
          }
        } catch (_) {}
        lastClosingBrace = cleaned.lastIndexOf('}', lastClosingBrace - 1);
      }
    }
  } catch (salvageErr) {
    console.warn('JSON salvage error:', salvageErr.message);
  }

  return null;
};

/**
 * Incremental parser to extract completed question blocks in real-time from a streaming chunk buffer
 */
const extractCompletedQuestionsFromText = (text) => {
  if (!text || typeof text !== 'string') return [];
  const results = [];
  const qIndex = text.indexOf('"questions"');
  if (qIndex === -1) return results;

  let pos = text.indexOf('{', qIndex);
  while (pos !== -1) {
    let depth = 0;
    let endPos = -1;
    let inString = false;
    let escape = false;

    for (let i = pos; i < text.length; i++) {
      const char = text[i];
      if (escape) {
        escape = false;
        continue;
      }
      if (char === '\\') {
        escape = true;
        continue;
      }
      if (char === '"') {
        inString = !inString;
        continue;
      }
      if (!inString) {
        if (char === '{') depth++;
        else if (char === '}') {
          depth--;
          if (depth === 0) {
            endPos = i;
            break;
          }
        }
      }
    }

    if (endPos !== -1) {
      const candidateStr = text.substring(pos, endPos + 1);
      try {
        const obj = JSON.parse(candidateStr);
        if (obj && (obj.q_no || obj.questionNumber || obj.problem_statement_latex || obj.solution_latex)) {
          results.push({
            q_no: obj.q_no || obj.questionNumber || `Q${results.length + 1}`,
            max_marks: Number(obj.max_marks || obj.marks || obj.maxMarks) || 5,
            problem_statement_latex: obj.problem_statement_latex || obj.questionText || obj.problem || '',
            solution_latex: obj.solution_latex || obj.stepByStepLatex || obj.solution || '',
            final_answer_latex: obj.final_answer_latex || obj.finalAnswer || obj.answer || '',
          });
        }
      } catch (_) {}
      pos = text.indexOf('{', endPos + 1);
    } else {
      break;
    }
  }
  return results;
};

/**
 * Splits a document buffer or payload into sequential pages.
 * If PDF, extracts each page into an individual single-page PDF buffer using pdf-lib.
 * If image or text, returns a single page object.
 */
const splitDocumentIntoPages = async ({ fileBuffer, fileMime, textContent, pages = [] }) => {
  if (Array.isArray(pages) && pages.length > 0) {
    return pages.map((p, idx) => ({
      buffer: Buffer.isBuffer(p.buffer)
        ? p.buffer
        : (p.dataUrl ? Buffer.from(p.dataUrl.replace(/^data:[^;]+;base64,/, ''), 'base64') : (p.data ? Buffer.from(p.data, 'base64') : null)),
      mime: p.mime || p.fileMime || 'image/jpeg',
      pageNumber: idx + 1,
      totalPages: pages.length,
      textContent: p.textContent || '',
    }));
  }

  const isPdf = (fileMime && fileMime.includes('pdf')) || (fileBuffer && fileBuffer.slice(0, 4).toString() === '%PDF');

  if (fileBuffer && isPdf) {
    try {
      const srcDoc = await PDFDocument.load(fileBuffer, { ignoreEncryption: true });
      const pageCount = srcDoc.getPageCount();
      if (pageCount > 1) {
        const pageList = [];
        for (let i = 0; i < pageCount; i++) {
          const subDoc = await PDFDocument.create();
          const [copiedPage] = await subDoc.copyPages(srcDoc, [i]);
          subDoc.addPage(copiedPage);
          const subBytes = await subDoc.save();
          pageList.push({
            buffer: Buffer.from(subBytes),
            mime: 'application/pdf',
            pageNumber: i + 1,
            totalPages: pageCount,
            textContent: '',
          });
        }
        console.log(`📑 [PAGE-BY-PAGE SPLITTER]: Extracted ${pageList.length} sequential pages from PDF`);
        return pageList;
      }
    } catch (pdfErr) {
      console.warn('PDF splitting fallback to single page:', pdfErr.message);
    }
  }

  return [{
    buffer: fileBuffer,
    mime: fileMime || 'application/pdf',
    pageNumber: 1,
    totalPages: 1,
    textContent: textContent || '',
  }];
};

/**
 * Generate Pre-Computed Step-by-Step LaTeX Answer Key for an Uploaded Question Paper
 * Strictly processes the document sequentially page-by-page:
 * (Process Page 1 -> generate key -> process Page 2 -> generate key -> ... -> loop completes on the last page -> finalize).
 */
const generateAnswerKeyForQuestionPaper = async ({
  title,
  course = 'engineering',
  branch = '',
  classLevel = '',
  subject = 'Mathematics',
  marks = 50,
  fileBuffer = null,
  fileMime = 'application/pdf',
  textContent = '',
  localPath = null,
  customPrompt = '',
  pages = [],
}) => {
  const geminiApiKey = getGeminiApiKey();
  const totalMarks = Number(marks) || 50;

  if (!geminiApiKey) {
    throw new Error('Google Gemini API Key is missing. Please configure GEMINI_API_KEY in the server environment.');
  }

  // Attempt reading fileBuffer from localPath if not passed directly
  if (!fileBuffer && localPath && fs.existsSync(localPath)) {
    try {
      fileBuffer = fs.readFileSync(localPath);
      const ext = path.extname(localPath).toLowerCase();
      fileMime = ext === '.pdf' ? 'application/pdf' : (ext === '.png' ? 'image/png' : 'image/jpeg');
    } catch (e) {
      console.warn('Could not read question paper buffer from localPath:', e.message);
    }
  }

  if (!fileBuffer && (!textContent || textContent.trim().length === 0) && (!pages || pages.length === 0)) {
    throw new Error('No uploaded question paper file or text found for this test. Please attach a valid PDF or image question paper.');
  }

  // Split question paper into sequential pages
  const docPages = await splitDocumentIntoPages({ fileBuffer, fileMime, textContent, pages });
  const totalPages = docPages.length;
  console.log(`📑 [ANSWER KEY PIPELINE]: Initializing sequential page-by-page loop across ${totalPages} page(s)...`);

  const candidateModels = await getAvailableGeminiModels(geminiApiKey);
  const accumulatedQuestions = [];
  let successfulModel = candidateModels[0] || 'gemini-1.5-pro';

  // Sequential Page-by-Page Loop:
  // Process Page 1 -> generate key -> process Page 2 -> generate key -> ... -> loop completes on the last page -> finalize
  for (let pIdx = 0; pIdx < totalPages; pIdx++) {
    const pageObj = docPages[pIdx];
    const pageNum = pageObj.pageNumber;
    console.log(`🔄 [SEQUENTIAL ANSWER KEY LOOP]: Processing Page ${pageNum} of ${totalPages}...`);

    const pagePrompt = `You are a distinguished Professor of Mathematics and Chief Examiner.
You are analyzing PAGE ${pageNum} of ${totalPages} of an official teacher question paper document for:
Test Title: "${title}"
Course/Stream: ${course} (${branch || classLevel || 'General'})
Subject: ${subject}
Total Marks for full paper: ${totalMarks}
${customPrompt && customPrompt.trim() ? `
TEACHER'S CUSTOM INSTRUCTIONS & SPECIFIC GRADING RULES:
${customPrompt.trim()}
CRITICAL: You MUST strictly incorporate and follow the teacher's custom rules and solution criteria above.
` : ''}
${accumulatedQuestions.length > 0 ? `
QUESTIONS EXTRACTED AND SOLVED ON PREVIOUS PAGES (Pages 1 to ${pageNum - 1}):
${accumulatedQuestions.map(q => `[${q.q_no}]: ${q.problem_statement_latex}`).join('\n')}
CRITICAL CONTINUITY RULE: Continue the question sequence seamlessly. Do NOT duplicate already extracted questions. Focus strictly on extracting and solving the questions and sub-questions present on PAGE ${pageNum}.
` : ''}
CRITICAL TASK — EXHAUSTIVE, COMPLETE EXTRACTION & STEP-BY-STEP SOLUTION FOR PAGE ${pageNum} OF ${totalPages}:
1. Meticulously inspect and read every single line of text and mathematical notation visible on PAGE ${pageNum} from top to bottom.
2. Extract EVERY main question AND every sub-question that appears on this page in strict chronological order (e.g., Q1, 1(a), 1(b), 1(c), Q2, 2(a), 2(b), etc.).
3. MANDATORY COMPLETENESS & CLEAN TYPOGRAPHY RULES:
   - You MUST solve EVERY single question on this page. DO NOT STOP HALFWAY. DO NOT OMIT ANY QUESTION.
   - For every question, ensure proper markdown and LaTeX spacing, explicit line breaks ("\\n\\n"), and clean typography so text never overlaps or runs together.
   - In "problem_statement_latex", use clean standard text with inline formulas in $...$ or display formulas in $$...$$. Use explicit double line breaks between paragraphs.
   - In "solution_latex", structure your solution into clear, numbered steps with bold headers (e.g., "\\\\textbf{Step 1: Setup}\\\\n\\\\n...\\\\n\\\\n\\\\textbf{Step 2: Derivation}\\\\n\\\\n..."). Always separate distinct equations and explanations with explicit double line breaks ("\\\\n\\\\n") or LaTeX line breaks ("\\\\\\\\\\\\n") so that mathematical expressions render with beautiful margins and never collide.
   - For displayed equations, put them on their own line with $$...$$ or \\begin{aligned} ... \\end{aligned}.
   - In "final_answer_latex", provide a clean, boxed final result (e.g., "\\\\boxed{...}") with clear unit or conclusion text.
4. For each question:
   - "q_no": Exact question number/label (e.g., "1(a)", "2", "3(b)").
   - "max_marks": Numeric marks allocated (integer or float, e.g. 1, 2, 3, 4, 5, 10).
   - "problem_statement_latex": Verbatim problem statement with clean LaTeX and proper spacing.
   - "solution_latex": Complete step-by-step mathematical model derivation with clear line breaks ("\\n\\n") and clean typography.
   - "final_answer_latex": Clear boxed final answer in clean LaTeX (e.g. "\\boxed{...}").
5. Convert all mathematical notation, integrals (\\int), fractions (\\frac), matrices, symbols, derivatives into valid KaTeX-compatible LaTeX syntax.
6. STRICT RULE: Questions and solutions MUST correspond directly and exclusively to the uploaded document on PAGE ${pageNum}.

Respond ONLY with valid, raw, parseable JSON matching this exact schema — no markdown fences, no trailing commentary:
{
  "questions": [
    {
      "q_no": "1(a)",
      "max_marks": 5,
      "problem_statement_latex": "Evaluate the integral $\\\\int_{0}^{\\\\pi/2} \\\\frac{\\\\sin x}{\\\\sin x + \\\\cos x} dx$.",
      "solution_latex": "\\\\textbf{Step 1: Setup and King's Property}\\\\n\\\\nLet $I = \\\\int_{0}^{\\\\pi/2} \\\\frac{\\\\sin x}{\\\\sin x + \\\\cos x} dx$ ...\\\\n\\\\n\\\\textbf{Step 2: Algebraic Summation}\\\\n\\\\nAdding both expressions gives $2I = \\\\int_{0}^{\\\\pi/2} 1 dx = \\\\frac{\\\\pi}{2}$ ...\\\\n\\\\n\\\\textbf{Step 3: Final Computation}\\\\n\\\\nTherefore, $I = \\\\frac{\\\\pi}{4}$.",
      "final_answer_latex": "\\\\boxed{I = \\\\frac{\\\\pi}{4}}"
    }
  ]
}`;

    let pageQuestions = [];

    for (const modelName of candidateModels) {
      try {
        const parts = [];
        const isMultimodalSupported = modelName !== 'gemini-pro';

        if (pageObj.buffer && isMultimodalSupported) {
          parts.push({
            inline_data: {
              mime_type: pageObj.mime || 'application/pdf',
              data: pageObj.buffer.toString('base64'),
            },
          });
        }
        if (pageObj.textContent) {
          parts.push({ text: `Page ${pageNum} Content:\n${pageObj.textContent}` });
        }
        parts.push({ text: pagePrompt });

        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${geminiApiKey}`;
        const requestBody = {
          contents: [{ parts }],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 8192,
          },
        };

        if (modelName.includes('1.5') || modelName.includes('2.0') || modelName.includes('flash')) {
          requestBody.generationConfig.response_mime_type = 'application/json';
        }

        const resp = await fetch(geminiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody),
        });

        if (resp.ok) {
          const respJson = await resp.json();
          const candidateText = respJson.candidates?.[0]?.content?.parts?.[0]?.text;
          if (candidateText) {
            const parsed = parseGeminiJsonWithRecovery(candidateText);
            const qList = (parsed && Array.isArray(parsed.questions)) ? parsed.questions : (Array.isArray(parsed) ? parsed : []);
            if (qList.length > 0) {
              pageQuestions = qList.map((q, idx) => ({
                q_no: q.q_no || q.questionNumber || `Q${accumulatedQuestions.length + idx + 1}`,
                max_marks: Number(q.max_marks || q.marks || q.maxMarks) || Math.max(1, Math.floor(totalMarks / (qList.length * totalPages))),
                problem_statement_latex: q.problem_statement_latex || q.questionText || q.problem || '',
                solution_latex: q.solution_latex || q.stepByStepLatex || q.solution || '',
                final_answer_latex: q.final_answer_latex || q.finalAnswer || q.answer || '',
                pageNumber: pageNum,
              }));
              successfulModel = modelName;
              console.log(`✅ [PAGE ${pageNum}/${totalPages} SUCCESS]: Extracted ${pageQuestions.length} questions via ${modelName}`);
              break;
            }
          }
        }
      } catch (err) {
        console.warn(`Page ${pageNum} model ${modelName} notice:`, err.message);
      }
    }

    if (pageQuestions.length > 0) {
      accumulatedQuestions.push(...pageQuestions);
    }
  }

  // Loop completes on the last page -> finalize
  console.log(`🏁 [ANSWER KEY LOOP COMPLETED]: Extracted total of ${accumulatedQuestions.length} questions across ${totalPages} pages.`);

  return {
    generatedBy: `Google Gemini API (${successfulModel}) - Sequential Page-by-Page`,
    status: 'draft',
    questions: accumulatedQuestions,
    lockedAt: null,
    updatedAt: new Date(),
  };
};

/**
 * Streaming / Incremental Gemini Vision Answer Key Generator:
 * Connects to Gemini's streaming endpoint and processes documents sequentially page-by-page:
 * (Process Page 1 -> generate key -> process Page 2 -> generate key -> ... -> loop completes on the last page -> finalize).
 * Emits real-time progress and discovered questions across each page.
 */
const streamAnswerKeyForQuestionPaper = async ({
  title,
  course = 'engineering',
  branch = '',
  classLevel = '',
  subject = 'Mathematics',
  marks = 50,
  fileBuffer = null,
  fileMime = 'application/pdf',
  textContent = '',
  localPath = null,
  customPrompt = '',
  pages = [],
  onProgress = null,
  onQuestion = null,
}) => {
  const geminiApiKey = getGeminiApiKey();
  const totalMarks = Number(marks) || 50;

  if (!geminiApiKey) {
    throw new Error('Google Gemini API Key is missing. Please configure GEMINI_API_KEY in the server environment.');
  }

  // Attempt reading fileBuffer from localPath if not passed directly
  if (!fileBuffer && localPath && fs.existsSync(localPath)) {
    try {
      fileBuffer = fs.readFileSync(localPath);
      const ext = path.extname(localPath).toLowerCase();
      fileMime = ext === '.pdf' ? 'application/pdf' : (ext === '.png' ? 'image/png' : 'image/jpeg');
    } catch (e) {
      console.warn('Could not read question paper buffer from localPath:', e.message);
    }
  }

  if (!fileBuffer && (!textContent || textContent.trim().length === 0) && (!pages || pages.length === 0)) {
    throw new Error('No uploaded question paper file or text found for this test. Please attach a valid PDF or image question paper.');
  }

  onProgress?.({ stage: 'connecting', message: 'Analyzing question paper pages & document structure...', percent: 12 });

  // Split question paper into sequential pages
  const docPages = await splitDocumentIntoPages({ fileBuffer, fileMime, textContent, pages });
  const totalPages = docPages.length;
  console.log(`📑 [STREAM ANSWER KEY PIPELINE]: Initializing sequential page-by-page streaming across ${totalPages} page(s)...`);

  const candidateModels = await getAvailableGeminiModels(geminiApiKey);
  const accumulatedQuestions = [];
  let successfulModel = candidateModels[0] || 'gemini-1.5-pro';

  // Sequential Page-by-Page Streaming Loop:
  // Process Page 1 -> generate key -> process Page 2 -> generate key -> ... -> loop completes on the last page -> finalize
  for (let pIdx = 0; pIdx < totalPages; pIdx++) {
    const pageObj = docPages[pIdx];
    const pageNum = pageObj.pageNumber;
    console.log(`🔄 [SEQUENTIAL STREAMING LOOP]: Processing Page ${pageNum} of ${totalPages}...`);

    onProgress?.({
      stage: 'page_processing',
      page: pageNum,
      totalPages,
      message: `Processing Page ${pageNum} of ${totalPages}: Extracting questions & generating LaTeX solutions...`,
      percent: Math.min(92, Math.round(15 + (pIdx / totalPages) * 75)),
    });

    const pagePrompt = `You are a distinguished Professor of Mathematics and Chief Examiner.
You are analyzing PAGE ${pageNum} of ${totalPages} of an official teacher question paper document for:
Test Title: "${title}"
Course/Stream: ${course} (${branch || classLevel || 'General'})
Subject: ${subject}
Total Marks for full paper: ${totalMarks}
${customPrompt && customPrompt.trim() ? `
TEACHER'S CUSTOM INSTRUCTIONS & SPECIFIC GRADING RULES:
${customPrompt.trim()}
CRITICAL: You MUST strictly incorporate and follow the teacher's custom rules and solution criteria above.
` : ''}
${accumulatedQuestions.length > 0 ? `
QUESTIONS EXTRACTED AND SOLVED ON PREVIOUS PAGES (Pages 1 to ${pageNum - 1}):
${accumulatedQuestions.map(q => `[${q.q_no}]: ${q.problem_statement_latex}`).join('\n')}
CRITICAL CONTINUITY RULE: Continue the question sequence seamlessly. Do NOT duplicate already extracted questions. Focus strictly on extracting and solving the questions and sub-questions present on PAGE ${pageNum}.
` : ''}
CRITICAL TASK — EXHAUSTIVE, COMPLETE EXTRACTION & STEP-BY-STEP SOLUTION FOR PAGE ${pageNum} OF ${totalPages}:
1. Meticulously inspect and read every single line of text and mathematical notation visible on PAGE ${pageNum} from top to bottom.
2. Extract EVERY main question AND every sub-question that appears on this page in strict chronological order (e.g., Q1, 1(a), 1(b), 1(c), Q2, 2(a), 2(b), etc.).
3. MANDATORY COMPLETENESS & CLEAN TYPOGRAPHY RULES:
   - You MUST solve EVERY single question on this page. DO NOT STOP HALFWAY. DO NOT OMIT ANY QUESTION.
   - For every question, ensure proper markdown and LaTeX spacing, explicit line breaks ("\\n\\n"), and clean typography so text never overlaps or runs together.
   - In "problem_statement_latex", use clean standard text with inline formulas in $...$ or display formulas in $$...$$. Use explicit double line breaks between paragraphs.
   - In "solution_latex", structure your solution into clear, numbered steps with bold headers (e.g., "\\\\textbf{Step 1: Setup}\\\\n\\\\n...\\\\n\\\\n\\\\textbf{Step 2: Derivation}\\\\n\\\\n..."). Always separate distinct equations and explanations with explicit double line breaks ("\\\\n\\\\n") or LaTeX line breaks ("\\\\\\\\\\\\n") so that mathematical expressions render with beautiful margins and never collide.
   - For displayed equations, put them on their own line with $$...$$ or \\begin{aligned} ... \\end{aligned}.
   - In "final_answer_latex", provide a clean, boxed final result (e.g., "\\\\boxed{...}") with clear unit or conclusion text.
4. For each question:
   - "q_no": Exact question number/label (e.g., "1(a)", "2", "3(b)").
   - "max_marks": Numeric marks allocated (integer or float, e.g. 1, 2, 3, 4, 5, 10).
   - "problem_statement_latex": Verbatim problem statement with clean LaTeX and proper spacing.
   - "solution_latex": Complete step-by-step mathematical model derivation with clear line breaks ("\\n\\n") and clean typography.
   - "final_answer_latex": Clear boxed final answer in clean LaTeX (e.g. "\\boxed{...}").
5. Convert all mathematical notation, integrals (\\int), fractions (\\frac), matrices, symbols, derivatives into valid KaTeX-compatible LaTeX syntax.
6. STRICT RULE: Questions and solutions MUST correspond directly and exclusively to the uploaded document on PAGE ${pageNum}.

Respond ONLY with valid, raw, parseable JSON matching this exact schema — no markdown fences, no trailing commentary:
{
  "questions": [
    {
      "q_no": "1(a)",
      "max_marks": 5,
      "problem_statement_latex": "Evaluate the integral $\\\\int_{0}^{\\\\pi/2} \\\\frac{\\\\sin x}{\\\\sin x + \\\\cos x} dx$.",
      "solution_latex": "\\\\textbf{Step 1: Setup and King's Property}\\\\n\\\\nLet $I = \\\\int_{0}^{\\\\pi/2} \\\\frac{\\\\sin x}{\\\\sin x + \\\\cos x} dx$ ...\\\\n\\\\n\\\\textbf{Step 2: Algebraic Summation}\\\\n\\\\nAdding both expressions gives $2I = \\\\int_{0}^{\\\\pi/2} 1 dx = \\\\frac{\\\\pi}{2}$ ...\\\\n\\\\n\\\\textbf{Step 3: Final Computation}\\\\n\\\\nTherefore, $I = \\\\frac{\\\\pi}{4}$.",
      "final_answer_latex": "\\\\boxed{I = \\\\frac{\\\\pi}{4}}"
    }
  ]
}`;

    let pageQuestions = [];
    let pageStreamed = false;

    for (const modelName of candidateModels) {
      try {
        const parts = [];
        const isMultimodalSupported = modelName !== 'gemini-pro';

        if (pageObj.buffer && isMultimodalSupported) {
          parts.push({
            inline_data: {
              mime_type: pageObj.mime || 'application/pdf',
              data: pageObj.buffer.toString('base64'),
            },
          });
        }
        if (pageObj.textContent) {
          parts.push({ text: `Page ${pageNum} Content:\n${pageObj.textContent}` });
        }
        parts.push({ text: pagePrompt });

        const streamUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:streamGenerateContent?alt=sse&key=${geminiApiKey}`;
        const requestBody = {
          contents: [{ parts }],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 8192,
          },
        };

        if (modelName.includes('1.5') || modelName.includes('2.0') || modelName.includes('flash')) {
          requestBody.generationConfig.response_mime_type = 'application/json';
        }

        const resp = await fetch(streamUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody),
        });

        if (!resp.ok) continue;

        let pageAccumulatedText = '';
        let pageEmittedCount = 0;
        let lineBuffer = '';

        if (resp.body) {
          for await (const chunk of resp.body) {
            const chunkStr = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
            lineBuffer += chunkStr;
            const lines = lineBuffer.split('\n');
            lineBuffer = lines.pop() || '';

            for (const line of lines) {
              const trimmedLine = line.trim();
              if (trimmedLine.startsWith('data:')) {
                const dataPayload = trimmedLine.replace(/^data:\s*/, '');
                if (dataPayload === '[DONE]') continue;
                try {
                  const sseJson = JSON.parse(dataPayload);
                  const partText = sseJson.candidates?.[0]?.content?.parts?.[0]?.text;
                  if (partText) {
                    pageAccumulatedText += partText;
                    const extractedSoFar = extractCompletedQuestionsFromText(pageAccumulatedText);
                    if (extractedSoFar.length > pageEmittedCount) {
                      for (let i = pageEmittedCount; i < extractedSoFar.length; i++) {
                        const qObj = {
                          ...extractedSoFar[i],
                          pageNumber: pageNum,
                        };
                        accumulatedQuestions.push(qObj);
                        onQuestion?.({
                          question: qObj,
                          index: accumulatedQuestions.length,
                          totalDiscovered: accumulatedQuestions.length,
                          page: pageNum,
                        });
                        onProgress?.({
                          stage: 'question_extracted',
                          message: `[Page ${pageNum}/${totalPages}] Discovered and solved ${qObj.q_no} (${qObj.max_marks} marks)`,
                          percent: Math.min(95, Math.round(15 + ((pIdx + (i + 1) / (extractedSoFar.length + 1)) / totalPages) * 75)),
                        });
                      }
                      pageEmittedCount = extractedSoFar.length;
                    }
                  }
                } catch (_) {}
              }
            }
          }
        }

        // Check leftover questions
        let finalPageParsed = extractCompletedQuestionsFromText(pageAccumulatedText);
        if (finalPageParsed.length === 0) {
          const recovered = parseGeminiJsonWithRecovery(pageAccumulatedText);
          if (recovered?.questions) finalPageParsed = recovered.questions;
        }

        if (finalPageParsed.length > pageEmittedCount) {
          for (let i = pageEmittedCount; i < finalPageParsed.length; i++) {
            const qObj = {
              ...finalPageParsed[i],
              pageNumber: pageNum,
            };
            accumulatedQuestions.push(qObj);
            onQuestion?.({
              question: qObj,
              index: accumulatedQuestions.length,
              totalDiscovered: accumulatedQuestions.length,
              page: pageNum,
            });
          }
        }

        if (accumulatedQuestions.length > 0 || pageAccumulatedText.length > 0) {
          successfulModel = modelName;
          pageStreamed = true;
          console.log(`✅ [STREAM PAGE ${pageNum}/${totalPages} SUCCESS]: Processed via ${modelName}`);
          break;
        }
      } catch (streamErr) {
        console.warn(`Stream attempt for page ${pageNum} with ${modelName} notice:`, streamErr.message);
      }
    }
  }

  // Loop completed on the last page -> finalize
  onProgress?.({
    stage: 'completed',
    message: `Successfully generated ${accumulatedQuestions.length} questions across all ${totalPages} pages!`,
    percent: 100,
  });

  return {
    generatedBy: `Google Gemini Streaming API (${successfulModel}) - Sequential Page-by-Page`,
    status: 'draft',
    questions: accumulatedQuestions,
    lockedAt: null,
    updatedAt: new Date(),
  };
};

module.exports = {
  getGeminiApiKey,
  getAvailableGeminiModels,
  parseGeminiJsonWithRecovery,
  extractCompletedQuestionsFromText,
  splitDocumentIntoPages,
  generateAnswerKeyForQuestionPaper,
  streamAnswerKeyForQuestionPaper,
};
