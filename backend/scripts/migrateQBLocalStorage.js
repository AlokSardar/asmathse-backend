/**
 * Idempotent Question Bank Seed Migration & Backfill Script
 * Migrates local fixtures from academicDataService into MongoDB and
 * backfills source/importSource on pre-existing questions.
 */

const dotenv = require('dotenv');
const path = require('path');
const mongoose = require('mongoose');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const Content = require('../models/Content');
const { assertDevOrTestDatabase } = require('../utils/dbGuard');

const SEED_QUESTIONS = [
  {
    id: 'QB-401',
    customId: 'QB-401',
    title: 'Skew-Symmetric Matrix Determinant Property',
    type: 'question',
    qType: 'MCQ',
    course: 'Engineering',
    branch: 'CSE',
    stream: 'CSE',
    semester: 'Semester 1',
    subject: 'Mathematics I',
    topic: 'Matrices & Eigenvalues',
    difficulty: 'Medium',
    marks: 4,
    yearTag: '2025 PYQ',
    questionText: 'If $A$ is a $3 \\times 3$ skew-symmetric matrix over $\\mathbb{R}$, then the determinant $\\det(A)$ is always equal to:',
    options: ['$0$', '$1$', '$-1$', '$\\text{tr}(A)^2$'],
    correctOption: 0,
    finalAnswer: '$0$',
    steps: [
      'For an odd-order skew-symmetric matrix $A^T = -A$.',
      'Taking determinants: $\\det(A) = \\det(A^T) = \\det(-A) = (-1)^3 \\det(A) = -\\det(A)$.',
      'Therefore, $2\\det(A) = 0 \\implies \\det(A) = 0$.'
    ],
    explanation: 'For an odd-order skew-symmetric matrix $A^T = -A$, $\\det(A) = \\det(A^T) = (-1)^3 \\det(A) = -\\det(A) \\implies \\det(A) = 0$.',
    isCommon: true,
    source: 'Seed',
    importSource: 'Seed',
    solutionHidden: false,
    isVerified: true,
  },
  {
    id: 'QB-402',
    customId: 'QB-402',
    title: 'Beta-Gamma Relation and Definite Integral',
    type: 'question',
    qType: 'Subjective',
    course: 'Engineering',
    branch: 'CSE',
    stream: 'CSE',
    semester: 'Semester 1',
    subject: 'Mathematics I',
    topic: 'Beta & Gamma Functions',
    difficulty: 'Hard',
    marks: 10,
    yearTag: '2024 PYQ',
    questionText: 'Prove the Beta-Gamma relation $B(m, n) = \\frac{\\Gamma(m)\\Gamma(n)}{\\Gamma(m+n)}$ for $m, n > 0$ and hence evaluate $\\int_0^\\infty \\frac{x^4(1+x^5)}{(1+x)^{15}} \\, dx$.',
    options: [],
    finalAnswer: '$\\frac{1}{5040}$',
    steps: [
      'Transform $\\Gamma(m)\\Gamma(n) = \\int_0^\\infty e^{-u} u^{m-1} du \\int_0^\\infty e^{-v} v^{n-1} dv$ into polar coordinates $u = r^2\\cos^2\\theta, v = r^2\\sin^2\\theta$.',
      'Separate the radial integral $\\int_0^\\infty 2 r^{2(m+n)-1} e^{-r^2} dr = \\Gamma(m+n)$ and angular integral $2\\int_0^{\\pi/2} \\cos^{2m-1}\\theta \\sin^{2n-1}\\theta d\\theta = B(m, n)$.',
      'Split the integral $\\int_0^\\infty \\frac{x^4}{(1+x)^{15}}dx + \\int_0^\\infty \\frac{x^9}{(1+x)^{15}}dx = B(5, 10) + B(10, 5) = 2 B(5, 10) = 2 \\frac{\\Gamma(5)\\Gamma(10)}{\\Gamma(15)} = \\frac{1}{5040}$.'
    ],
    explanation: 'Transform into polar coordinates to separate radial and angular integrals, then express the rational integral in terms of Beta functions.',
    isCommon: true,
    source: 'Seed',
    importSource: 'Seed',
    solutionHidden: false,
    isVerified: true,
  },
  {
    id: 'QB-403',
    customId: 'QB-403',
    title: 'Dimension of Linear Subspace with Constraints',
    type: 'question',
    qType: 'MCQ',
    course: 'Engineering',
    branch: 'CSE',
    stream: 'CSE',
    semester: 'Semester 1',
    subject: 'Mathematics I',
    topic: 'Vector Spaces',
    difficulty: 'Easy',
    marks: 2,
    yearTag: '2025 PYQ',
    questionText: 'What is the dimension of the subspace $W = \\{(x, y, z, w) \\in \\mathbb{R}^4 : x + y - z = 0,\\; 2x - y + w = 0\\}$?',
    options: ['$2$', '$3$', '$1$', '$4$'],
    correctOption: 0,
    finalAnswer: '$2$',
    steps: [
      'The subspace $W$ is defined by $2$ linearly independent linear equations in $\\mathbb{R}^4$.',
      'The coefficient matrix is $A = \\begin{pmatrix} 1 & 1 & -1 & 0 \\\\ 2 & -1 & 0 & 1 \\end{pmatrix}$ with $\\text{rank}(A) = 2$.',
      'By Rank-Nullity Theorem, $\\dim(W) = 4 - \\text{rank}(A) = 4 - 2 = 2$.'
    ],
    explanation: 'The coefficient matrix of the two independent constraints has rank $2$, so $\\dim(W) = 4 - 2 = 2$.',
    isCommon: true,
    source: 'Seed',
    importSource: 'Seed',
    solutionHidden: false,
    isVerified: true,
  },
  {
    id: 'QB-404',
    customId: 'QB-404',
    title: 'Multivariable Calculus Chain Rule Identity',
    type: 'question',
    qType: 'Subjective',
    course: 'Engineering',
    branch: 'CSE',
    stream: 'CSE',
    semester: 'Semester 1',
    subject: 'Mathematics I',
    topic: 'Multivariable Calculus',
    difficulty: 'Medium',
    marks: 8,
    yearTag: '2023 PYQ',
    questionText: 'If $u = f(y-z, z-x, x-y)$, prove that $\\frac{\\partial u}{\\partial x} + \\frac{\\partial u}{\\partial y} + \\frac{\\partial u}{\\partial z} = 0$.',
    options: [],
    finalAnswer: '$0$',
    steps: [
      'Let $p = y-z, q = z-x, r = x-y$.',
      'Then $\\frac{\\partial u}{\\partial x} = f_p(0) + f_q(-1) + f_r(1) = -f_q + f_r$.',
      'Similarly, $\\frac{\\partial u}{\\partial y} = f_p(1) + f_q(0) + f_r(-1) = f_p - f_r$.',
      'And $\\frac{\\partial u}{\\partial z} = f_p(-1) + f_q(1) + f_r(0) = -f_p + f_q$.',
      'Adding all three: $(-f_q + f_r) + (f_p - f_r) + (-f_p + f_q) = 0$.'
    ],
    explanation: 'Apply the multivariable Chain Rule by substituting dummy variables $p=y-z, q=z-x, r=x-y$ and sum the partial derivatives.',
    isCommon: true,
    source: 'Seed',
    importSource: 'Seed',
    solutionHidden: false,
    isVerified: true,
  },
  {
    id: 'QB-CBSE9-401',
    customId: 'QB-CBSE9-401',
    title: 'Polynomial Remainder Theorem Application',
    type: 'question',
    qType: 'MCQ',
    course: 'CBSE',
    branch: 'CBSE Standard',
    stream: 'CBSE Standard',
    semester: 'Class 9',
    classLevel: 'Class 9',
    subject: 'CBSE Class 9 Mathematics',
    topic: 'Number Systems & Polynomials',
    difficulty: 'Medium',
    marks: 4,
    yearTag: '2025 PYQ',
    questionText: 'When $p(x) = x^4 - 2x^3 + 3x^2 - ax + 8$ is divided by $x - 1$, the remainder is $5$. Find the value of $a$:',
    options: ['$5$', '$4$', '$3$', '$6$'],
    correctOption: 0,
    finalAnswer: '$5$',
    steps: [
      'By Remainder Theorem, the remainder when $p(x)$ is divided by $x - 1$ is $p(1)$.',
      'Given $p(1) = 5$: $(1)^4 - 2(1)^3 + 3(1)^2 - a(1) + 8 = 5$.',
      '$1 - 2 + 3 - a + 8 = 5 \\implies 10 - a = 5 \\implies a = 5$.'
    ],
    explanation: 'By Remainder Theorem, $p(1) = 1 - 2 + 3 - a + 8 = 5 \\implies 10 - a = 5 \\implies a = 5$.',
    isCommon: false,
    source: 'Seed',
    importSource: 'Seed',
    solutionHidden: false,
    isVerified: true,
  },
];

