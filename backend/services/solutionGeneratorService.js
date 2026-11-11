const { GoogleGenAI } = require('@google/genai');

const MODEL_CANDIDATE_CHAIN = [
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-flash-lite-latest',
  'gemini-3.5-flash',
  'gemini-flash-latest',
  'gemini-3.8-flash',
];

/**
 * Resilient Gemini API caller with model candidate fallback
 */
async function callGemini(contents, config = {}, models = MODEL_CANDIDATE_CHAIN) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || !apiKey.trim()) {
    throw new Error('GEMINI_API_KEY is not configured on the server.');
  }

  const ai = new GoogleGenAI({ apiKey });
  let lastError = null;

  for (const model of models) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const response = await ai.models.generateContent({
          model,
          contents,
          config,
        });
        return { response, model };
      } catch (err) {
        lastError = err;
        const msg = (err.message || '').toLowerCase();
        const isRetryable =
          msg.includes('429') ||
          msg.includes('resource_exhausted') ||
          msg.includes('503') ||
          msg.includes('unavailable') ||
          msg.includes('timeout');
        if (!isRetryable || attempt === 2) break;
        await new Promise((res) => setTimeout(res, attempt * 1000));
      }
    }
  }

  throw lastError || new Error('All Gemini model candidates exhausted.');
}

/**
 * Generate Step-by-Step Mathematical Solution (Bilingual + Optional SVG Diagram)
 */
async function generateSolution({
  questionText,
  marks = 5,
  language = 'english',
  style = 'step-by-step',
  generateGraphics = true,
}) {
  if (!questionText || !String(questionText).trim()) {
    throw new Error('questionText is required to generate a solution.');
  }

  const langInstruction =
    language === 'bengali'
      ? 'Language: Bengali (বাংলা). Write all explanatory sentences in clear Bengali using Bengali script. Keep mathematical formulas in standard LaTeX ($...$ or $$...$$).'
      : 'Language: English. Write all explanatory steps in clear English. Keep mathematical formulas in standard LaTeX ($...$ or $$...$$).';

  const solvePrompt = `
You are a distinguished university mathematics professor and examiner.
Solve the following mathematics question comprehensively.

${langInstruction}
Solution Style: ${style === 'concise' ? 'Concise (key working only)' : 'Step-by-step rigorous LMS model answer'}.
Question (Allocated Marks: ${marks}):
${questionText}

RETURN ONLY A VALID JSON OBJECT conforming strictly to this format:
{
  "steps": [
    "Step 1: State the initial theorem or formula...",
    "Step 2: Substitute values...",
    "Step 3: Evaluate the expression..."
  ],
  "finalAnswer": "The final numerical or symbolic result in LaTeX, e.g. $\\\\frac{\\\\pi}{2}$",
  "hasGraphic": true,
  "graphicDescription": "Description of the 2D coordinate graph, function curve, or geometric sketch needed, or empty string if no graphic is required"
}

Format rules:
- Format all mathematical equations in LaTeX with proper escaping ($...$ or $$...$$).
- "hasGraphic": true ONLY if a visual diagram, coordinate plot, geometric figure, or number line directly clarifies the solution.
- Return ONLY valid JSON. No markdown backticks outside, no conversational text.
`.trim();

  const { response, model } = await callGemini(
    [{ role: 'user', parts: [{ text: solvePrompt }] }],
    { temperature: 0.1, responseMimeType: 'application/json' }
  );

  let parsedSolution = null;
  try {
    parsedSolution = JSON.parse(response.text || '{}');
  } catch (_) {
    const match = (response.text || '').match(/\{[\s\S]*\}/);
    if (match) parsedSolution = JSON.parse(match[0]);
  }

  const steps = Array.isArray(parsedSolution?.steps) ? parsedSolution.steps.map(String) : [];
  const finalAnswer = String(parsedSolution?.finalAnswer || '').trim();
  const hasGraphic = Boolean(parsedSolution?.hasGraphic && generateGraphics);
  const graphicDescription = String(parsedSolution?.graphicDescription || '').trim();
  let graphicSvg = '';

  // Generate SVG graphic if required and requested
  if (hasGraphic && graphicDescription) {
    try {
      const svgPrompt = `
Generate a clean, scalable, professional SVG diagram for the following mathematical visualization:
"${graphicDescription}".

SVG requirements:
- Return ONLY raw valid SVG markup starting with <svg and ending with </svg>.
- Ensure viewBox="0 0 500 300" and width="100%" height="auto".
- Use crisp styling: stroke="#4f46e5" for main curves, stroke="#94a3b8" for axes/grids, fill="none", font-family="Inter, sans-serif", font-size="12".
- High contrast, dark-mode & light-mode friendly.
- Do NOT output any markdown backticks, DO NOT output any explanation.
`.trim();

      const svgRes = await callGemini(
        [{ role: 'user', parts: [{ text: svgPrompt }] }],
        { temperature: 0.1 }
      );

      let rawSvg = (svgRes.response.text || '').trim();
      const svgMatch = rawSvg.match(/<svg[\s\S]*<\/svg>/i);
      if (svgMatch) {
        graphicSvg = svgMatch[0];
      }
    } catch (svgErr) {
      console.warn('[SVG Generation Notice]:', svgErr.message);
    }
  }

  return {
    language,
    steps,
    finalAnswer,
    hasGraphic: Boolean(hasGraphic && graphicSvg),
    graphicDescription,
    graphicSvg,
    modelUsed: model,
  };
}

