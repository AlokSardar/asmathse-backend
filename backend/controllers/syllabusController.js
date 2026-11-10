const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');
const { PDFParse } = require('pdf-parse');
const Syllabus = require('../models/Syllabus');
const { dbGuard } = require('../utils/dbGuard');
const { normalizeCohortItem } = require('../utils/cohortNormalize');

// Ensure local uploads/syllabus directory exists on the filesystem (Amendment 5)
const syllabusDir = path.join(__dirname, '..', 'uploads', 'syllabus');
if (!fs.existsSync(syllabusDir)) {
  fs.mkdirSync(syllabusDir, { recursive: true });
}

/**
 * 28 Canonical Subjects from academicStructure.js (Amendment 2)
 */
const CANONICAL_CURRICULUM_DATA = [
  // ── ENGINEERING (8 SEMESTERS) ──
  {
    course: 'Engineering',
    branch: 'CSE',
    semester: 'Semester 1',
    subjectCode: 'BS-M101',
    subjectName: 'Mathematics I (Calculus & Linear Algebra)',
    credits: 4,
    totalHours: 44,
    description: 'Foundational course covering Differential & Integral Calculus, Matrices & Linear Systems, Vector Spaces, and Multivariable Differentiation for first-year engineers.',
    textbooks: [
      { title: 'Higher Engineering Mathematics', author: 'B.S. Grewal', edition: '44th Edition', type: 'prescribed' },
      { title: 'Advanced Engineering Mathematics', author: 'Erwin Kreyszig', edition: '10th Edition', type: 'reference' },
    ],
    examPattern: { internalAssessment: 30, midSemester: 20, endSemester: 50 },
    modules: [
      { id: 'MOD-1', moduleNumber: 1, title: 'Differential & Integral Calculus', hours: 10, topics: ['Evolutes and Involutes', 'Beta and Gamma Functions', "Rolle's & Mean Value Theorems", "Taylor's & Maclaurin's Series"] },
      { id: 'MOD-2', moduleNumber: 2, title: 'Matrices & System of Linear Equations', hours: 10, topics: ['Rank of a Matrix & Echelon Form', 'Gauss-Jordan Elimination', 'Eigenvalues & Eigenvectors', 'Cayley-Hamilton Theorem'] },
      { id: 'MOD-3', moduleNumber: 3, title: 'Vector Spaces & Linear Transformations', hours: 10, topics: ['Vector Spaces & Subspaces', 'Linear Independence & Basis', 'Rank-Nullity Theorem', 'Orthogonalization (Gram-Schmidt)'] },
      { id: 'MOD-4', moduleNumber: 4, title: 'Multivariable Calculus (Differentiation)', hours: 8, topics: ['Partial Derivatives & Chain Rule', 'Directional Derivatives & Gradient', 'Maxima, Minima & Saddle Points', 'Lagrange Multipliers'] },
      { id: 'MOD-5', moduleNumber: 5, title: 'Sequences & Infinite Series', hours: 8, topics: ['Convergence Tests (Ratio, Root, Comparison)', 'Alternating Series & Leibniz Rule', 'Power Series & Radius of Convergence', 'Fourier Series Fundamentals'] },
    ],
  },
  {
    course: 'Engineering',
    branch: 'CSE',
    semester: 'Semester 2',
    subjectCode: 'BS-M201',
    subjectName: 'Mathematics II (ODE, Complex Analysis & Laplace)',
    credits: 4,
    totalHours: 46,
    description: 'Comprehensive study of Ordinary Differential Equations, Laplace Transforms, Complex Analysis and Vector Calculus.',
    textbooks: [
      { title: 'Advanced Engineering Mathematics', author: 'Erwin Kreyszig', edition: '10th Edition', type: 'prescribed' },
      { title: 'Complex Variables and Applications', author: 'James Ward Brown & Ruel V. Churchill', edition: '9th Edition', type: 'reference' },
    ],
    examPattern: { internalAssessment: 30, midSemester: 20, endSemester: 50 },
    modules: [
      { id: 'MOD-1', moduleNumber: 1, title: 'First & Higher Order Ordinary Differential Equations', hours: 10, topics: ['Exact & Linear ODEs', 'Method of Undetermined Coefficients', 'Variation of Parameters', 'Cauchy-Euler Equations'] },
      { id: 'MOD-2', moduleNumber: 2, title: 'Laplace Transforms & Initial Value Problems', hours: 10, topics: ['Laplace Transform of Elementary Functions', 'Shifting Theorems & Unit Step Function', 'Convolution Theorem', 'Solving ODEs via Laplace Transform'] },
      { id: 'MOD-3', moduleNumber: 3, title: 'Complex Variables — Differentiation', hours: 8, topics: ['Analytic Functions & Cauchy-Riemann Equations', 'Harmonic Functions & Milne-Thomson Method', 'Conformal Mapping & Mobius Transformations'] },
      { id: 'MOD-4', moduleNumber: 4, title: 'Complex Integration & Residue Calculus', hours: 10, topics: ["Cauchy's Integral Theorem & Formula", 'Taylor & Laurent Series Expansions', 'Zeros, Singularities & Residues', 'Contour Integration of Real Integrals'] },
      { id: 'MOD-5', moduleNumber: 5, title: 'Multiple Integrals & Vector Integral Calculus', hours: 8, topics: ['Double & Triple Integrals', 'Change of Order of Integration', "Green's, Gauss Divergence & Stokes' Theorems"] },
    ],
  },
  {
    course: 'Engineering',
    branch: 'CSE',
    semester: 'Semester 3',
    subjectCode: 'BS-M301',
    subjectName: 'Mathematics III (Probability, Statistics & PDE)',
    credits: 4,
    totalHours: 46,
    description: 'Partial differential equations, probability theory, distributions, statistical inference and Fourier/Z transforms.',
    modules: [
      { id: 'MOD-1', moduleNumber: 1, title: 'Partial Differential Equations', hours: 10, topics: ["Lagrange's Linear PDE", "Charpit's Method", 'Separation of Variables', 'Wave, Heat & Laplace Equations'] },
      { id: 'MOD-2', moduleNumber: 2, title: 'Probability Theory & Random Variables', hours: 10, topics: ['Conditional Probability & Bayes Theorem', 'Discrete & Continuous Random Variables', 'Expectation, Variance & Moment Generating Functions'] },
      { id: 'MOD-3', moduleNumber: 3, title: 'Probability Distributions', hours: 8, topics: ['Binomial, Poisson & Geometric Distributions', 'Uniform, Exponential & Normal Distributions', 'Central Limit Theorem'] },
      { id: 'MOD-4', moduleNumber: 4, title: 'Statistical Inference & Hypothesis Testing', hours: 10, topics: ['Sampling Distributions (t, Chi-Square, F)', 'Point & Interval Estimation', 'Z-Test, t-Test & Chi-Square Goodness of Fit'] },
      { id: 'MOD-5', moduleNumber: 5, title: 'Fourier Transforms & Z-Transforms', hours: 8, topics: ['Fourier Sine & Cosine Transforms', "Convolution & Parseval's Identity", 'Z-Transform & Difference Equations'] },
    ],
  },
  {
    course: 'Engineering',
    branch: 'CSE',
    semester: 'Semester 4',
    subjectCode: 'PCC-CS401',
    subjectName: 'Discrete Mathematics & Numerical Methods',
    credits: 4,
    totalHours: 46,
    modules: [
      { id: 'MOD-1', moduleNumber: 1, title: 'Set Theory, Relations & Lattice Theory', hours: 8, topics: ['Equivalence Relations & Posets', 'Hasse Diagrams & Lattices', 'Boolean Algebra & Logic Gates'] },
      { id: 'MOD-2', moduleNumber: 2, title: 'Propositional & Predicate Logic', hours: 8, topics: ['Well-Formed Formulas & Tautologies', 'Rules of Inference', 'Quantifiers & First-Order Logic'] },
      { id: 'MOD-3', moduleNumber: 3, title: 'Combinatorics & Recurrence Relations', hours: 10, topics: ['Pigeonhole Principle & Inclusion-Exclusion', 'Generating Functions', 'Linear Recurrence Relations'] },
      { id: 'MOD-4', moduleNumber: 4, title: 'Graph Theory & Trees', hours: 10, topics: ['Eulerian & Hamiltonian Graphs', 'Planar Graphs & Chromatic Number', 'Spanning Trees (Kruskal & Prim)', "Dijkstra's Shortest Path"] },
      { id: 'MOD-5', moduleNumber: 5, title: 'Numerical Analysis & Interpolation', hours: 10, topics: ['Newton-Raphson & Regula-Falsi', 'Lagrange & Newton Divided Difference', "Trapezoidal & Simpson's 1/3 Rule", 'Runge-Kutta 4th Order Method'] },
    ],
  },
  {
    course: 'Engineering',
    branch: 'CSE',
    semester: 'Semester 5',
    subjectCode: 'PEC-M501',
    subjectName: 'Optimization Techniques & Operations Research',
    credits: 3,
    totalHours: 36,
    modules: [
      { id: 'MOD-1', moduleNumber: 1, title: 'Linear Programming & Simplex Method', hours: 10, topics: ['Formulation of LPP', 'Simplex, Big-M & Two-Phase Methods', 'Duality Theory & Dual Simplex'] },
      { id: 'MOD-2', moduleNumber: 2, title: 'Transportation & Assignment Models', hours: 8, topics: ['Vogel Approximation Method (VAM)', 'MODI Optimality Test', "Hungarian Algorithm for Assignment"] },
      { id: 'MOD-3', moduleNumber: 3, title: 'Game Theory & Decision Analysis', hours: 8, topics: ['Two-Person Zero-Sum Games', 'Minimax & Maximin Principles', 'Dominance Property & Graphical Solution'] },
      { id: 'MOD-4', moduleNumber: 4, title: 'Non-Linear & Dynamic Programming', hours: 10, topics: ["Kuhn-Tucker (KKT) Conditions", 'Quadratic Programming', "Bellman's Principle of Optimality"] },
    ],
  },
  {
    course: 'Engineering',
    branch: 'CSE',
    semester: 'Semester 6',
    subjectCode: 'PEC-M601',
    subjectName: 'Graph Theory & Combinatorics',
    credits: 3,
    totalHours: 36,
    modules: [
      { id: 'MOD-1', moduleNumber: 1, title: 'Structural Graph Theory & Connectivity', hours: 10, topics: ['Cut-vertices, Bridges & Blocks', 'Menger Theorem & Vertex Connectivity', "Whitney's Theorem"] },
      { id: 'MOD-2', moduleNumber: 2, title: 'Matchings, Factors & Colorings', hours: 8, topics: ["Hall's Marriage Theorem", "Tutte's 1-Factor Theorem", 'Edge Coloring & Vizing Theorem', 'Four Color Theorem & Brook Theorem'] },
      { id: 'MOD-3', moduleNumber: 3, title: 'Enumerative Combinatorics & Polya Theory', hours: 10, topics: ['Stirling Numbers of 1st & 2nd Kind', 'Burnside Lemma', "Polya's Enumeration Theorem"] },
      { id: 'MOD-4', moduleNumber: 4, title: 'Ramsey Theory & Extremal Graphs', hours: 8, topics: ['Ramsey Numbers R(m,n)', "Turan's Extremal Theorem", 'Probabilistic Method in Combinatorics'] },
    ],
  },
  {
    course: 'Engineering',
    branch: 'CSE',
    semester: 'Semester 7',
    subjectCode: 'OEC-M701',
    subjectName: 'Mathematical Modeling & Cryptography',
    credits: 3,
    totalHours: 36,
    modules: [
      { id: 'MOD-1', moduleNumber: 1, title: 'Classical & Number-Theoretic Cryptography', hours: 10, topics: ['Modular Arithmetic & Extended Euclidean Algorithm', 'Fermat Little Theorem & Euler Totient', 'Chinese Remainder Theorem'] },
      { id: 'MOD-2', moduleNumber: 2, title: 'Public Key Cryptosystems & RSA', hours: 10, topics: ['RSA Algorithm & Primality Testing (Miller-Rabin)', 'Diffie-Hellman Key Exchange', 'Discrete Logarithm Problem'] },
      { id: 'MOD-3', moduleNumber: 3, title: 'Elliptic Curve Cryptography (ECC)', hours: 8, topics: ['Elliptic Curves over Finite Fields', 'Group Law on Cubic Curves', 'ECDSA & Modern Blockchain Applications'] },
      { id: 'MOD-4', moduleNumber: 4, title: 'Stochastic & Deterministic Modeling', hours: 8, topics: ['Lotka-Volterra Predator-Prey Models', 'SIR Epidemic Modeling', 'Markov Chains & PageRank Algorithm'] },
    ],
  },
  {
    course: 'Engineering',
    branch: 'CSE',
    semester: 'Semester 8',
    subjectCode: 'PROJ-M801',
    subjectName: 'Capstone Project & Applied Mathematics Seminar',
    credits: 6,
    totalHours: 40,
    modules: [
      { id: 'MOD-1', moduleNumber: 1, title: 'Computational Project Formulation', hours: 10, topics: ['Literature Survey & Problem Statement', 'Mathematical Formulation & Complexity Bounds'] },
      { id: 'MOD-2', moduleNumber: 2, title: 'Numerical Simulation & Algorithmic Implementation', hours: 12, topics: ['Scientific Computing in Python/MATLAB', 'Validation against Analytical Benchmarks'] },
      { id: 'MOD-3', moduleNumber: 3, title: 'Result Verification & Sensitivity Analysis', hours: 10, topics: ['Convergence Proofs & Error Bounds', 'Monte Carlo Validation'] },
      { id: 'MOD-4', moduleNumber: 4, title: 'Dissertation & Peer Defense', hours: 8, topics: ['Technical Report Preparation (LaTeX)', 'Viva-Voce & Defense Presentation'] },
    ],
  },

  // ── B.SC MATHEMATICS (6 SEMESTERS) ──
  {
    course: 'B.Sc',
    branch: 'B.Sc (Honours) (Major)',
    semester: 'Semester 1',
    subjectCode: 'BMATH-CC101',
    subjectName: 'Real Analysis & Calculus',
    credits: 6,
    totalHours: 50,
    modules: [
      { id: 'MOD-1', moduleNumber: 1, title: 'Real Number System & Point Set Topology', hours: 14, topics: ['Dedekind Cuts & Completeness Axiom', 'Archimedean Property & Density of Q', 'Open, Closed & Compact Sets', 'Bolzano-Weierstrass Theorem'] },
      { id: 'MOD-2', moduleNumber: 2, title: 'Sequences & Series of Real Numbers', hours: 12, topics: ['Cauchy Sequences & Cauchy Criterion', 'Monotone Convergence Theorem', 'Subsequences & Limit Superior/Inferior', 'Absolute & Conditional Convergence'] },
      { id: 'MOD-3', moduleNumber: 3, title: 'Continuity & Uniform Continuity', hours: 12, topics: ['Intermediate Value Theorem', 'Weierstrass Extreme Value Theorem', 'Uniform Continuity & Lipschitz Functions'] },
      { id: 'MOD-4', moduleNumber: 4, title: 'Differentiability & Mean Value Theorems', hours: 12, topics: ["Darboux's Theorem on Derivatives", 'Cauchy Mean Value Theorem', "Taylor's Theorem with Lagrange & Cauchy Remainders"] },
    ],
  },
  {
    course: 'B.Sc',
    branch: 'B.Sc (Honours) (Major)',
    semester: 'Semester 2',
    subjectCode: 'BMATH-CC201',
    subjectName: 'Abstract Algebra (Group Theory & Ring Theory)',
    credits: 6,
    totalHours: 50,
    modules: [
      { id: 'MOD-1', moduleNumber: 1, title: 'Groups, Subgroups & Cyclic Groups', hours: 14, topics: ['Definition, Examples (Symmetric, Dihedral, Klein-4)', 'Subgroup Criteria & Centers of Groups', 'Cyclic Generators & Classification'] },
      { id: 'MOD-2', moduleNumber: 2, title: 'Cosets, Lagrange Theorem & Normal Subgroups', hours: 12, topics: ["Lagrange's Theorem & Applications", 'Normal Subgroups & Quotient Groups', 'Center of a Group & Conjugacy Classes'] },
      { id: 'MOD-3', moduleNumber: 3, title: 'Homomorphisms & Isomorphism Theorems', hours: 12, topics: ['First, Second & Third Isomorphism Theorems', "Cayley's Representation Theorem", 'Automorphisms & Inner Automorphisms'] },
      { id: 'MOD-4', moduleNumber: 4, title: 'Introduction to Rings & Fields', hours: 12, topics: ['Rings, Integral Domains & Division Rings', 'Ideals & Quotient Rings', 'Characteristic of a Ring & Prime/Maximal Ideals'] },
    ],
  },
  {
    course: 'B.Sc',
    branch: 'B.Sc (Honours) (Major)',
    semester: 'Semester 3',
    subjectCode: 'BMATH-CC301',
    subjectName: 'Ordinary & Partial Differential Equations',
    credits: 6,
    totalHours: 50,
    modules: [
      { id: 'MOD-1', moduleNumber: 1, title: 'Higher Order Linear Differential Equations', hours: 14, topics: ['Wronskian & Linear Independence of Solutions', 'Cauchy-Euler Equidimensional Equations', 'Power Series Solutions & Frobenius Method'] },
      { id: 'MOD-2', moduleNumber: 2, title: 'Special Functions', hours: 12, topics: ["Legendre's Polynomials & Generating Function", "Bessel's Functions of 1st & 2nd Kind", 'Orthogonality of Bessel & Legendre Functions'] },
      { id: 'MOD-3', moduleNumber: 3, title: 'Systems of Linear Differential Equations', hours: 12, topics: ['Phase Plane Analysis & Autonomous Systems', 'Critical Points, Nodes, Saddles & Stability', 'Matrix Method for Linear ODE Systems'] },
      { id: 'MOD-4', moduleNumber: 4, title: 'First & Second Order Partial Differential Equations', hours: 12, topics: ["Pfaffian Differential Equations", 'Cauchy Problem for Quasilinear PDE', 'Classification of 2nd Order PDE (Hyperbolic, Elliptic, Parabolic)'] },
    ],
  },
  {
    course: 'B.Sc',
    branch: 'B.Sc (Honours) (Major)',
    semester: 'Semester 4',
    subjectCode: 'BMATH-CC401',
    subjectName: 'Multivariate Calculus & Tensor Analysis',
    credits: 6,
    totalHours: 50,
    modules: [
      { id: 'MOD-1', moduleNumber: 1, title: 'Functions of Several Variables', hours: 14, topics: ['Fréchet & Gâteaux Derivatives', 'Jacobian Matrix & Implicit Function Theorem', 'Inverse Function Theorem'] },
      { id: 'MOD-2', moduleNumber: 2, title: 'Riemann Integration in Rn', hours: 12, topics: ["Darboux Sums & Integrability in R^2 and R^3", "Fubini's Theorem", 'Change of Variables in Multiple Integrals'] },
      { id: 'MOD-3', moduleNumber: 3, title: 'Differential Forms & Stokes Theorem', hours: 12, topics: ['Exterior Algebra & k-Forms', 'Exterior Derivative & Poincaré Lemma', 'Generalised Stokes Theorem on Manifolds'] },
      { id: 'MOD-4', moduleNumber: 4, title: 'Tensor Calculus Foundations', hours: 12, topics: ['Coordinate Transformations & Einstein Summation', 'Contravariant & Covariant Tensors', 'Metric Tensor & Christoffel Symbols'] },
    ],
  },
  {
    course: 'B.Sc',
    branch: 'B.Sc (Honours) (Major)',
    semester: 'Semester 5',
    subjectCode: 'BMATH-DSE501',
    subjectName: 'Metric Spaces & Complex Analysis',
    credits: 6,
    totalHours: 50,
    modules: [
      { id: 'MOD-1', moduleNumber: 1, title: 'Metric Spaces Topology', hours: 14, topics: ['Open Balls, Topology Induced by Metrics', 'Convergence, Cauchy Sequences & Completeness', "Cantor's Intersection Theorem", "Baire's Category Theorem"] },
      { id: 'MOD-2', moduleNumber: 2, title: 'Compactness & Connectedness in Metric Spaces', hours: 12, topics: ['Heine-Borel Theorem in R^n', 'Sequential Compactness & Total Boundedness', 'Connectedness & Intermediate Value Property'] },
      { id: 'MOD-3', moduleNumber: 3, title: 'Complex Differentiability & Contour Integration', hours: 12, topics: ['Analytic Functions & CR Equations in Polar Form', "Cauchy-Goursat Theorem", "Morera's & Liouville's Theorems"] },
      { id: 'MOD-4', moduleNumber: 4, title: 'Singularities & Argument Principle', hours: 12, topics: ["Riemann's Theorem on Removable Singularities", "Casorati-Weierstrass Theorem", "Rouché's Theorem & Argument Principle"] },
    ],
  },
  {
    course: 'B.Sc',
    branch: 'B.Sc (Honours) (Major)',
    semester: 'Semester 6',
    subjectCode: 'BMATH-DSE601',
    subjectName: 'Linear Algebra & Functional Analysis',
    credits: 6,
    totalHours: 50,
    modules: [
      { id: 'MOD-1', moduleNumber: 1, title: 'Vector Spaces & Dual Spaces', hours: 14, topics: ['Quotient Spaces & Direct Sums', 'Dual Basis & Annihilators', 'Transpose of a Linear Transformation'] },
      { id: 'MOD-2', moduleNumber: 2, title: 'Inner Product Spaces & Spectral Theory', hours: 12, topics: ['Orthogonal Complements & Projections', 'Self-Adjoint, Unitary & Normal Operators', 'Spectral Decomposition Theorem'] },
      { id: 'MOD-3', moduleNumber: 3, title: 'Normed Linear Spaces & Banach Spaces', hours: 12, topics: ['Definition, Examples (l_p, C[a,b])', 'Equivalent Norms & Riesz Lemma', 'Bounded Linear Operators & Duals'] },
      { id: 'MOD-4', moduleNumber: 4, title: 'Fundamental Theorems of Functional Analysis', hours: 12, topics: ['Hahn-Banach Theorem', 'Open Mapping Theorem & Closed Graph Theorem', 'Uniform Boundedness Principle (Banach-Steinhaus)'] },
    ],
  },

  // ── CBSE (CLASSES 9 TO 12) ──
  {
    course: 'CBSE',
    branch: 'CBSE Standard',
    semester: 'Class 9',
    classLevel: 'Class 9',
    subjectCode: 'CBSE-MATH-IX',
    subjectName: 'CBSE Class 9 Mathematics',
    credits: 4,
    totalHours: 40,
    modules: [
      { id: 'MOD-1', moduleNumber: 1, title: 'Number Systems & Polynomial Algebra', hours: 20, topics: ['Real Numbers & Irrationality', 'Polynomial Remainder & Factor Theorems', 'Linear Equations in Two Variables & Coordinate Geometry'] },
      { id: 'MOD-2', moduleNumber: 2, title: 'Euclid Geometry, Triangles & Circles', hours: 20, topics: ['Lines and Angles & Triangle Congruence', 'Quadrilaterals & Circle Theorems', "Heron's Formula & Surface Areas/Volumes"] },
    ],
  },
  {
    course: 'CBSE',
    branch: 'CBSE Standard',
    semester: 'Class 10',
    classLevel: 'Class 10',
    subjectCode: 'CBSE-MATH-X',
    subjectName: 'CBSE Class 10 Board Mathematics',
    credits: 4,
    totalHours: 42,
    modules: [
      { id: 'MOD-1', moduleNumber: 1, title: 'Real Numbers, Polynomials & Quadratic Equations', hours: 22, topics: ['Fundamental Theorem of Arithmetic', 'Pair of Linear Equations in Two Variables', 'Quadratic Formula & Nature of Roots', 'Arithmetic Progressions (AP)'] },
      { id: 'MOD-2', moduleNumber: 2, title: 'Triangles, Trigonometry & Coordinate Geometry', hours: 20, topics: ['Basic Proportionality Theorem (Thales)', 'Trigonometric Identities & Heights and Distances', 'Circles & Tangents', 'Surface Areas, Statistics & Probability'] },
    ],
  },
  {
    course: 'CBSE',
    branch: 'CBSE Standard',
    semester: 'Class 11',
    classLevel: 'Class 11',
    subjectCode: 'CBSE-MATH-XI',
    subjectName: 'CBSE Class 11 Core Mathematics',
    credits: 4,
    totalHours: 44,
    modules: [
      { id: 'MOD-1', moduleNumber: 1, title: 'Sets, Relations, Functions & Trigonometry', hours: 22, topics: ['Set Operations & Cartesian Products', 'Domain, Range & Special Functions', 'Trigonometric Functions & Transformation Formulas', 'Complex Numbers & Quadratic Equations'] },
      { id: 'MOD-2', moduleNumber: 2, title: 'Linear Inequalities, Conics & Calculus Foundations', hours: 22, topics: ['Permutations & Combinations, Binomial Theorem', 'Straight Lines, Circles, Parabola, Ellipse, Hyperbola', 'Limits and Derivatives', 'Probability & Statistics'] },
    ],
  },
  {
    course: 'CBSE',
    branch: 'CBSE Standard',
    semester: 'Class 12',
    classLevel: 'Class 12',
    subjectCode: 'CBSE-MATH-XII',
    subjectName: 'CBSE Class 12 Board Mathematics',
    credits: 4,
    totalHours: 48,
    modules: [
      { id: 'MOD-1', moduleNumber: 1, title: 'Relations, Functions, Matrices & Determinants', hours: 24, topics: ['Equivalence Relations & Bijective Functions', 'Inverse Trigonometric Functions', 'Matrix Operations & Inverses', 'Determinants, Minors, Cofactors & Adjoints'] },
      { id: 'MOD-2', moduleNumber: 2, title: 'Calculus, Vectors, 3D Geometry & LPP', hours: 24, topics: ['Continuity, Differentiability & Applications of Derivatives', 'Indefinite & Definite Integrals & Areas under Curves', 'Differential Equations', 'Vectors, 3D Geometry (Lines & Planes)', 'Bayes Theorem & Linear Programming'] },
    ],
  },

  // ── ICSE / ISC (CLASSES 9 TO 12) ──
  {
    course: 'ICSE',
    branch: 'ICSE / ISC',
    semester: 'Class 9',
    classLevel: 'Class 9',
    subjectCode: 'ICSE-IX',
    subjectName: 'ICSE Class 9 Mathematics',
    credits: 4,
    totalHours: 40,
    modules: [
      { id: 'MOD-1', moduleNumber: 1, title: 'Commercial Mathematics & Algebra', hours: 20, topics: ['Compound Interest', 'Expansions & Factorisation', 'Simultaneous Linear Equations & Indices/Logarithms'] },
      { id: 'MOD-2', moduleNumber: 2, title: 'Geometry, Trigonometry & Coordinate Geometry', hours: 20, topics: ['Pythagoras Theorem & Rectilinear Figures', 'Mid-Point & Intercept Theorems', 'Trigonometric Ratios of Standard Angles'] },
    ],
  },
  {
    course: 'ICSE',
    branch: 'ICSE / ISC',
    semester: 'Class 10',
    classLevel: 'Class 10',
    subjectCode: 'ICSE-X',
    subjectName: 'ICSE Class 10 Board Mathematics',
    credits: 4,
    totalHours: 42,
    modules: [
      { id: 'MOD-1', moduleNumber: 1, title: 'GST, Banking, Shares & Quadratic Algebra', hours: 22, topics: ['Recurring Deposit Accounts', 'Shares & Dividends', 'Ratio & Proportion, Matrices (2x2), AP & GP'] },
      { id: 'MOD-2', moduleNumber: 2, title: 'Similarity, Loci, Circles & Mensuration', hours: 20, topics: ['Angle & Cyclic Properties of Circles', 'Tangent & Intersecting Chords', 'Cones, Spheres & Ogive Curves'] },
    ],
  },
  {
    course: 'ICSE',
    branch: 'ICSE / ISC',
    semester: 'Class 11',
    classLevel: 'Class 11',
    subjectCode: 'ISC-XI',
    subjectName: 'ISC Class 11 Mathematics',
    credits: 4,
    totalHours: 44,
    modules: [
      { id: 'MOD-1', moduleNumber: 1, title: 'Trigonometry, Algebra & Quadratic Theory', hours: 22, topics: ['Properties of Triangles', 'Mathematical Induction', 'Permutations, Combinations & Binomial Theorem'] },
      { id: 'MOD-2', moduleNumber: 2, title: 'Coordinate Geometry & Calculus Foundations', hours: 22, topics: ['Circles & Conic Sections', 'Limits & Differentiation', 'Measures of Dispersion & Correlation'] },
    ],
  },
  {
    course: 'ICSE',
    branch: 'ICSE / ISC',
    semester: 'Class 12',
    classLevel: 'Class 12',
    subjectCode: 'ISC-XII',
    subjectName: 'ISC Class 12 Mathematics',
    credits: 4,
    totalHours: 48,
    modules: [
      { id: 'MOD-1', moduleNumber: 1, title: 'Determinants, Matrices & Inverse Trigonometry', hours: 24, topics: ["Martin's Rule (Matrix Method)", 'Properties of Determinants', 'Inverse Circular Functions'] },
      { id: 'MOD-2', moduleNumber: 2, title: 'Calculus, Vectors & 3D Planes', hours: 24, topics: ["L'Hospital's Rule & Maxima/Minima", 'Definite Integrals & Differential Equations', 'Scalar Triple Product & Planes in 3D'] },
    ],
  },

  // ── WBJEE (3 TRACKS) ──
  {
    course: 'WBJEE',
    branch: 'WBJEE Track',
    semester: 'Class 11',
    classLevel: 'Class 11',
    subjectCode: 'WBJEE-XI',
    subjectName: 'WBJEE Class 11 Foundation Mathematics',
    credits: 4,
    totalHours: 44,
    modules: [
      { id: 'MOD-1', moduleNumber: 1, title: 'Algebra & Complex Numbers for WBJEE', hours: 22, topics: ['Cube & n-th Roots of Unity', 'Theory of Equations & Location of Roots', 'Logarithmic & Exponential Series'] },
      { id: 'MOD-2', moduleNumber: 2, title: '2D Coordinate Geometry & Conics', hours: 22, topics: ['Pair of Straight Lines', 'Coaxial System of Circles', 'Focal Chords & Normals to Conics'] },
    ],
  },
  {
    course: 'WBJEE',
    branch: 'WBJEE Track',
    semester: 'Class 12',
    classLevel: 'Class 12',
    subjectCode: 'WBJEE-XII',
    subjectName: 'WBJEE Class 12 Rank Booster Mathematics',
    credits: 4,
    totalHours: 46,
    modules: [
      { id: 'MOD-1', moduleNumber: 1, title: 'Advanced Calculus (Cat 1, 2 & 3)', hours: 24, topics: ['Functional Equations & Differentiability', 'Leibnitz Rule for Definite Integrals', 'Differential Equations & Area Enclosed'] },
      { id: 'MOD-2', moduleNumber: 2, title: 'Matrices, Vectors & Probability', hours: 22, topics: ['Rank & Consistency of Systems', 'Vector Equations of Lines & Planes', 'Conditional Probability & Binomial Distribution'] },
    ],
  },
  {
    course: 'WBJEE',
    branch: 'WBJEE Track',
    semester: 'Target / Repeater',
    classLevel: 'Target / Repeater',
    subjectCode: 'WBJEE-TGT',
    subjectName: 'WBJEE Complete 100-Marks Intensive Track',
    credits: 4,
    totalHours: 50,
    modules: [
      { id: 'MOD-1', moduleNumber: 1, title: 'High-Weightage Calculus & Coordinate Geometry', hours: 26, topics: ['Definite Integration Reduction Formulas', 'Application of Derivatives & Monotonicity', 'Tangents & Chords of Contact in Conics'] },
      { id: 'MOD-2', moduleNumber: 2, title: 'Category-3 Multi-Correct Strategy & PYQ Drills', hours: 24, topics: ['Complex Locus Problems', 'Permutations & Derangements', 'WBJEE 2015–2025 Past Paper Synthesis'] },
    ],
  },

  // ── JEE ADVANCED (3 TRACKS) ──
  {
    course: 'JEE Advanced',
    branch: 'JEE Advanced Track',
    semester: 'Class 11',
    classLevel: 'Class 11',
    subjectCode: 'JEE-ADV-XI',
    subjectName: 'JEE Main & Advanced Class 11 Mathematics',
    credits: 4,
    totalHours: 48,
    modules: [
      { id: 'MOD-1', moduleNumber: 1, title: 'Algebra: Complex Numbers, Quadratics & Combinatorics', hours: 24, topics: ['Rotation Theorem in Complex Plane', 'Multinomial Theorem & Principle of Inclusion-Exclusion', 'Inequalities (AM-GM-HM, Cauchy-Schwarz)'] },
      { id: 'MOD-2', moduleNumber: 2, title: 'Coordinate Geometry: Straight Lines, Circles & Conics', hours: 24, topics: ['Family of Lines & Circles', 'Parametric Coordinates & Director Circles', 'Reflective Properties of Conics'] },
    ],
  },
  {
    course: 'JEE Advanced',
    branch: 'JEE Advanced Track',
    semester: 'Class 12',
    classLevel: 'Class 12',
    subjectCode: 'JEE-ADV-XII',
    subjectName: 'JEE Main & Advanced Class 12 Mathematics',
    credits: 4,
    totalHours: 50,
    modules: [
      { id: 'MOD-1', moduleNumber: 1, title: 'Differential & Integral Calculus Mastery', hours: 26, topics: ['Graphical Transformations & Functional Equations', 'Definite Integration as Limit of a Sum & Inequalities', 'Exact Differential Equations & Geometrical Applications'] },
      { id: 'MOD-2', moduleNumber: 2, title: '3D Vector Algebra, Matrices & Probability', hours: 24, topics: ['Vector Triple Product & Tetrahedron Geometry', 'Cayley-Hamilton & Orthogonal Matrices', 'Total Probability & Bayes Theorem'] },
    ],
  },
  {
    course: 'JEE Advanced',
    branch: 'JEE Advanced Track',
    semester: 'Target / Repeater',
    classLevel: 'Target / Repeater',
    subjectCode: 'JEE-ADV-TGT',
    subjectName: 'JEE Advanced Rankers Intensive Program',
    credits: 4,
    totalHours: 52,
    modules: [
      { id: 'MOD-1', moduleNumber: 1, title: 'Olympiad & Advanced Calculus Problems', hours: 28, topics: ['Estimation of Integrals', "Rolle's Theorem with Polynomial Roots", 'Differential Equations with Substitution'] },
      { id: 'MOD-2', moduleNumber: 2, title: 'Matrix Match, Paragraph & Integer-Type Drills', hours: 24, topics: ['Complex Geometry & Roots of Unity', 'Advanced Combinatorial Identities', '3D Geometry & Planes'] },
    ],
  },
];

