const fs = require('fs');
const path = require('path');

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
 * Generate Pre-Computed Step-by-Step LaTeX Answer Key for an Uploaded Question Paper
 * Strictly powered by Google Gemini Vision API (multimodal).
 * No hardcoded or mock solutions — processes the actual visual document dynamically.
 *
 * Enforced output schema:
 * {
 *   generatedBy, status, lockedAt, updatedAt,
 *   questions: [{ q_no, max_marks, problem_statement_latex, solution_latex, final_answer_latex }]
 * }
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

  if (!fileBuffer && (!textContent || textContent.trim().length === 0)) {
    throw new Error('No uploaded question paper file or text found for this test. Please attach a valid PDF or image question paper.');
  }

  // Helper: Robust JSON parser that can salvage completed questions even if response ended near token boundary
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

  const prompt = `You are a distinguished Professor of Mathematics and Chief Examiner.
You have been provided with an official teacher question paper document (PDF or image) for:
Test Title: "${title}"
Course/Stream: ${course} (${branch || classLevel || 'General'})
Subject: ${subject}
Total Marks: ${totalMarks}

CRITICAL TASK — EXHAUSTIVE, COMPLETE EXTRACTION & STEP-BY-STEP SOLUTION WITHOUT ANY TRUNCATION:
1. Meticulously inspect and read every single line of text and mathematical notation visible in the uploaded document from the very top to the very bottom.
2. Extract EVERY main question AND every sub-question in strict chronological order as they appear on the paper (e.g., Q1, 1(a), 1(b), 1(c), Q2, 2(a), 2(b), Q3, etc.).
3. MANDATORY COMPLETENESS RULE:
   - You MUST solve EVERY single question in the paper. DO NOT STOP HALFWAY. DO NOT OMIT ANY QUESTION.
   - If there are 5, 8, 10, or 15 questions, your output MUST contain a solution entry for ALL of them.
   - Keep derivations mathematically rigorous, concise, high-density, and direct so the entire answer key fits cleanly within the response without hitting token limits.
4. For each question:
   - "q_no": Exact question number/label (e.g., "1(a)", "2", "3(b)").
   - "max_marks": Numeric marks allocated (number).
   - "problem_statement_latex": Verbatim problem statement in clean LaTeX.
   - "solution_latex": Complete, step-by-step mathematical model derivation in clean LaTeX with all intermediate formulas and explanations.
   - "final_answer_latex": Clear boxed final answer in clean LaTeX (e.g. "\\boxed{...}").
5. Convert all mathematical notation, integrals (\\int), fractions (\\frac), matrices, symbols, derivatives into valid LaTeX syntax compatible with KaTeX/MathJax.
6. STRICT RULE: Do NOT fabricate or return generic/mock questions. The questions and solutions MUST correspond directly and exclusively to the uploaded test paper document.

Respond ONLY with valid, raw, parseable JSON matching this exact schema — no markdown fences, no trailing commentary:
{
  "questions": [
    {
      "q_no": "1(a)",
      "max_marks": 5,
      "problem_statement_latex": "\\\\text{Problem statement in LaTeX}",
      "solution_latex": "\\\\textbf{Step 1:} ...\\\\\\\\ \\\\textbf{Step 2:} ...",
      "final_answer_latex": "\\\\boxed{\\\\text{Final answer}}"
    }
  ]
}`;

  // Dynamically discover candidate models for this API key
  const candidateModels = await getAvailableGeminiModels(geminiApiKey);
  let lastError = null;

  for (const modelName of candidateModels) {
    try {
      console.log(`🤖 [GEMINI API]: Attempting complete question paper parsing with model "${modelName}"...`);

      const parts = [];

      // Multimodal payload (supported on gemini-1.5-pro, gemini-1.5-flash*, gemini-2.0*)
      const isMultimodalSupported = !modelName.endsWith('-pro') || modelName.includes('1.5');
      if (fileBuffer && isMultimodalSupported) {
        parts.push({
          inline_data: {
            mime_type: fileMime,
            data: fileBuffer.toString('base64'),
          },
        });
      }

      if (textContent) {
        parts.push({ text: `Question Paper Text Content:\n${textContent}` });
      }

      parts.push({ text: prompt });

      const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${geminiApiKey}`;

      const requestBody = {
        contents: [{ parts }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 8192,
        },
      };

      // response_mime_type is supported on Gemini 1.5 and 2.0 models
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
        const candidate = respJson.candidates?.[0];
        const finishReason = candidate?.finishReason;
        const candidateText = candidate?.content?.parts?.[0]?.text;

        if (finishReason === 'MAX_TOKENS') {
          console.warn(`⚠️ [GEMINI API]: Generation hit MAX_TOKENS limit on "${modelName}". Invoking recovery parser...`);
        }

        if (candidateText) {
          const parsed = parseGeminiJsonWithRecovery(candidateText);

          let questionsList = [];
          if (parsed && Array.isArray(parsed.questions) && parsed.questions.length > 0) {
            questionsList = parsed.questions;
          } else if (Array.isArray(parsed) && parsed.length > 0) {
            questionsList = parsed;
          }

          if (questionsList.length > 0) {
            // Normalize question objects to strict schema
            const normalizedQuestions = questionsList.map((q, idx) => ({
              q_no: q.q_no || q.questionNumber || `Q${idx + 1}`,
              max_marks: Number(q.max_marks || q.marks || q.maxMarks) || Math.max(1, Math.floor(totalMarks / questionsList.length)),
              problem_statement_latex: q.problem_statement_latex || q.questionText || q.problem || '',
              solution_latex: q.solution_latex || q.stepByStepLatex || q.solution || '',
              final_answer_latex: q.final_answer_latex || q.finalAnswer || q.answer || '',
            }));

            console.log(`✅ [GEMINI API]: Successfully parsed complete question paper using "${modelName}" (${normalizedQuestions.length} questions)!`);
            return {
              generatedBy: `Google Gemini API (${modelName})`,
              status: 'draft',
              questions: normalizedQuestions,
              lockedAt: null,
              updatedAt: new Date(),
            };
          }
        }
      } else {
        const errText = await resp.text();
        console.warn(`Gemini API call to ${modelName} returned status ${resp.status}:`, errText);
        lastError = new Error(`Gemini API (${modelName}) returned status ${resp.status}: ${errText.substring(0, 200)}`);
      }
    } catch (err) {
      console.warn(`Model "${modelName}" attempt error:`, err.message);
      lastError = err;
    }
  }

  // If all candidate models failed, throw the detailed error
  throw new Error(`Failed to dynamically analyze question paper with Gemini API: ${lastError?.message || 'Model unavailable'}`);
};

module.exports = {
  getGeminiApiKey,
  getAvailableGeminiModels,
  generateAnswerKeyForQuestionPaper,
};