/**
 * Generate Examiner Marking Scheme and Evaluation Rubric
 */
async function generateRubric({ questionText, solution, marks = 5 }) {
  if (!questionText || !String(questionText).trim()) {
    throw new Error('questionText is required to generate a rubric.');
  }

  const solutionStr = Array.isArray(solution?.steps)
    ? solution.steps.join('\n') + (solution.finalAnswer ? `\nFinal Answer: ${solution.finalAnswer}` : '')
    : String(solution || '');

  const rubricPrompt = `
Based on this mathematics question and solution, generate an examiner's marking scheme and grading rubric.
Question (Total Marks: ${marks}):
${questionText}

Solution:
${solutionStr}

RETURN ONLY A VALID JSON OBJECT conforming strictly to this format:
{
  "maxMarks": ${marks},
  "markingScheme": [
    "Step description or theorem statement: X marks",
    "Algebraic derivation or substitution: Y marks",
    "Correct final answer with units/conditions: Z marks"
  ],
  "keyPoints": [
    "Crucial formula or boundary condition that student must include"
  ],
  "commonErrors": [
    "Common student misconception, algebraic pitfall, or omitted check"
  ]
}

Ensure the sum of marks in "markingScheme" matches exactly ${marks} marks.
Return ONLY valid JSON. No markdown backticks outside, no conversational text.
`.trim();

  const { response } = await callGemini(
    [{ role: 'user', parts: [{ text: rubricPrompt }] }],
    { temperature: 0.1, responseMimeType: 'application/json' }
  );

  let parsedRubric = null;
  try {
    parsedRubric = JSON.parse(response.text || '{}');
  } catch (_) {
    const match = (response.text || '').match(/\{[\s\S]*\}/);
    if (match) parsedRubric = JSON.parse(match[0]);
  }

  return {
    maxMarks: Number(parsedRubric?.maxMarks || marks),
    markingScheme: Array.isArray(parsedRubric?.markingScheme) ? parsedRubric.markingScheme.map(String) : [],
    keyPoints: Array.isArray(parsedRubric?.keyPoints) ? parsedRubric.keyPoints.map(String) : [],
    commonErrors: Array.isArray(parsedRubric?.commonErrors) ? parsedRubric.commonErrors.map(String) : [],
  };
}

module.exports = {
  generateSolution,
  generateRubric,
  callGemini,
  MODEL_CANDIDATE_CHAIN,
};