/**
 * Seed Initial Syllabi (Amendment 2)
 * Safely seeds the exact 28 canonical subjects from academicStructure.js
 * Checks existence by (course + branch + semester + subjectCode) before inserting
 */
async function seedInitialSyllabi() {
  try {
    dbGuard('seedInitialSyllabi');

    let inserted = 0;
    let skipped = 0;

    for (const item of CANONICAL_CURRICULUM_DATA) {
      const normalized = normalizeCohortItem(item);
      const exists = await Syllabus.findOne({
        course: normalized.course,
        semester: normalized.semester,
        subjectCode: item.subjectCode,
        isDeleted: { $ne: true },
      });

      if (!exists) {
        await Syllabus.create({
          subjectName: item.subjectName,
          subjectCode: item.subjectCode,
          credits: item.credits || 4,
          totalMarks: item.totalMarks || 100,
          totalHours: item.totalHours || 40,
          academicYear: '2026-2027',
          description: item.description || `Official curriculum syllabus for ${item.subjectName}.`,
          course: normalized.course,
          branch: normalized.branch || '',
          semester: normalized.semester,
          classLevel: normalized.classLevel || null,
          isCommon: Boolean(normalized.isCommon),
          modules: (item.modules || []).map((m) => ({
            id: m.id || `MOD-${m.moduleNumber}`,
            moduleNumber: m.moduleNumber,
            title: m.title,
            hours: m.hours || 8,
            topics: m.topics || [],
            learningOutcomes: m.learningOutcomes || [],
            completedTopics: [], // Empty initially (Amendment 1 & 2)
          })),
          textbooks: item.textbooks || [
            { title: `${item.subjectName} Standard Textbook`, author: 'Academic Curriculum Committee', edition: 'Latest', type: 'prescribed' },
          ],
          examPattern: item.examPattern || { internalAssessment: 30, midSemester: 20, endSemester: 50 },
          visibility: 'published',
        });
        inserted++;
      } else {
        skipped++;
      }
    }

    console.log(`[SEED_SYLLABI] Migration complete: ${inserted} seeded, ${skipped} skipped.`);
  } catch (err) {
    console.warn(`[SEED_SYLLABI] Warning during initial syllabus seed: ${err.message}`);
  }
}

