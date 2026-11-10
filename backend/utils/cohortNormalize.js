/**
 * Canonical Cohort Normalization & Deduplication Utilities
 * Single source of truth across Question Bank and AI Import pipelines.
 */

// Canonical question types
const CANONICAL_QTYPES = ['MCQ', 'Subjective', 'True/False', 'Fill-in-the-blank'];

/**
 * Normalizes semester input to canonical 'Semester N' string format
 * (e.g. 1, '1', 'sem 1', 'Semester 1' -> 'Semester 1')
 * Leaves Class Level (e.g. 'Class 10') intact.
 */
function normalizeSemester(val, course = '') {
  if (val === null || val === undefined) return 'Semester 1';
  const str = String(val).trim();
  if (!str) return 'Semester 1';

  // If school stream or string starts with Class, maintain Class Level
  if (/^class\s*\d+/i.test(str)) {
    const numMatch = str.match(/\d+/);
    return numMatch ? `Class ${numMatch[0]}` : str;
  }

  // Extract bare semester number
  const numMatch = str.match(/\d+/);
  if (numMatch) {
    return `Semester ${numMatch[0]}`;
  }

  return str;
}

/**
 * Normalizes marks to a strict positive Number
 */
function normalizeMarks(val, fallback = 4) {
  const num = Number(val);
  if (Number.isFinite(num) && num > 0) {
    return Math.round(num);
  }
  return fallback;
}

/**
 * Normalizes question format to canonical values:
 * 'MCQ' | 'Subjective' | 'True/False' | 'Fill-in-the-blank'
 */
function normalizeQType(val, options = []) {
  const s = String(val || '').toLowerCase().trim();
  if (s === 'mcq' || s.includes('choice') || s.includes('multiple') || (Array.isArray(options) && options.length >= 2)) {
    return 'MCQ';
  }
  if (s.includes('true') || s.includes('false') || s === 'tf' || s === 't/f') {
    return 'True/False';
  }
  if (s.includes('fill') || s.includes('blank')) {
    return 'Fill-in-the-blank';
  }
  return 'Subjective';
}

/**
 * Determines whether the question is common across engineering branches
 */
function computeIsCommon({ course, semester, subject, explicitIsCommon }) {
  if (explicitIsCommon !== undefined && explicitIsCommon !== null) {
    return Boolean(explicitIsCommon);
  }

  const isEng = String(course || '').toLowerCase().includes('eng');
  const semNorm = normalizeSemester(semester);
  const isSem1or2 = semNorm === 'Semester 1' || semNorm === 'Semester 2';
  const subj = String(subject || '').toLowerCase();
  const isFoundational =
    subj.includes('math') ||
    subj.includes('physic') ||
    subj.includes('chem') ||
    subj.includes('basic') ||
    subj.includes('applied');

  return Boolean(isEng && isSem1or2 && isFoundational);
}

/**
 * Normalizes mathematical text for duplicate checking:
 * Strips LaTeX macros, dollar signs, punctuation, collapses whitespace, trims
 */
function normalizeMathText(str = '') {
  return String(str || '')
    .toLowerCase()
    .replace(/\$\$[\s\S]+?\$\$/g, ' ')
    .replace(/\$[^$\n]+?\$/g, ' ')
    .replace(/\\[a-zA-Z]+/g, ' ')
    .replace(/[^a-z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Computes deterministic content hash for exact duplicate detection
 */
function computeContentHash(rawText = '') {
  const norm = normalizeMathText(rawText);
  const crypto = require('crypto');
  return crypto.createHash('sha256').update(norm || String(rawText)).digest('hex');
}

/**
 * Token Jaccard similarity for fuzzy duplicate matching
 */
function calculateTextSimilarity(textA = '', textB = '') {
  const normA = normalizeMathText(textA);
  const normB = normalizeMathText(textB);
  if (!normA || !normB) return 0;
  if (normA === normB) return 1.0;

  const wordsA = new Set(normA.split(' ').filter((w) => w.length > 2));
  const wordsB = new Set(normB.split(' ').filter((w) => w.length > 2));

  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++;
  }

  const union = new Set([...wordsA, ...wordsB]).size;
  return union === 0 ? 0 : intersection / union;
}

module.exports = {
  CANONICAL_QTYPES,
  normalizeSemester,
  normalizeMarks,
  normalizeQType,
  computeIsCommon,
  normalizeMathText,
  computeContentHash,
  calculateTextSimilarity,
};
