#!/usr/bin/env node
/**
 * Seed Script: Inject Realistic Sample Questions for Question Bank
 * Cohorts covered: Engineering (CSE, ECE), B.Sc, and CBSE (Classes 9, 10, 11, 12)
 * Usage:
 *   node backend/scripts/seedQuestionBank.js --db=asmaths_lms_dev [--confirm]
 */

const dotenv = require('dotenv');
const path = require('path');
const mongoose = require('mongoose');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const { assertDevOrTestDatabase } = require('../utils/dbGuard');
const Content = require('../models/Content');

const SEED_QUESTIONS = [
  // ── 1. Engineering / CSE / Semester 1 ──
  {
    id: 'QB-ENG-CSE-S1-01',
    customId: 'QB-ENG-CSE-S1-01',
    title: 'Orthogonal Matrix Determinant Property',
    type: 'question',
    qType: 'MCQ',
    course: 'Engineering',
    branch: 'CSE',
    stream: 'CSE',
    semester: 'Semester 1',
    subject: 'Mathematics I',
    topic: 'Linear Algebra',
    difficulty: 'Easy',
    marks: 2,
    questionText: 'If $A$ is an orthogonal matrix of order $n$, then $\\det(A)$ is equal to:',
    options: ['$\\pm 1$', '$0$', '$n$', '$1$ only'],
    correctOption: 0,
    finalAnswer: '$\\pm 1$',
    steps: ['$A A^T = I \\implies \\det(A A^T) = \\det(I) \\implies (\\det A)^2 = 1 \\implies \\det A = \\pm 1$.'],
    explanation: 'Since $A A^T = I$, taking the determinant of both sides yields $(\\det A)^2 = 1$, which proves $\\det A = \\pm 1$.',
    isCommon: false,
    examYear: '2025',
  },
  {
    id: 'QB-ENG-CSE-S1-02',
    customId: 'QB-ENG-CSE-S1-02',
    title: 'Eigenvalues and Eigenvectors of 2x2 Matrix',
    type: 'question',
    qType: 'Subjective',
    course: 'Engineering',
    branch: 'CSE',
    stream: 'CSE',
    semester: 'Semester 1',
    subject: 'Mathematics I',
    topic: 'Linear Algebra',
    difficulty: 'Medium',
    marks: 10,
    questionText: 'Find the eigenvalues and corresponding eigenvectors of the matrix $A = \\begin{pmatrix} 2 & 1 \\\\ 1 & 2 \\end{pmatrix}$.',
    options: [],
    finalAnswer: '$\\lambda_1 = 3, v_1 = \\begin{pmatrix} 1 \\\\ 1 \\end{pmatrix}$; $\\lambda_2 = 1, v_2 = \\begin{pmatrix} 1 \\\\ -1 \\end{pmatrix}$',
    steps: [
      'Characteristic equation: $\\det(A - \\lambda I) = (2-\\lambda)^2 - 1 = 0 \\implies \\lambda^2 - 4\\lambda + 3 = 0$.',
      'Factoring yields $(\\lambda - 3)(\\lambda - 1) = 0$, so $\\lambda_1 = 3, \\lambda_2 = 1$.',
      'For $\\lambda = 3$: $(A - 3I)v = 0 \\implies -x_1 + x_2 = 0 \\implies v_1 = c(1, 1)^T$.',
      'For $\\lambda = 1$: $(A - I)v = 0 \\implies x_1 + x_2 = 0 \\implies v_2 = c(1, -1)^T$.',
    ],
    explanation: 'Solve characteristic equation for eigenvalues, then substitute into $(A-\\lambda I)v=0$ to obtain eigenvectors.',
    isCommon: false,
    examYear: '2024',
  },
  {
    id: 'QB-ENG-CSE-S1-03',
    customId: 'QB-ENG-CSE-S1-03',
    title: 'Fundamental Limit of sin(x)/x',
    type: 'question',
    qType: 'MCQ',
    course: 'Engineering',
    branch: 'CSE',
    stream: 'CSE',
    semester: 'Semester 1',
    subject: 'Mathematics I',
    topic: 'Differential Calculus',
    difficulty: 'Easy',
    marks: 1,
    questionText: 'The value of $\\lim_{x \\to 0} \\frac{\\sin(3x)}{x}$ is:',
    options: ['$3$', '$1$', '$0$', '$\\frac{1}{3}$'],
    correctOption: 0,
    finalAnswer: '$3$',
    steps: ['$\\lim_{x \\to 0} \\frac{\\sin(3x)}{x} = 3 \\cdot \\lim_{x \\to 0} \\frac{\\sin(3x)}{3x} = 3 \\cdot 1 = 3$.'],
    explanation: 'Using standard trigonometric limit $\\lim_{u \\to 0} \\frac{\\sin u}{u} = 1$ with $u=3x$.',
    isCommon: false,
  },
  {
    id: 'QB-ENG-CSE-S1-04',
    customId: 'QB-ENG-CSE-S1-04',
    title: 'Verification of Rolles Theorem',
    type: 'question',
    qType: 'Subjective',
    course: 'Engineering',
    branch: 'CSE',
    stream: 'CSE',
    semester: 'Semester 1',
    subject: 'Mathematics I',
    topic: 'Differential Calculus',
    difficulty: 'Medium',
    marks: 5,
    questionText: 'Verify Rolle\'s Theorem for $f(x) = x^2 - 4x + 3$ on the closed interval $[1, 3]$.',
    options: [],
    finalAnswer: '$c = 2 \\in (1, 3)$',
    steps: [
      '$f(x)$ is continuous on $[1, 3]$ as it is a polynomial.',
      '$f\'(x) = 2x - 4$ exists on $(1, 3)$, so $f(x)$ is differentiable.',
      '$f(1) = 1 - 4 + 3 = 0$ and $f(3) = 9 - 12 + 3 = 0$, so $f(1) = f(3)$.',
      'By Rolle\'s Theorem, $\\exists c \\in (1, 3)$ such that $f\'(c) = 0 \\implies 2c - 4 = 0 \\implies c = 2$.',
    ],
    explanation: 'All conditions of Rolle\'s theorem are satisfied, yielding critical point $c=2$.',
    isCommon: false,
  },

  // ── 2. Engineering / CSE / Semester 2 ──
  {
    id: 'QB-ENG-CSE-S2-01',
    customId: 'QB-ENG-CSE-S2-01',
    title: 'Divergence Theorem Surface Flux',
    type: 'question',
    qType: 'Subjective',
    course: 'Engineering',
    branch: 'CSE',
    stream: 'CSE',
    semester: 'Semester 2',
    subject: 'Mathematics II',
    topic: 'Vector Calculus',
    difficulty: 'Hard',
    marks: 15,
    questionText: 'Use the Divergence Theorem to evaluate $\\iint_S \\mathbf{F} \\cdot d\\mathbf{S}$, where $\\mathbf{F} = (2x, 3y, z^2)$ and $S$ is the surface of the unit sphere $x^2 + y^2 + z^2 = 1$.',
    options: [],
    finalAnswer: '$\\frac{20\\pi}{3}$',
    steps: [
      '$\\nabla \\cdot \\mathbf{F} = \\frac{\\partial}{\\partial x}(2x) + \\frac{\\partial}{\\partial y}(3y) + \\frac{\\partial}{\\partial z}(z^2) = 2 + 3 + 2z = 5 + 2z$.',
      '$\\iiint_V (5 + 2z) dV = 5 \\iiint_V dV + 2 \\iiint_V z dV$.',
      'By spherical symmetry, $\\iiint_V z dV = 0$. Volume of unit sphere $V = \\frac{4}{3}\\pi (1)^3$.',
      'Total flux $= 5 \\cdot \\frac{4}{3}\\pi = \\frac{20\\pi}{3}$.',
    ],
    explanation: 'Convert surface flux integral into a volume integral using Gauss Divergence Theorem.',
    isCommon: false,
  },

  // ── 3. Engineering / ECE / Semester 1 ──
  {
    id: 'QB-ENG-ECE-S1-01',
    customId: 'QB-ENG-ECE-S1-01',
    title: 'Roots of Complex Number Equation',
    type: 'question',
    qType: 'Subjective',
    course: 'Engineering',
    branch: 'ECE',
    stream: 'ECE',
    semester: 'Semester 1',
    subject: 'Mathematics I',
    topic: 'Complex Analysis',
    difficulty: 'Hard',
    marks: 8,
    questionText: 'Find all distinct roots of the equation $z^4 + 16 = 0$ in exponential polar form $r e^{i\\theta}$.',
    options: [],
    finalAnswer: '$z_k = 2 e^{i(\\frac{\\pi}{4} + \\frac{k\\pi}{2})}, k = 0, 1, 2, 3$',
    steps: [
      '$z^4 = -16 = 16 e^{i(\\pi + 2k\\pi)}$.',
      '$z_k = 16^{1/4} e^{i(\\frac{\\pi + 2k\\pi}{4})} = 2 e^{i(\\frac{\\pi}{4} + \\frac{k\\pi}{2})}$ for $k=0,1,2,3$.',
      'Roots are $2e^{i\\pi/4}, 2e^{i3\\pi/4}, 2e^{i5\\pi/4}, 2e^{i7\\pi/4}$.',
    ],
    explanation: 'Apply De Moivre\'s theorem to solve for the 4th roots of $-16$.',
    isCommon: false,
  },

  // ── 4. Engineering / Common First Year (All Branches) ──
  {
    id: 'QB-ENG-COM-S1-01',
    customId: 'QB-ENG-COM-S1-01',
    title: 'Real Eigenvalues of Symmetric Matrices',
    type: 'question',
    qType: 'True/False',
    course: 'Engineering',
    branch: 'All Branches',
    stream: 'All Branches',
    semester: 'Semester 1',
    subject: 'Basic Engineering Mathematics',
    topic: 'Matrix Algebra',
    difficulty: 'Easy',
    marks: 2,
    questionText: 'Every real symmetric matrix has only real eigenvalues.',
    options: ['True', 'False'],
    correctOption: 0,
    finalAnswer: 'True',
    steps: ['Let $Av = \\lambda v$. Since $A = A^T = A^*$, $\\lambda (v^* v) = v^* A v = v^* A^* v = \\bar{\\lambda} (v^* v) \\implies \\lambda = \\bar{\\lambda}$.'],
    explanation: 'Spectral theorem for real symmetric matrices guarantees that all eigenvalues are real numbers.',
    isCommon: true,
  },

  // ── 5. B.Sc Mathematics / Honours / Semester 1 ──
  {
    id: 'QB-BSC-HON-S1-01',
    customId: 'QB-BSC-HON-S1-01',
    title: 'Monotone Convergence Theorem Proof',
    type: 'question',
    qType: 'Subjective',
    course: 'B.Sc',
    branch: 'B.Sc (Honours) (Major)',
    stream: 'B.Sc (Honours) (Major)',
    semester: 'Semester 1',
    subject: 'Real Analysis',
    topic: 'Sequences and Series',
    difficulty: 'Medium',
    marks: 10,
    questionText: 'State and prove the Monotone Convergence Theorem for a bounded increasing sequence of real numbers.',
    options: [],
    finalAnswer: '$\\lim_{n \\to \\infty} a_n = \\sup \\{a_n : n \\in \\mathbb{N}\\}$',
    steps: [
      'Statement: Every bounded monotonic sequence in $\\mathbb{R}$ converges.',
      'Proof: Let $S = \\{a_n : n \\in \\mathbb{N}\\}$. Since $(a_n)$ is bounded above, by Completeness Axiom of $\\mathbb{R}$, $L = \\sup S$ exists.',
      'For any $\\epsilon > 0$, $L - \\epsilon$ is not an upper bound, so $\\exists N \\in \\mathbb{N}$ such that $a_N > L - \\epsilon$.',
      'Since $(a_n)$ is increasing, $\\forall n \\ge N, L - \\epsilon < a_N \\le a_n \\le L < L + \\epsilon$.',
      'Hence $|a_n - L| < \\epsilon$ for all $n \\ge N$, proving $\\lim a_n = L$.',
    ],
    explanation: 'Uses the completeness axiom of real numbers to establish convergence to the supremum.',
    isCommon: false,
  },
  {
    id: 'QB-BSC-HON-S1-02',
    customId: 'QB-BSC-HON-S1-02',
    title: 'Limit Superior of Alternating Sequence',
    type: 'question',
    qType: 'Fill-in-the-blank',
    course: 'B.Sc',
    branch: 'B.Sc (Honours) (Major)',
    stream: 'B.Sc (Honours) (Major)',
    semester: 'Semester 1',
    subject: 'Real Analysis',
    topic: 'Sequences and Series',
    difficulty: 'Easy',
    marks: 2,
    questionText: 'For the sequence $a_n = (-1)^n + \\frac{1}{n}$, the limit superior $\\limsup_{n \\to \\infty} a_n$ is equal to ____.',
    options: [],
    finalAnswer: '$1$',
    steps: ['Subsequence for even $n$: $a_{2k} = 1 + \\frac{1}{2k} \\to 1$. Subsequence for odd $n$: $a_{2k-1} = -1 + \\frac{1}{2k-1} \\to -1$. Largest subsequential limit is $1$.'],
    explanation: 'The subsequential limits are $-1$ and $+1$; hence the supremum of limits is $1$.',
    isCommon: false,
  },

  // ── 6. CBSE / Class 10 ──
  {
    id: 'QB-CBSE-C10-01',
    customId: 'QB-CBSE-C10-01',
    title: 'Nature of Roots of Quadratic Equation',
    type: 'question',
    qType: 'MCQ',
    course: 'CBSE',
    board: 'CBSE',
    branch: 'CBSE Standard',
    classLevel: 'Class 10',
    class: 'Class 10',
    classNumber: 10,
    semester: 'Class 10',
    subject: 'Class 10 Mathematics',
    topic: 'Quadratic Equations',
    difficulty: 'Easy',
    marks: 1,
    questionText: 'The discriminant of the quadratic equation $2x^2 - 4x + 3 = 0$ is:',
    options: ['$-8$ (No real roots)', '$8$ (Two real roots)', '$0$ (Equal roots)', '$-24$'],
    correctOption: 0,
    finalAnswer: '$-8$',
    steps: ['$D = b^2 - 4ac = (-4)^2 - 4(2)(3) = 16 - 24 = -8 < 0$.'],
    explanation: 'Since $D < 0$, the quadratic equation has no real roots.',
    isCommon: false,
    examYear: '2024',
  },
  {
    id: 'QB-CBSE-C10-02',
    customId: 'QB-CBSE-C10-02',
    title: 'Word Problem on Quadratic Equation',
    type: 'question',
    qType: 'Subjective',
    course: 'CBSE',
    board: 'CBSE',
    branch: 'CBSE Standard',
    classLevel: 'Class 10',
    class: 'Class 10',
    classNumber: 10,
    semester: 'Class 10',
    subject: 'Class 10 Mathematics',
    topic: 'Quadratic Equations',
    difficulty: 'Medium',
    marks: 4,
    questionText: 'Solve for $x$: $\\frac{1}{x+4} - \\frac{1}{x-7} = \\frac{11}{30}$ where $x \\ne -4, 7$.',
    options: [],
    finalAnswer: '$x = 1$ or $x = 2$',
    steps: [
      '$\\frac{(x-7) - (x+4)}{(x+4)(x-7)} = \\frac{11}{30} \\implies \\frac{-11}{x^2 - 3x - 28} = \\frac{11}{30}$.',
      'Dividing by $11$: $\\frac{-1}{x^2 - 3x - 28} = \\frac{1}{30} \\implies x^2 - 3x - 28 = -30$.',
      '$x^2 - 3x + 2 = 0 \\implies (x-1)(x-2) = 0 \\implies x = 1$ or $x = 2$.',
    ],
    explanation: 'Simplify fractions and solve resulting quadratic $x^2 - 3x + 2 = 0$.',
    isCommon: false,
  },

  // ── 7. CBSE / Class 12 ──
  {
    id: 'QB-CBSE-C12-01',
    customId: 'QB-CBSE-C12-01',
    title: 'Definite Integral Symmetry Evaluation',
    type: 'question',
    qType: 'MCQ',
    course: 'CBSE',
    board: 'CBSE',
    branch: 'CBSE Standard',
    classLevel: 'Class 12',
    class: 'Class 12',
    classNumber: 12,
    semester: 'Class 12',
    subject: 'Class 12 Mathematics',
    topic: 'Definite Integrals',
    difficulty: 'Medium',
    marks: 2,
    questionText: 'Evaluate the definite integral $I = \\int_{0}^{\\pi/2} \\frac{\\sqrt{\\sin x}}{\\sqrt{\\sin x} + \\sqrt{\\cos x}} \\, dx$.',
    options: ['$\\frac{\\pi}{4}$', '$\\frac{\\pi}{2}$', '$1$', '$0$'],
    correctOption: 0,
    finalAnswer: '$\\frac{\\pi}{4}$',
    steps: [
      'Using property $\\int_0^a f(x)dx = \\int_0^a f(a-x)dx$:',
      '$I = \\int_0^{\\pi/2} \\frac{\\sqrt{\\cos x}}{\\sqrt{\\cos x} + \\sqrt{\\sin x}} dx$.',
      'Adding both: $2I = \\int_0^{\\pi/2} 1 \\, dx = \\frac{\\pi}{2} \\implies I = \\frac{\\pi}{4}$.',
    ],
    explanation: 'Classic King\'s property of definite integrals yields $2I = \\pi/2$.',
    isCommon: false,
    examYear: '2025',
  },
  {
    id: 'QB-CBSE-C12-02',
    customId: 'QB-CBSE-C12-02',
    title: 'Area Under Curve Bounded by Triangle',
    type: 'question',
    qType: 'Subjective',
    course: 'CBSE',
    board: 'CBSE',
    branch: 'CBSE Standard',
    classLevel: 'Class 12',
    class: 'Class 12',
    classNumber: 12,
    semester: 'Class 12',
    subject: 'Class 12 Mathematics',
    topic: 'Applications of Integrals',
    difficulty: 'Hard',
    marks: 6,
    questionText: 'Using integration, find the area of the triangular region whose vertices are $A(1, 0)$, $B(2, 2)$, and $C(3, 1)$.',
    options: [],
    finalAnswer: '$\\frac{3}{2}$ sq. units',
    steps: [
      'Equation of line $AB$: $y - 0 = \\frac{2-0}{2-1}(x-1) \\implies y = 2(x-1)$.',
      'Equation of line $BC$: $y - 2 = \\frac{1-2}{3-2}(x-2) \\implies y = 4 - x$.',
      'Equation of line $AC$: $y - 0 = \\frac{1-0}{3-1}(x-1) \\implies y = \\frac{x-1}{2}$.',
      'Area $= \\int_1^2 [2(x-1) - \\frac{x-1}{2}] dx + \\int_2^3 [(4-x) - \\frac{x-1}{2}] dx = 1 + \\frac{1}{2} = \\frac{3}{2}$.',
    ],
    explanation: 'Set up equations of the three sides and compute piecewise definite integrals.',
    isCommon: false,
  },

  // ── 8. CBSE / Class 9 ──
  {
    id: 'QB-CBSE-C09-01',
    customId: 'QB-CBSE-C09-01',
    title: 'Unique Zero of Linear Polynomial',
    type: 'question',
    qType: 'True/False',
    course: 'CBSE',
    board: 'CBSE',
    branch: 'CBSE Standard',
    classLevel: 'Class 9',
    class: 'Class 9',
    classNumber: 9,
    semester: 'Class 9',
    subject: 'Class 9 Mathematics',
    topic: 'Polynomials',
    difficulty: 'Easy',
    marks: 1,
    questionText: 'Every linear polynomial in one variable has exactly one unique real zero.',
    options: ['True', 'False'],
    correctOption: 0,
    finalAnswer: 'True',
    steps: ['$P(x) = ax + b$ with $a \\ne 0$. $P(x) = 0 \\implies x = -b/a$, which is unique.'],
    explanation: 'A linear polynomial $ax+b$ ($a \\ne 0$) has one unique root $x = -b/a$.',
    isCommon: false,
  },

  // ── 9. CBSE / Class 11 ──
  {
    id: 'QB-CBSE-C11-01',
    customId: 'QB-CBSE-C11-01',
    title: 'Standard Equation of Ellipse',
    type: 'question',
    qType: 'Subjective',
    course: 'CBSE',
    board: 'CBSE',
    branch: 'CBSE Standard',
    classLevel: 'Class 11',
    class: 'Class 11',
    classNumber: 11,
    semester: 'Class 11',
    subject: 'Class 11 Mathematics',
    topic: 'Conic Sections',
    difficulty: 'Medium',
    marks: 5,
    questionText: 'Find the equation of the ellipse whose vertices are $(\\pm 5, 0)$ and foci are $(\\pm 4, 0)$.',
    options: [],
    finalAnswer: '$\\frac{x^2}{25} + \\frac{y^2}{9} = 1$',
    steps: [
      'Vertices on x-axis: $a = 5$. Foci: $c = 4$.',
      'Relation: $b^2 = a^2 - c^2 = 25 - 16 = 9 \\implies b = 3$.',
      'Standard horizontal equation: $\\frac{x^2}{a^2} + \\frac{y^2}{b^2} = 1 \\implies \\frac{x^2}{25} + \\frac{y^2}{9} = 1$.',
    ],
    explanation: 'Determine major semi-axis $a$ and focal distance $c$, then calculate minor semi-axis $b$.',
    isCommon: false,
  },
];