/**
 * 1. GET /api/syllabus — Query syllabi by cohort (with topic completion stats)
 */
exports.getSyllabi = async (req, res) => {
  try {
    const user = req.user || {};
    const isStudent = user.role === 'student';

    const {
      course,
      branch,
      semester,
      classLevel,
      search,
      visibility,
    } = req.query;

    const query = {
      isDeleted: { $ne: true },
    };

    if (isStudent) {
      query.visibility = 'published';
    } else if (visibility && visibility !== 'all') {
      query.visibility = visibility;
    }

    if (course && course !== 'ALL') {
      query.course = new RegExp(`^${course}$`, 'i');
    }

    if (branch && branch !== 'ALL') {
      query.$or = [
        { branch: new RegExp(`^${branch}$`, 'i') },
        { branch: /all/i },
        { isCommon: true },
        { branch: '' },
      ];
    }

    if (semester && semester !== 'ALL') {
      const cleanSem = String(semester).replace(/[^0-9]/g, '');
      const semConds = [
        { semester: semester },
        { semester: `Semester ${cleanSem}` },
        { semester: cleanSem },
        { semester: Number(cleanSem) },
        { semester: new RegExp(`semester\\s*0*${cleanSem}(\\b|$)`, 'i') },
      ];
      if (query.$or) {
        query.$and = [{ $or: query.$or }, { $or: semConds }];
        delete query.$or;
      } else {
        query.$or = semConds;
      }
    }

    if (classLevel && classLevel !== 'ALL') {
      const classConds = [{ classLevel }, { semester: classLevel }];
      if (query.$or) {
        query.$and = [{ $or: query.$or }, { $or: classConds }];
        delete query.$or;
      } else {
        query.$or = classConds;
      }
    }

    if (search && String(search).trim()) {
      const sRegex = new RegExp(String(search).trim(), 'i');
      const searchCond = [
        { subjectName: sRegex },
        { subjectCode: sRegex },
        { description: sRegex },
      ];
      if (query.$and) {
        query.$and.push({ $or: searchCond });
      } else if (query.$or) {
        query.$and = [{ $or: query.$or }, { $or: searchCond }];
        delete query.$or;
      } else {
        query.$or = searchCond;
      }
    }

    const syllabi = await Syllabus.find(query).sort({ subjectCode: 1 }).lean();

    // Compute completion stats for each document
    const formatted = syllabi.map((s) => {
      let totalTopics = 0;
      let completedTopicsCount = 0;
      (s.modules || []).forEach((m) => {
        totalTopics += (m.topics || []).length;
        completedTopicsCount += (m.completedTopics || []).length;
      });
      const percentage = totalTopics > 0 ? Math.round((completedTopicsCount / totalTopics) * 100) : 0;

      return {
        ...s,
        id: s._id.toString(),
        completionStats: {
          totalTopics,
          completedTopics: completedTopicsCount,
          percentage,
        },
      };
    });

    return res.status(200).json({
      success: true,
      data: formatted,
      total: formatted.length,
    });
  } catch (error) {
    console.error('getSyllabi error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * 2. GET /api/syllabus/:id — Single syllabus detail
 */
exports.getSyllabusById = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: 'Invalid syllabus ID' });
    }

    const syllabus = await Syllabus.findById(id).lean();
    if (!syllabus || syllabus.isDeleted) {
      return res.status(404).json({ success: false, message: 'Syllabus not found' });
    }

    let totalTopics = 0;
    let completedTopicsCount = 0;
    (syllabus.modules || []).forEach((m) => {
      totalTopics += (m.topics || []).length;
      completedTopicsCount += (m.completedTopics || []).length;
    });
    const percentage = totalTopics > 0 ? Math.round((completedTopicsCount / totalTopics) * 100) : 0;

    return res.status(200).json({
      success: true,
      data: {
        ...syllabus,
        id: syllabus._id.toString(),
        completionStats: { totalTopics, completedTopics: completedTopicsCount, percentage },
      },
    });
  } catch (error) {
    console.error('getSyllabusById error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * 3. POST /api/syllabus — Create subject syllabus (Teacher/Admin only)
 */
exports.createSyllabus = async (req, res) => {
  try {
    dbGuard('POST /api/syllabus');

    const user = req.user || {};
    let {
      subjectName,
      subjectCode,
      credits = 4,
      totalMarks = 100,
      totalHours = 40,
      academicYear = '2026-2027',
      description = '',
      course = 'Engineering',
      branch = 'CSE',
      semester = 'Semester 1',
      classLevel,
      modules = [],
      textbooks = [],
      examPattern = {},
      visibility = 'published',
    } = req.body || {};

    if (!subjectName || !String(subjectName).trim()) {
      return res.status(400).json({ success: false, message: 'Subject name is required.' });
    }
    if (!subjectCode || !String(subjectCode).trim()) {
      return res.status(400).json({ success: false, message: 'Subject code is required.' });
    }

    // Role scoping check
    if (user.role === 'teacher') {
      const tCourse = user.targetCourse || user.course;
      const tBranch = user.branch || user.stream;
      if (tCourse && course.toLowerCase() !== tCourse.toLowerCase()) {
        return res.status(403).json({
          success: false,
          message: `Teachers are restricted to managing syllabi within their assigned course (${tCourse}).`,
        });
      }
      if (tBranch && !tBranch.toLowerCase().includes('all') && branch && branch.toLowerCase() !== tBranch.toLowerCase()) {
        return res.status(403).json({
          success: false,
          message: `Teachers are restricted to managing syllabi within their assigned branch (${tBranch}).`,
        });
      }
    }

    // Parse JSON fields if coming from multipart
    if (typeof modules === 'string') {
      try { modules = JSON.parse(modules); } catch { modules = []; }
    }
    if (typeof textbooks === 'string') {
      try { textbooks = JSON.parse(textbooks); } catch { textbooks = []; }
    }
    if (typeof examPattern === 'string') {
      try { examPattern = JSON.parse(examPattern); } catch { examPattern = {}; }
    }

    // Exam Pattern Validation (Amendment 6: must sum to 100)
    const internal = Number(examPattern.internalAssessment) || 30;
    const midSem = Number(examPattern.midSemester) || 20;
    const endSem = Number(examPattern.endSemester) || 50;
    if (internal + midSem + endSem !== 100) {
      return res.status(400).json({
        success: false,
        message: `Assessment weightage must total exactly 100%. Current sum: ${internal + midSem + endSem}%.`,
      });
    }

    // File Upload handling for Official PDF (Amendment 5)
    let attachmentUrl = '';
    let attachmentName = '';
    let attachmentSize = 0;

    if (req.file && req.file.buffer) {
      const safeName = `syl_${Date.now()}_${Math.random().toString(36).substring(2, 7)}.pdf`;
      const diskPath = path.join(syllabusDir, safeName);
      fs.writeFileSync(diskPath, req.file.buffer);
      attachmentUrl = `/uploads/syllabus/${safeName}`;
      attachmentName = req.file.originalname;
      attachmentSize = req.file.size;
    }

    const normalizedCohort = normalizeCohortItem({
      course,
      branch,
      semester,
      classLevel,
    });

    const syllabus = await Syllabus.create({
      subjectName: String(subjectName).trim(),
      subjectCode: String(subjectCode).toUpperCase().trim(),
      credits: Number(credits) || 4,
      totalMarks: Number(totalMarks) || 100,
      totalHours: Number(totalHours) || 40,
      academicYear: String(academicYear).trim(),
      description: String(description || ''),
      course: normalizedCohort.course,
      branch: normalizedCohort.branch || '',
      semester: normalizedCohort.semester,
      classLevel: normalizedCohort.classLevel || null,
      isCommon: Boolean(normalizedCohort.isCommon),
      modules: Array.isArray(modules)
        ? modules.map((m, idx) => ({
            id: m.id || `MOD-${idx + 1}`,
            moduleNumber: m.moduleNumber || idx + 1,
            title: m.title || `Module ${idx + 1}`,
            hours: Number(m.hours) || 8,
            topics: Array.isArray(m.topics) ? m.topics : [],
            learningOutcomes: Array.isArray(m.learningOutcomes) ? m.learningOutcomes : [],
            completedTopics: [],
          }))
        : [],
      textbooks: Array.isArray(textbooks) ? textbooks : [],
      examPattern: { internalAssessment: internal, midSemester: midSem, endSemester: endSem },
      attachmentUrl,
      attachmentName,
      attachmentSize,
      visibility: visibility || 'published',
      createdBy: user._id || null,
    });

    const docObj = syllabus.toObject();
    docObj.id = syllabus._id.toString();

    return res.status(201).json({
      success: true,
      message: 'Syllabus created successfully.',
      data: docObj,
    });
  } catch (error) {
    console.error('createSyllabus error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * 4. PATCH /api/syllabus/:id — Update syllabus details
 */
exports.updateSyllabus = async (req, res) => {
  try {
    dbGuard('PATCH /api/syllabus/:id');

    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: 'Invalid syllabus ID' });
    }

    const syllabus = await Syllabus.findById(id);
    if (!syllabus || syllabus.isDeleted) {
      return res.status(404).json({ success: false, message: 'Syllabus not found' });
    }

    const updates = req.body || {};
    if (updates.subjectName !== undefined) syllabus.subjectName = String(updates.subjectName).trim();
    if (updates.subjectCode !== undefined) syllabus.subjectCode = String(updates.subjectCode).toUpperCase().trim();
    if (updates.credits !== undefined) syllabus.credits = Number(updates.credits);
    if (updates.totalMarks !== undefined) syllabus.totalMarks = Number(updates.totalMarks);
    if (updates.totalHours !== undefined) syllabus.totalHours = Number(updates.totalHours);
    if (updates.academicYear !== undefined) syllabus.academicYear = updates.academicYear;
    if (updates.description !== undefined) syllabus.description = updates.description;
    if (updates.visibility !== undefined) syllabus.visibility = updates.visibility;

    if (updates.examPattern) {
      let ep = updates.examPattern;
      if (typeof ep === 'string') {
        try { ep = JSON.parse(ep); } catch {}
      }
      const internal = Number(ep.internalAssessment) || 30;
      const midSem = Number(ep.midSemester) || 20;
      const endSem = Number(ep.endSemester) || 50;
      if (internal + midSem + endSem !== 100) {
        return res.status(400).json({
          success: false,
          message: `Assessment weightage must total 100%. Current sum: ${internal + midSem + endSem}%.`,
        });
      }
      syllabus.examPattern = { internalAssessment: internal, midSemester: midSem, endSemester: endSem };
    }

    if (updates.modules) {
      let mods = updates.modules;
      if (typeof mods === 'string') {
        try { mods = JSON.parse(mods); } catch {}
      }
      if (Array.isArray(mods)) {
        syllabus.modules = mods.map((m, idx) => ({
          id: m.id || `MOD-${idx + 1}`,
          moduleNumber: m.moduleNumber || idx + 1,
          title: m.title || `Module ${idx + 1}`,
          hours: Number(m.hours) || 8,
          topics: Array.isArray(m.topics) ? m.topics : [],
          learningOutcomes: Array.isArray(m.learningOutcomes) ? m.learningOutcomes : [],
          completedTopics: Array.isArray(m.completedTopics) ? m.completedTopics : [],
        }));
      }
    }

    if (updates.textbooks) {
      let tbs = updates.textbooks;
      if (typeof tbs === 'string') {
        try { tbs = JSON.parse(tbs); } catch {}
      }
      if (Array.isArray(tbs)) syllabus.textbooks = tbs;
    }

    // Handle new PDF attachment
    if (req.file && req.file.buffer) {
      const safeName = `syl_${Date.now()}_${Math.random().toString(36).substring(2, 7)}.pdf`;
      const diskPath = path.join(syllabusDir, safeName);
      fs.writeFileSync(diskPath, req.file.buffer);
      syllabus.attachmentUrl = `/uploads/syllabus/${safeName}`;
      syllabus.attachmentName = req.file.originalname;
      syllabus.attachmentSize = req.file.size;
    }

    await syllabus.save();

    const docObj = syllabus.toObject();
    docObj.id = syllabus._id.toString();

    return res.status(200).json({
      success: true,
      message: 'Syllabus updated successfully.',
      data: docObj,
    });
  } catch (error) {
    console.error('updateSyllabus error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * 5. PATCH /api/syllabus/:id/topics — Toggle topic completion or add micro-topic (Amendment 1)
 */
exports.toggleTopicCompletion = async (req, res) => {
  try {
    dbGuard('PATCH /api/syllabus/:id/topics');

    const { id } = req.params;
    const { moduleId, topic, completed, action = 'toggle_completion' } = req.body;

    if (!moduleId || !topic) {
      return res.status(400).json({ success: false, message: 'Module ID and Topic are required.' });
    }

    const syllabus = await Syllabus.findById(id);
    if (!syllabus || syllabus.isDeleted) {
      return res.status(404).json({ success: false, message: 'Syllabus not found.' });
    }

    const mod = syllabus.modules.find((m) => m.id === moduleId || String(m.moduleNumber) === String(moduleId));
    if (!mod) {
      return res.status(404).json({ success: false, message: 'Module not found in syllabus.' });
    }

    if (action === 'add_topic') {
      if (!mod.topics.includes(topic.trim())) {
        mod.topics.push(topic.trim());
      }
    } else {
      // Toggle completion (Amendment 1)
      const cleanTopic = topic.trim();
      const isAlreadyCompleted = mod.completedTopics.includes(cleanTopic);

      if (completed && !isAlreadyCompleted) {
        mod.completedTopics.push(cleanTopic);
      } else if (!completed && isAlreadyCompleted) {
        mod.completedTopics = mod.completedTopics.filter((t) => t !== cleanTopic);
      }
    }

    await syllabus.save();

    let totalTopics = 0;
    let completedTopicsCount = 0;
    syllabus.modules.forEach((m) => {
      totalTopics += (m.topics || []).length;
      completedTopicsCount += (m.completedTopics || []).length;
    });
    const percentage = totalTopics > 0 ? Math.round((completedTopicsCount / totalTopics) * 100) : 0;

    return res.status(200).json({
      success: true,
      message: 'Topic status updated successfully.',
      data: {
        moduleId: mod.id,
        completedTopics: mod.completedTopics,
        completionStats: {
          totalTopics,
          completedTopics: completedTopicsCount,
          percentage,
        },
      },
    });
  } catch (error) {
    console.error('toggleTopicCompletion error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * 6. DELETE /api/syllabus/:id — Soft-delete
 */
exports.deleteSyllabus = async (req, res) => {
  try {
    dbGuard('DELETE /api/syllabus/:id');

    const { id } = req.params;
    const syllabus = await Syllabus.findById(id);
    if (!syllabus || syllabus.isDeleted) {
      return res.status(404).json({ success: false, message: 'Syllabus not found' });
    }

    syllabus.isDeleted = true;
    await syllabus.save();

    return res.status(200).json({
      success: true,
      message: 'Syllabus moved to trash.',
      data: { id: syllabus._id, isDeleted: true },
    });
  } catch (error) {
    console.error('deleteSyllabus error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * 7. POST /api/syllabus/:id/restore — Restore soft-deleted syllabus
 */
exports.restoreSyllabus = async (req, res) => {
  try {
    dbGuard('POST /api/syllabus/:id/restore');

    const { id } = req.params;
    const syllabus = await Syllabus.findById(id);
    if (!syllabus) {
      return res.status(404).json({ success: false, message: 'Syllabus not found' });
    }

    syllabus.isDeleted = false;
    await syllabus.save();

    return res.status(200).json({
      success: true,
      message: 'Syllabus restored successfully.',
      data: { id: syllabus._id, isDeleted: false },
    });
  } catch (error) {
    console.error('restoreSyllabus error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * 8. POST /api/syllabus/extract-pdf — Lightweight PDF text extraction (Amendment 3)
 */
exports.extractPdfText = async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ success: false, message: 'PDF file is required.' });
    }

    const parser = new PDFParse({ data: req.file.buffer });
    const result = await parser.getText();
    await parser.destroy();

    const rawText = (result && result.text) || '';
    const cleanText = rawText.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

    return res.status(200).json({
      success: true,
      message: 'PDF text extracted successfully.',
      text: cleanText.slice(0, 3000), // Pre-fill description up to 3000 chars
    });
  } catch (error) {
    console.error('extractPdfText error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to extract text from PDF: ' + error.message,
    });
  }
};

module.exports.seedInitialSyllabi = seedInitialSyllabi;
