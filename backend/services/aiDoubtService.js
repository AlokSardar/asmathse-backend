const crypto = require('crypto');
const { GoogleGenAI } = require('@google/genai');
const ExtractionCache = require('../models/ExtractionCache');
const DoubtQuota = require('../models/DoubtQuota');

const PROMPT_VERSION_EXPLAIN = 'v3-pedagogical-explanation';
const PROMPT_VERSION_TRANSCRIBE = 'v3-ocr-transcription';

// Supported & Verified Model Chains
const PRIMARY_EXPLAIN_MODEL = process.env.GEMINI_DOUBT_MODEL || 'gemini-3.8-flash';
const EXPLAIN_MODEL_CHAIN = [
  PRIMARY_EXPLAIN_MODEL,
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-flash-lite-latest',
];

const TRANSCRIPTION_MODEL_CHAIN = [
  process.env.GEMINI_TRANSCRIPTION_MODEL || 'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-flash-lite-latest',
  'gemini-3.5-flash',
  'gemini-3.8-flash',
];

/**
 * Validates file buffer magic bytes for security against spoofed file extensions.
 */
function validateImageMagicBytes(buffer) {
  if (!buffer || buffer.length < 4) return { valid: false, mimeType: null };

  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { valid: true, mimeType: 'image/jpeg' };
  }
  // PNG: 89 50 4E 47
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return { valid: true, mimeType: 'image/png' };
  }
  // WebP: 52 49 46 46 ... 57 45 42 50
  if (
    buffer.length >= 12 &&
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return { valid: true, mimeType: 'image/webp' };
  }
  // PDF: 25 50 44 46 (%PDF)
  if (buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) {
    return { valid: true, mimeType: 'application/pdf' };
  }

  return { valid: false, mimeType: null };
}

/**
 * Strips EXIF metadata from JPEG buffers to prevent privacy/location leakage.
 */
function stripExifMetadata(buffer) {
  if (!buffer || buffer.length < 4) return buffer;
  // If not JPEG, return as-is
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8) return buffer;

  let pos = 2;
  const cleanChunks = [Buffer.from([0xff, 0xd8])];

  while (pos < buffer.length - 1) {
    if (buffer[pos] === 0xff) {
      const marker = buffer[pos + 1];
      // End of image
      if (marker === 0xd9) {
        cleanChunks.push(buffer.subarray(pos));
        break;
      }
      // Standalone markers
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
        cleanChunks.push(buffer.subarray(pos, pos + 2));
        pos += 2;
        continue;
      }
      // Markers with payload size: APP1 (0xE1 = EXIF) should be skipped
      if (pos + 3 < buffer.length) {
        const length = buffer.readUInt16BE(pos + 2);
        if (marker === 0xe1) {
          // Skip EXIF segment
          pos += 2 + length;
          continue;
        } else {
          cleanChunks.push(buffer.subarray(pos, pos + 2 + length));
          pos += 2 + length;
          continue;
        }
      }
    }
    pos++;
  }

  return Buffer.concat(cleanChunks);
}

/**
 * Normalizes mathematical text for deterministic hashing and duplicate detection.
 */
function normalizeQuery(text = '', language = 'en') {
  return `${language.toLowerCase()}:::${text
    .toLowerCase()
    .replace(/\$+/g, ' ')
    .replace(/\\[a-zA-Z]+/g, ' ')
    .replace(/[^a-z0-9\u0980-\u09FF]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()}`;
}

/**
 * Helper to call Gemini with exponential backoff on transient errors (503),
 * but fast failure without retry on 429 daily quota exhaustion.
 */
async function callGeminiModel(ai, model, contents, config) {
  const resp = await ai.models.generateContent({
    model,
    contents,
    config,
  });
  return resp;
}

/**
 * STAGE 1: Problem Transcription from Handwritten/Printed Photos
 */