async function migrateQBLocalStorage() {
  try {
    assertDevOrTestDatabase();
  } catch (err) {
    console.warn('[MIGRATE_QB]: Dev/test database guard triggered, skipping local migration.');
    return { insertedCount: 0, backfilledCount: 0, skippedCount: 0 };
  }

  let insertedCount = 0;
  let skippedCount = 0;

  // A. Insert 5 seed questions from academicDataService.js (deduplicate by customId OR title+course)
  for (const item of SEED_QUESTIONS) {
    const existing = await Content.findOne({
      $or: [
        { customId: item.customId },
        { id: item.id },
        { title: item.title, course: item.course },
      ],
      isDeleted: { $ne: true },
    });

    if (existing) {
      skippedCount++;
    } else {
      await Content.create({
        ...item,
        uploadedBy: 'System Seeder',
        uploadedAt: new Date(),
      });
      insertedCount++;
    }
  }

  // B. Backfill existing MongoDB questions that have source: null or missing
  // Set source: 'Original', importSource: 'Manual' (since they predate AI Import)
  const backfillRes = await Content.updateMany(
    {
      type: { $in: ['question', 'questions', 'mcq'] },
      $or: [
        { source: null },
        { source: { $exists: false } },
        { source: 'Manual', importSource: { $exists: false } },
        { importSource: null },
      ],
    },
    {
      $set: {
        source: 'Original',
        importSource: 'Manual',
      },
    }
  );

  const backfilledCount = backfillRes.modifiedCount || 0;

  console.log(
    `Inserted ${insertedCount} seed questions, backfilled ${backfilledCount} questions, skipped ${skippedCount} duplicates.`
  );

  return { insertedCount, backfilledCount, skippedCount };
}

if (require.main === module) {
  mongoose
    .connect(process.env.MONGO_URI)
    .then(() => migrateQBLocalStorage())
    .then(() => mongoose.disconnect())
    .catch((err) => {
      console.error('Migration failed:', err);
      process.exit(1);
    });
}

module.exports = { migrateQBLocalStorage, SEED_QUESTIONS };