async function seed() {
  const args = process.argv.slice(2);
  const dbArg = args.find((a) => a.startsWith('--db='));
  const isConfirm = args.includes('--confirm');

  const targetDb = dbArg ? dbArg.split('=')[1].trim() : 'asmaths_lms_dev';
  assertDevOrTestDatabase(targetDb);

  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) {
    console.error('❌ MONGO_URI missing from environment');
    process.exit(1);
  }

  console.log(`🔌 Connecting to MongoDB: database "${targetDb}"...`);
  await mongoose.connect(mongoUri, { dbName: targetDb });
  assertDevOrTestDatabase(mongoose.connection.name);
  console.log(`✅ Operating on verified DEV/TEST database: "${mongoose.connection.name}"`);

  console.log(`\n📋 Prepared ${SEED_QUESTIONS.length} realistic questions across Engineering, B.Sc, and CBSE.`);

  if (!isConfirm) {
    console.log('⚠️ DRY-RUN MODE: Re-run with --confirm to insert seed questions into DEV database:');
    console.log(`   node backend/scripts/seedQuestionBank.js --db=${targetDb} --confirm\n`);
    await mongoose.disconnect();
    return;
  }

  let upsertedCount = 0;
  for (const q of SEED_QUESTIONS) {
    await Content.findOneAndUpdate(
      { $or: [{ id: q.id }, { customId: q.customId }] },
      { $set: { ...q, isDeleted: false, updatedAt: new Date() } },
      { upsert: true, new: true }
    );
    upsertedCount++;
  }

  console.log(`🎉 Successfully seeded ${upsertedCount} sample questions into "${targetDb}".\n`);
  await mongoose.disconnect();
}

if (require.main === module) {
  seed().catch((err) => {
    console.error('Seed error:', err.message);
    process.exit(1);
  });
}

module.exports = { SEED_QUESTIONS, seed };