async function transcribeProblem({ imageBase64, mimeType = 'image/jpeg', studentNote = '', topic = '' }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured on the server.');
  }

  const ai = new GoogleGenAI({ apiKey });

  const transcriptionPrompt = `You are a high-precision Mathematical OCR & Problem Transcriber.
Analyze the attached student photograph/scan of a mathematical problem.
Transcribe visibly printed or handwritten equations, statements, and numerical parameters into clean, syntactically correct LaTeX math.

RULES:
1. Never invent or solve the problem in this stage. Only transcribe what is visibly in the image.
2. If handwriting is illegible, partially cropped, or ambiguous, flag it in "warnings" and formulate a polite "clarifyingQuestion".
3. Return ONLY a valid JSON object matching this schema:
{
  "problemText": "Clean human-readable transcription of the question",
  "latexEquation": "Complete standalone LaTeX equation or system if applicable",
  "confidence": 0.95 (number between 0.0 and 1.0),
  "warnings": ["Array of any caveats e.g. 'Bottom margin is slightly blurred'"],
  "needsClarification": false (boolean),
  "clarifyingQuestion": "" (string, formulate only if question cannot be transcribed with certainty)
}`;

  let usedModel = null;
  let lastError = null;

  for (const model of TRANSCRIPTION_MODEL_CHAIN) {
    try {
      usedModel = model;
      const contents = [
        {
          role: 'user',
          parts: [
            { inlineData: { mimeType, data: imageBase64 } },
            { text: `${transcriptionPrompt}\n${topic ? `Expected Subject / Topic: ${topic}` : ''}\n${studentNote ? `Student's Context Note: ${studentNote}` : ''}` },
          ],
        },
      ];

      const config = {
        temperature: 0.1,
        responseMimeType: 'application/json',
      };

      const result = await callGeminiModel(ai, model, contents, config);
      const text = result.text || '';
      const parsed = JSON.parse(text);

      return {
        success: true,
        transcription: {
          problemText: parsed.problemText || '',
          latexEquation: parsed.latexEquation || '',
          confidence: Number(parsed.confidence) || 0.9,
          warnings: Array.isArray(parsed.warnings) ? parsed.warnings : [],
          needsClarification: Boolean(parsed.needsClarification),
          clarifyingQuestion: parsed.clarifyingQuestion || '',
          modelUsed: usedModel,
        },
      };
    } catch (err) {
      lastError = err;
      const isQuota429 = String(err.message).includes('429') || String(err.message).includes('RESOURCE_EXHAUSTED');
      if (isQuota429) {
        console.warn(`[Transcription] Model ${model} reached quota limit (429). Trying next fallback candidate...`);
      } else {
        console.warn(`[Transcription] Model ${model} error:`, err.message);
      }
    }
  }

  throw new Error(`AI transcription failed across all candidate models: ${lastError?.message || 'Quota or network error'}`);
}

/**
 * STAGE 2: Pedagogical Math Explanation
 */
