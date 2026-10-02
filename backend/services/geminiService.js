const fs = require('fs');
const path = require('path');

// Universal Google Gemini API Key Resolver
const getGeminiApiKey = () => {
  return process.env.GEMINI_API_KEY || null;
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

  const prompt = `You are a distinguished Professor of Mathematics and Chief Examiner.
You have been provided with an official teacher question paper document (PDF or image) for:
Test Title: "${title}"
Course/Stream: ${course} (${branch || classLevel || 'General'})
Subject: ${subject}
Total Marks: ${totalMarks}

CRITICAL TASK — READ AND PARSE THE ACTUAL VISUAL CONTENT OF THE UPLOADED DOCUMENT:
1. Meticulously inspect and read every single line of text and mathematical notation visible in the uploaded document.
2. Extract EVERY main question AND sub-question in strict chronological order as they appear on the paper (e.g., Q1, 1(a), 1(b), 1(c), Q2, 2(a), 2(b), etc.). Do NOT skip or omit any question or sub-question.
3. For each extracted question:
   - "q_no": The exact question identifier as written on the paper (e.g. "Q1", "1(a)", "2(b)").
   - "max_marks": Marks allocated for this question such that the sum of all questions equals approximately ${totalMarks}.
   - "problem_statement_latex": Complete, verbatim problem statement in clean, valid LaTeX syntax.
   - "solution_latex": Comprehensive, exhaustive step-by-step mathematical derivation and model solution in clean LaTeX with all intermediate formulas and steps.
   - "final_answer_latex": The final simplified boxed answer or correct option in clean LaTeX.
4. Convert ALL mathematical expressions, symbols, integrals, fractions, derivatives, and matrices strictly into clean, standard LaTeX notation compatible with KaTeX/MathJax.
5. STRICT RULE: Do NOT fabricate or return generic/mock questions. The questions and solutions MUST correspond directly and exclusively to the uploaded test paper document.

Respond ONLY with valid, raw, parseable JSON matching this exact schema — no markdown fences, no other commentary:
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

  const contents = [];
  const parts = [];

  if (fileBuffer) {
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
  contents.push({ parts });

  // Try primary model (gemini-2.0-flash), with automatic fallback to gemini-1.5-flash
  const modelsToTry = ['gemini-2.0-flash', 'gemini-1.5-flash'];
  let lastError = null;

  for (const modelName of modelsToTry) {
    try {
      console.log(`🤖 [GEMINI VISION API]: Parsing uploaded question paper with model ${modelName}...`);
      const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${geminiApiKey}`;

      const resp = await fetch(geminiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents,
          generationConfig: {
            response_mime_type: 'application/json',
            temperature: 0.1,
          },
        }),
      });

      if (resp.ok) {
        const respJson = await resp.json();
        const candidateText = respJson.candidates?.[0]?.content?.parts?.[0]?.text;
        if (candidateText) {
          // Strip any markdown fences
          const cleaned = candidateText.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
          const parsed = JSON.parse(cleaned);

          let questionsList = [];
          if (Array.isArray(parsed.questions) && parsed.questions.length > 0) {
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

            console.log(`✅ [GOOGLE GEMINI VISION API]: Successfully extracted ${normalizedQuestions.length} questions dynamically from uploaded file via ${modelName}!`);
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
      console.warn(`Model ${modelName} attempt error:`, err.message);
      lastError = err;
    }
  }

  // If both models failed, throw the actual error dynamically (no mock/canned data)
  throw new Error(`Failed to dynamically analyze question paper with Gemini Vision API: ${lastError?.message || 'Unknown error'}`);
};

module.exports = {
  getGeminiApiKey,
  generateAnswerKeyForQuestionPaper,
};