async function explainProblem({
  problemText,
  latexEquation = '',
  topic = '',
  course = 'Engineering',
  language = 'en', // 'en' | 'bn'
  studentNote = '',
  previousMessages = [], // Thread context for follow-up questions
}) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured on the server.');
  }

  const ai = new GoogleGenAI({ apiKey });

  // 1. Check Cache
  const normalized = normalizeQuery(`${problemText} ${latexEquation} ${topic}`, language);
  const cacheKey = crypto.createHash('sha256').update(`${normalized}:::${PROMPT_VERSION_EXPLAIN}`).digest('hex');

  // Check cache only for initial question (no follow-ups)
  if (previousMessages.length === 0) {
    try {
      const cached = await ExtractionCache.findOne({ cacheKey });
      if (cached && cached.items && cached.items.steps) {
        return {
          success: true,
          explanation: cached.items,
          fromCache: true,
          modelUsed: cached.modelName,
          isFallbackModel: cached.modelName !== PRIMARY_EXPLAIN_MODEL,
        };
      }
    } catch (_) {}
  }

  // 2. Build Pedagogical System Prompt with Language Enforcement
  const isBengali = language === 'bn';
  const languageDirective = isBengali
    ? `LANGUAGE DIRECTIVE (BENGALI / বাংলা):
- You MUST write the explanation, conceptual intuition, reasoning steps, self-check, and common mistakes in clear, elegant, and patient Bengali (বাংলা).
- CRITICAL: All mathematical equations, symbols, variables, functions, and numerical values MUST remain strictly in standard LaTeX math delimiters ($...$ for inline and $$...$$ for display equations).
- Example: "যেহেতু $x^2 = 4$, উভয়পক্ষে বর্গমূল নিলে পাই $x = \\pm 2$।"`
    : `LANGUAGE DIRECTIVE (ENGLISH):
- Write the pedagogical explanation in patient, clear, and structured English.
- Use standard LaTeX math delimiters ($...$ for inline and $$...$$ for display equations).`;

  const systemPrompt = `You are a patient, expert Mathematics Professor and Pedagogical Tutor.
Your mission is to guide a student through their mathematical doubt step-by-step with deep conceptual understanding.

${languageDirective}

CONTENT MODERATION & SAFETY (STRICT):
- You are strictly an academic mathematics tutor.
- If the question is non-mathematical, harmful, off-topic, or asks for unethical actions, politely decline to answer and instruct the student to submit a valid mathematics question.

PEDAGOGICAL TEACHING STRUCTURE (EXPLAIN WHY, NOT JUST WHAT):
1. Understand the Question: Clarify what is given and what we need to determine.
2. Key Concepts & Formulas: State the theorem, property, or identity used before applying it.
3. Step-by-Step Reasoning: Numbered logical steps. Explain why each manipulation or substitution is made.
4. Final Answer: Explicit exact mathematical answer.
5. Quick Self-Check: A verification method (e.g., substitute back, check boundary limits, check units/dimension, or sanity check).
6. Common Mistakes to Avoid: Common pitfalls or misconceptions students make on this exact problem.

OUTPUT JSON SCHEMA:
Return ONLY a valid JSON object matching this schema without markdown fences:
{
  "summary": "Concise high-level intuitive summary of the solution",
  "conceptsUsed": ["List of theorems, formulas, or concepts used"],
  "steps": [
    {
      "stepNumber": 1,
      "title": "Short descriptive step title",
      "explanation": "Pedagogical reasoning explaining why this step is taken",
      "math": "LaTeX mathematical equation for this step e.g. $$f'(x) = 2x$$"
    }
  ],
  "finalAnswer": "Explicit final statement and result in LaTeX",
  "quickCheck": "Sanity check / substitution verification",
  "commonMistakes": ["List of typical errors students make on this problem"]
}`;

  let threadHistoryText = '';
  if (previousMessages.length > 0) {
    threadHistoryText = `\nPREVIOUS CONVERSATION CONTEXT:\n${previousMessages
      .map((m) => `[${m.authorRole?.toUpperCase()}]: ${m.contentPlain || m.contentLatex || ''}`)
      .join('\n')}\n`;
  }

  const userQuery = `STUDENT DOUBT QUERY:
Subject/Topic: ${topic || 'Mathematics'}
Question: ${problemText}
${latexEquation ? `Given Expression/Equation: ${latexEquation}` : ''}
${studentNote ? `What the student tried / where they are stuck: ${studentNote}` : ''}
Academic Context: Course ${course}
${threadHistoryText}
Please solve this pedagogical doubt adhering to the JSON schema.`;

  let usedModel = null;
  let lastError = null;

  for (const model of EXPLAIN_MODEL_CHAIN) {
    try {
      usedModel = model;
      const contents = [
        {
          role: 'user',
          parts: [{ text: `${systemPrompt}\n\n${userQuery}` }],
        },
      ];

      const config = {
        temperature: 0.2, // Low temperature for mathematical rigor
        responseMimeType: 'application/json',
      };

      const result = await callGeminiModel(ai, model, contents, config);
      const text = result.text || '';
      const parsed = JSON.parse(text);

      const isFallback = usedModel !== PRIMARY_EXPLAIN_MODEL;

      // Cache successful response (only for fresh questions)
      if (previousMessages.length === 0) {
        try {
          await ExtractionCache.findOneAndUpdate(
            { cacheKey },
            {
              cacheKey,
              sha256: cacheKey,
              pageNumber: 1,
              modelName: usedModel,
              promptVersion: PROMPT_VERSION_EXPLAIN,
              items: parsed,
              rawResponse: text,
            },
            { upsert: true }
          );
        } catch (_) {}
      }

      return {
        success: true,
        explanation: parsed,
        modelUsed: usedModel,
        isFallbackModel: isFallback,
      };
    } catch (err) {
      lastError = err;
      const isQuota429 = String(err.message).includes('429') || String(err.message).includes('RESOURCE_EXHAUSTED');
      if (isQuota429) {
        console.warn(`[Explanation] Model ${model} reached quota limit (429). Trying next fallback candidate...`);
      } else {
        console.warn(`[Explanation] Model ${model} error:`, err.message);
      }
    }
  }

  throw new Error(`AI explanation failed across all candidate models: ${lastError?.message || 'Quota or service error'}`);
}

module.exports = {
  validateImageMagicBytes,
  stripExifMetadata,
  normalizeQuery,
  transcribeProblem,
  explainProblem,
  PRIMARY_EXPLAIN_MODEL,
  EXPLAIN_MODEL_CHAIN,
  TRANSCRIPTION_MODEL_CHAIN,
};
