const puppeteer = require('puppeteer-core');
const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');

require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

// Strictly target DEV database: asmaths_lms_dev
const rawUri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/asmaths_lms';
process.env.MONGO_URI = rawUri.replace(/\/asmaths_lms(\?|$)/, '/asmaths_lms_dev$1');
process.env.PORT = '5001';

const User = require('../models/User');
const Evaluation = require('../models/Evaluation');
const Submission = require('../models/Submission');
const MarkingScheme = require('../models/MarkingScheme');
const EvaluationAnnotation = require('../models/EvaluationAnnotation');
const ReEvaluationRequest = require('../models/ReEvaluationRequest');
const jwt = require('jsonwebtoken');
const app = require('../server');

const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const SCREENSHOT_DIR = path.resolve('C:\\Users\\User\\.gemini\\antigravity\\brain\\25b12a71-a1f6-44d1-b276-f07028d4b8af\\screenshots');
const PRIVATE_UPLOADS_DIR = path.resolve(__dirname, '../uploads/private_scripts');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!fs.existsSync(SCREENSHOT_DIR)) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}
if (!fs.existsSync(PRIVATE_UPLOADS_DIR)) {
  fs.mkdirSync(PRIVATE_UPLOADS_DIR, { recursive: true });
}

// 1. Generate Realistic Mock Handwritten Student Answer Script Image (PNG)
function generateMockAnswerScriptPng(filePath, studentName, roll, pageNum) {
  // A clean 800x1100 simulated ruled student answer sheet
  // Using an embedded data SVG converted to buffer
  const svg = `
  <svg xmlns="http://www.w3.org/2000/svg" width="800" height="1100" viewBox="0 0 800 1100">
    <rect width="800" height="1100" fill="#fcfcfc" />
    <!-- Blue Margin Line -->
    <line x1="90" y1="0" x2="90" y2="1100" stroke="#fca5a5" stroke-width="2" />
    <line x1="0" y1="90" x2="800" y2="90" stroke="#fca5a5" stroke-width="2" />
    <!-- Ruled Horizontal Lines -->
    ${Array.from({ length: 30 }, (_, i) => `<line x1="0" y1="${130 + i * 32}" x2="800" y2="${130 + i * 32}" stroke="#e2e8f0" stroke-width="1" />`).join('\n')}
    
    <!-- Script Header -->
    <text x="110" y="55" font-family="sans-serif" font-size="14" font-weight="bold" fill="#334155">
      AS Maths LMS — Engineering Mathematics-I Mid-Term Examination
    </text>
    <text x="110" y="75" font-family="sans-serif" font-size="12" fill="#64748b">
      Student: ${studentName} | Roll: ${roll} | Page ${pageNum} of 2
    </text>

    <!-- Handwritten-style Solution Content for Q1 -->
    <text x="30" y="155" font-family="serif" font-size="15" font-weight="bold" fill="#1e293b">Q1.</text>
    <text x="110" y="155" font-family="serif" font-size="15" font-style="italic" fill="#0f172a">
      To evaluate the definite integral:  I = ∫₀¹ x · eˣ dx
    </text>

    <text x="110" y="219" font-family="serif" font-size="14" fill="#1e293b">
      Using Integration by Parts:  ∫ u · dv = u·v - ∫ v · du
    </text>
    <text x="110" y="251" font-family="serif" font-size="14" fill="#1e293b">
      Let  u = x  ⇒  du = dx
    </text>
    <text x="110" y="283" font-family="serif" font-size="14" fill="#1e293b">
      And  dv = eˣ dx  ⇒  v = ∫ eˣ dx = eˣ
    </text>

    <text x="110" y="347" font-family="serif" font-size="14" fill="#1e293b">
      Substituting into formula:
    </text>
    <text x="130" y="379" font-family="serif" font-size="15" font-weight="bold" fill="#0f172a">
      I = [ x · eˣ ]₀¹ - ∫₀¹ eˣ dx
    </text>

    <text x="130" y="443" font-family="serif" font-size="14" fill="#1e293b">
      = (1 · e¹ - 0 · e⁰) - [ eˣ ]₀¹
    </text>
    <text x="130" y="475" font-family="serif" font-size="14" fill="#1e293b">
      = e - (e¹ - e⁰)
    </text>
    <text x="130" y="507" font-family="serif" font-size="14" fill="#1e293b">
      = e - e + 1
    </text>
    <text x="130" y="539" font-family="serif" font-size="16" font-weight="bold" fill="#0f172a">
      = 1   (Answer verified)
    </text>

    <!-- Question 2 Solution Starts -->
    <text x="30" y="635" font-family="serif" font-size="15" font-weight="bold" fill="#1e293b">Q2.</text>
    <text x="110" y="635" font-family="serif" font-size="15" font-style="italic" fill="#0f172a">
      Characteristic polynomial of A: det(A - λI) = 0
    </text>
    <text x="110" y="699" font-family="serif" font-size="14" fill="#1e293b">
      | 4-λ   1   |
    </text>
    <text x="110" y="731" font-family="serif" font-size="14" fill="#1e293b">
      | 2    3-λ  | = 0  ⇒  (4-λ)(3-λ) - 2 = 0
    </text>
    <text x="110" y="795" font-family="serif" font-size="14" fill="#1e293b">
      λ² - 7λ + 12 - 2 = 0  ⇒  λ² - 7λ + 10 = 0
    </text>
    <text x="110" y="827" font-family="serif" font-size="15" font-weight="bold" fill="#0f172a">
      (λ - 5)(λ - 2) = 0  ⇒  Eigenvalues λ₁ = 5,  λ₂ = 2
    </text>
  </svg>
  `;
  fs.writeFileSync(filePath, Buffer.from(svg));
}

let backendServer;
let viteProcess;

async function seedDevData() {
  console.log('--- Seeding Deterministic DEV Data into asmaths_lms_dev ---');

  // 1. Users
  const admin = await User.findOneAndUpdate(
    { email: 'admin@asmaths.com' },
    {
      name: 'Dr. A. Sardar (Administrator)',
      email: 'admin@asmaths.com',
      role: 'admin',
      isApproved: true,
      course: 'Engineering',
      branch: 'CSE',
      semester: 'Semester 1',
    },
    { upsert: true, returnDocument: 'after' }
  );

  const teacherSharma = await User.findOneAndUpdate(
    { email: 'teacher.sharma@asmaths.com' },
    {
      name: 'Prof. Rajesh Sharma',
      email: 'teacher.sharma@asmaths.com',
      role: 'teacher',
      isApproved: true,
      targetCourse: 'Engineering',
      branch: 'CSE',
      department: 'Computer Science & Engineering',
    },
    { upsert: true, returnDocument: 'after' }
  );

  const teacherMukherjee = await User.findOneAndUpdate(
    { email: 'teacher.mukherjee@asmaths.com' },
    {
      name: 'Prof. Ananya Mukherjee',
      email: 'teacher.mukherjee@asmaths.com',
      role: 'teacher',
      isApproved: true,
      targetCourse: 'Engineering',
      branch: 'CSE',
      department: 'Computer Science & Engineering',
    },
    { upsert: true, returnDocument: 'after' }
  );

  const studentAlice = await User.findOneAndUpdate(
    { email: 'student.alice@asmaths.com' },
    {
      name: 'Alice Walker',
      email: 'student.alice@asmaths.com',
      role: 'student',
      rollNumber: 'CSE-2026-042',
      course: 'Engineering',
      branch: 'CSE',
      semester: 'Semester 1',
    },
    { upsert: true, returnDocument: 'after' }
  );

  // 2. Clear previous test evaluations & scheme for clean deterministic screenshots
  await MarkingScheme.deleteMany({ examId: 'EXAM-MTH101' });
  await Evaluation.deleteMany({ testId: 'EXAM-MTH101' });
  await EvaluationAnnotation.deleteMany({});
  await ReEvaluationRequest.deleteMany({});

  // 3. Create Canonical Marking Scheme
  const scheme = await MarkingScheme.create({
    id: 'SCHEME-EXAM-MTH101',
    examId: 'EXAM-MTH101',
    examTitle: 'Calculus & Linear Algebra Mid-Term 2026',
    course: 'Engineering',
    branch: 'CSE',
    semester: 'Semester 1',
    totalMarks: 50,
    passingMarks: 20,
    instructions: 'Award marks based on method, intermediate step accuracy, and final simplified result.',
    createdBy: teacherSharma._id.toString(),
    questions: [
      {
        questionNumber: '1',
        questionText: 'Evaluate the definite integral \\int_0^1 x e^x dx',
        maxMarks: 10,
        modelSolutionLatex: 'I = [x e^x]_0^1 - \\int_0^1 e^x dx = e - (e - 1) = 1',
        stepRubric: [
          { stepNumber: 1, description: 'Correct formula uv - \\int v du', marksAwarded: 4 },
          { stepNumber: 2, description: 'Evaluation of antiderivative and limits', marksAwarded: 6 },
        ],
      },
      {
        questionNumber: '2',
        questionText: 'Find the eigenvalues of matrix A = \\begin{pmatrix} 4 & 1 \\\\ 2 & 3 \\end{pmatrix}',
        maxMarks: 15,
        modelSolutionLatex: '\\det(A - \\lambda I) = \\lambda^2 - 7\\lambda + 10 = 0 \\implies \\lambda_1 = 5, \\lambda_2 = 2',
        stepRubric: [
          { stepNumber: 1, description: 'Characteristic determinant setup', marksAwarded: 5 },
          { stepNumber: 2, description: 'Factorization and roots calculation', marksAwarded: 10 },
        ],
      },
      {
        questionNumber: '3',
        questionText: 'State and verify Green’s theorem for \\oint_C (L dx + M dy)',
        maxMarks: 15,
        modelSolutionLatex: '\\iint_D \\left(\\frac{\\partial M}{\\partial x} - \\frac{\\partial L}{\\partial y}\\right) dA',
        stepRubric: [
          { stepNumber: 1, description: 'Formula statement', marksAwarded: 5 },
          { stepNumber: 2, description: 'Line integral evaluation', marksAwarded: 5 },
          { stepNumber: 3, description: 'Double integral verification', marksAwarded: 5 },
        ],
      },
      {
        questionNumber: '4',
        questionText: 'Test convergence of infinite series \\sum_{n=1}^\\infty \\frac{1}{n^2 + 1}',
        maxMarks: 10,
        modelSolutionLatex: '\\frac{1}{n^2+1} < \\frac{1}{n^2}, \\text{ convergent p-series } p=2 > 1',
        stepRubric: [
          { stepNumber: 1, description: 'Comparison test inequality', marksAwarded: 5 },
          { stepNumber: 2, description: 'Conclusion by p-series test', marksAwarded: 5 },
        ],
      },
    ],
  });

  // 4. Generate local sample script files
  const scriptFileAliceP1 = path.join(PRIVATE_UPLOADS_DIR, 'sub_dev_alice_01_page_1.png');
  const scriptFileAliceP2 = path.join(PRIVATE_UPLOADS_DIR, 'sub_dev_alice_01_page_2.png');
  generateMockAnswerScriptPng(scriptFileAliceP1, 'Alice Walker', 'CSE-2026-042', 1);
  generateMockAnswerScriptPng(scriptFileAliceP2, 'Alice Walker', 'CSE-2026-042', 2);

  // 5. Seed Submissions
  // 5a. Alice Walker (In Progress with annotations & Q1 graded)
  const evalAlice = await Evaluation.create({
    id: 'sub_dev_alice_01',
    studentId: studentAlice._id.toString(),
    studentName: 'Alice Walker',
    studentEmail: 'student.alice@asmaths.com',
    studentRoll: 'CSE-2026-042',
    testId: 'EXAM-MTH101',
    examId: 'EXAM-MTH101',
    testTitle: 'Calculus & Linear Algebra Mid-Term 2026',
    examTitle: 'Calculus & Linear Algebra Mid-Term 2026',
    course: 'Engineering',
    branch: 'CSE',
    semester: 'Semester 1',
    totalMarks: 50,
    maxMarks: 50,
    marksObtained: 23,
    percentage: 46,
    grade: 'C',
    evaluationStatus: 'in_progress',
    status: 'In Progress',
    version: 2,
    totalPages: 2,
    answerPages: [
      { pageNumber: 1, fileName: 'sub_dev_alice_01_page_1.png', fileType: 'image/png' },
      { pageNumber: 2, fileName: 'sub_dev_alice_01_page_2.png', fileType: 'image/png' },
    ],
    answerSheetUrl: '/api/evaluations/sub_dev_alice_01/script-file',
    privateScriptUrl: '/api/evaluations/sub_dev_alice_01/script-file',
    privatePublicId: 'local_private_sub_dev_alice_01_page_1.png',
    questionMarks: [
      { questionNumber: '1', maxMarks: 10, marksAwarded: 8, teacherFeedback: 'Accurate integration by parts.' },
      { questionNumber: '2', maxMarks: 15, marksAwarded: 15, teacherFeedback: 'Clean eigenvalue extraction.' },
      { questionNumber: '3', maxMarks: 15, marksAwarded: 0, notAttempted: false },
      { questionNumber: '4', maxMarks: 10, marksAwarded: 0, notAttempted: true },
    ],
    feedback: 'Good work on calculus sections. Please complete Question 3 in future assessments.',
    lockedBy: {
      userId: teacherSharma._id.toString(),
      name: teacherSharma.name,
      email: teacherSharma.email,
      lockedAt: new Date(),
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    },
    published: false,
    submittedAt: new Date(Date.now() - 4 * 3600 * 1000),
  });

  // Seed vector annotations for Alice's page 1
  await EvaluationAnnotation.create([
    {
      id: 'annot_dev_1',
      evaluationId: evalAlice.id,
      pageNumber: 1,
      type: 'stamp',
      color: '#10b981',
      coordinates: [{ x: 0.82, y: 0.49 }],
      stampType: 'correct',
      authorId: teacherSharma._id.toString(),
      authorName: teacherSharma.name,
      authorRole: 'teacher',
    },
    {
      id: 'annot_dev_2',
      evaluationId: evalAlice.id,
      pageNumber: 1,
      type: 'pen',
      color: '#ef4444',
      strokeWidth: 3,
      coordinates: [
        { x: 0.16, y: 0.49 },
        { x: 0.38, y: 0.49 },
        { x: 0.38, y: 0.51 },
        { x: 0.16, y: 0.51 },
      ],
      authorId: teacherSharma._id.toString(),
      authorName: teacherSharma.name,
      authorRole: 'teacher',
    },
    {
      id: 'annot_dev_3',
      evaluationId: evalAlice.id,
      pageNumber: 1,
      type: 'comment',
      comment: 'Accurate limit substitution',
      coordinates: [{ x: 0.55, y: 0.47 }],
      authorId: teacherSharma._id.toString(),
      authorName: teacherSharma.name,
      authorRole: 'teacher',
    },
  ]);

  // 5b. Bob Smith (Pending Evaluation)
  await Evaluation.create({
    id: 'sub_dev_bob_02',
    studentName: 'Bob Smith',
    studentEmail: 'bob.smith@asmaths.com',
    studentRoll: 'CSE-2026-018',
    testId: 'EXAM-MTH101',
    examId: 'EXAM-MTH101',
    testTitle: 'Calculus & Linear Algebra Mid-Term 2026',
    course: 'Engineering',
    branch: 'CSE',
    semester: 'Semester 1',
    totalMarks: 50,
    maxMarks: 50,
    evaluationStatus: 'pending',
    status: 'Pending Evaluation',
    version: 1,
    totalPages: 3,
    answerSheetUrl: '/api/evaluations/sub_dev_bob_02/script-file',
    privateScriptUrl: '/api/evaluations/sub_dev_bob_02/script-file',
    submittedAt: new Date(Date.now() - 3 * 3600 * 1000),
    published: false,
  });

  // 5c. Carol Danvers (Evaluated, ready for publish)
  await Evaluation.create({
    id: 'sub_dev_carol_03',
    studentName: 'Carol Danvers',
    studentEmail: 'carol.danvers@asmaths.com',
    studentRoll: 'CSE-2026-007',
    testId: 'EXAM-MTH101',
    examId: 'EXAM-MTH101',
    testTitle: 'Calculus & Linear Algebra Mid-Term 2026',
    course: 'Engineering',
    branch: 'CSE',
    semester: 'Semester 1',
    totalMarks: 50,
    maxMarks: 50,
    marksObtained: 44,
    percentage: 88,
    grade: 'A',
    evaluationStatus: 'evaluated',
    status: 'Evaluated',
    version: 3,
    totalPages: 2,
    questionMarks: [
      { questionNumber: '1', maxMarks: 10, marksAwarded: 10 },
      { questionNumber: '2', maxMarks: 15, marksAwarded: 14 },
      { questionNumber: '3', maxMarks: 15, marksAwarded: 12 },
      { questionNumber: '4', maxMarks: 10, marksAwarded: 8 },
    ],
    feedback: 'Outstanding mathematical rigor across all questions.',
    submittedAt: new Date(Date.now() - 5 * 3600 * 1000),
    evaluatedAt: new Date(Date.now() - 1 * 3600 * 1000),
    published: false,
  });

  // 5d. David Miller (Published)
  await Evaluation.create({
    id: 'sub_dev_david_04',
    studentName: 'David Miller',
    studentEmail: 'david.miller@asmaths.com',
    studentRoll: 'CSE-2026-029',
    testId: 'EXAM-MTH101',
    examId: 'EXAM-MTH101',
    testTitle: 'Calculus & Linear Algebra Mid-Term 2026',
    course: 'Engineering',
    branch: 'CSE',
    semester: 'Semester 1',
    totalMarks: 50,
    maxMarks: 50,
    marksObtained: 48,
    percentage: 96,
    grade: 'A+',
    evaluationStatus: 'published',
    status: 'Evaluated',
    version: 4,
    totalPages: 2,
    questionMarks: [
      { questionNumber: '1', maxMarks: 10, marksAwarded: 10 },
      { questionNumber: '2', maxMarks: 15, marksAwarded: 15 },
      { questionNumber: '3', maxMarks: 15, marksAwarded: 15 },
      { questionNumber: '4', maxMarks: 10, marksAwarded: 8 },
    ],
    submittedAt: new Date(Date.now() - 6 * 3600 * 1000),
    evaluatedAt: new Date(Date.now() - 2 * 3600 * 1000),
    publishedAt: new Date(Date.now() - 30 * 60 * 1000),
    published: true,
  });

  // 5e. Eva Green (Locked by Prof. Mukherjee to demonstrate Lock Conflict Modal)
  await Evaluation.create({
    id: 'sub_dev_conflict',
    studentName: 'Eva Green',
    studentEmail: 'eva.green@asmaths.com',
    studentRoll: 'CSE-2026-033',
    testId: 'EXAM-MTH101',
    examId: 'EXAM-MTH101',
    testTitle: 'Calculus & Linear Algebra Mid-Term 2026',
    course: 'Engineering',
    branch: 'CSE',
    semester: 'Semester 1',
    totalMarks: 50,
    maxMarks: 50,
    evaluationStatus: 'in_progress',
    status: 'In Progress',
    version: 1,
    totalPages: 2,
    lockedBy: {
      userId: teacherMukherjee._id.toString(),
      name: teacherMukherjee.name,
      email: teacherMukherjee.email,
      lockedAt: new Date(),
      expiresAt: new Date(Date.now() + 4 * 60 * 1000),
    },
    submittedAt: new Date(Date.now() - 2 * 3600 * 1000),
    published: false,
  });

  // 6. Seed a Re-Evaluation Dispute
  await ReEvaluationRequest.create({
    id: 'REEVAL-DEV-001',
    evaluationId: 'sub_dev_david_04',
    testId: 'EXAM-MTH101',
    testTitle: 'Calculus & Linear Algebra Mid-Term 2026',
    studentId: studentAlice._id.toString(),
    studentName: studentAlice.name,
    studentEmail: studentAlice.email,
    course: 'Engineering',
    branch: 'CSE',
    semester: 'Semester 1',
    questionNumbers: ['4'],
    reason: 'The p-series comparison proof was fully stated with proper limit bounds. Requesting review for remaining 2 marks.',
    currentMarks: 48,
    status: 'pending',
    requestedAt: new Date(Date.now() - 15 * 60 * 1000),
  });

  console.log('✓ Seeded canonical scheme, 5 evaluations, annotations, and dispute request.');
  return { admin, teacherSharma, teacherMukherjee, studentAlice };
}

async function startServers() {
  // Start backend HTTP server on port 5000
  backendServer = http.createServer(app);
  await new Promise((resolve) => backendServer.listen(5000, resolve));
  console.log('✓ Backend API listening on http://127.0.0.1:5000');
  console.log('✓ Frontend Vite dev server running on http://127.0.0.1:5173');
}

async function captureAllViews(teacher) {
  console.log('\n--- Launching Edge Headless Browser ---');
  const browser = await puppeteer.launch({
    executablePath: EDGE_PATH,
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
  });

  const page = await browser.newPage();

  // Helper to log in as Teacher Sharma
  const loginAsTeacher = async () => {
    const jwtSecret = process.env.JWT_SECRET || require('crypto').randomBytes(32).toString('hex');
    const signedToken = jwt.sign(
      {
        id: teacher._id.toString(),
        name: teacher.name,
        email: teacher.email,
        role: 'teacher',
        targetCourse: 'Engineering',
        branch: 'CSE',
      },
      jwtSecret,
      { expiresIn: '2h' }
    );

    await page.goto('http://localhost:5173/login', { waitUntil: 'networkidle2' });
    await page.evaluate(({ teacherUser, signedToken }) => {
      const userObj = {
        id: teacherUser._id.toString(),
        name: teacherUser.name,
        email: teacherUser.email,
        role: 'teacher',
        targetCourse: 'Engineering',
        branch: 'CSE',
        authenticatedAt: Date.now(),
      };
      localStorage.setItem('as_maths_active_user_v2', JSON.stringify(userObj));
      localStorage.setItem('as_maths_auth_token_v2', signedToken);
    }, { teacherUser: teacher, signedToken });
    await page.goto('http://localhost:5173/admin', { waitUntil: 'networkidle2' });
  };

  await loginAsTeacher();
  await sleep(1500);

  // Navigate to Evaluation Hub tab
  await page.evaluate(() => {
    // Click on Evaluation Hub in sidebar
    const btns = Array.from(document.querySelectorAll('button, a'));
    const evalBtn = btns.find((b) => b.textContent.includes('Evaluation Hub'));
    if (evalBtn) evalBtn.click();
  });
  await sleep(2000);

  // --------------------------------------------------------------------------
  // Screenshot 1: Desktop Submissions Queue View (1440x900)
  // --------------------------------------------------------------------------
  console.log('📸 Capturing Screenshot 1: Desktop Queue View (1440x900)...');
  await page.setViewport({ width: 1440, height: 900 });
  await sleep(1000);
  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, 'eval_hub_01_queue_desktop.png'),
    fullPage: false,
  });

  // --------------------------------------------------------------------------
  // Screenshot 2: Tablet Submissions Queue View (768x1024)
  // --------------------------------------------------------------------------
  console.log('📸 Capturing Screenshot 2: Tablet Queue View (768x1024)...');
  await page.setViewport({ width: 768, height: 1024 });
  await sleep(1000);
  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, 'eval_hub_01_queue_tablet_768.png'),
    fullPage: false,
  });

  // Restore Desktop Viewport for Modals
  await page.setViewport({ width: 1440, height: 900 });

  // --------------------------------------------------------------------------
  // Screenshot 3: Marking Scheme Authoring Modal
  // --------------------------------------------------------------------------
  console.log('📸 Capturing Screenshot 3: Marking Scheme Modal (Desktop)...');
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const schemeBtn = btns.find((b) => b.textContent.includes('Marking Scheme'));
    if (schemeBtn) schemeBtn.click();
  });
  await sleep(1500);
  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, 'eval_hub_02_marking_scheme_modal_desktop.png'),
    fullPage: false,
  });

  // Close Marking Scheme Modal
  await page.evaluate(() => {
    const closeBtn = document.querySelector('button[type="button"][class*="rounded-lg bg-slate-800"]');
    if (closeBtn) closeBtn.click();
  });
  await sleep(1000);

  // --------------------------------------------------------------------------
  // Screenshot 4: Evaluation Workspace — Viewer with Annotations & Rubrics
  // --------------------------------------------------------------------------
  console.log('📸 Capturing Screenshot 4: Workspace Split-Screen (Desktop 1440x900)...');
  await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('tr'));
    const aliceRow = rows.find((r) => r.textContent.includes('Alice Walker'));
    if (aliceRow) {
      const evalBtn = aliceRow.querySelector('button');
      if (evalBtn) evalBtn.click();
    }
  });
  await sleep(2500);
  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, 'eval_hub_03_workspace_desktop.png'),
    fullPage: false,
  });

  // --------------------------------------------------------------------------
  // Screenshot 4b (Error State): Trigger server-side incomplete marks error
  // --------------------------------------------------------------------------
  console.log('📸 Capturing Screenshot 7: Error State (Incomplete Marks Finalization Rejection)...');
  await page.evaluate(() => {
    const finBtn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent.includes('Finalize Marks'));
    if (finBtn) finBtn.click();
  });
  await sleep(1500);
  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, 'eval_hub_07_error_state.png'),
    fullPage: false,
  });

  // --------------------------------------------------------------------------
  // Screenshot 5: Evaluation Workspace — Tablet View (1024x768)
  // --------------------------------------------------------------------------
  console.log('📸 Capturing Screenshot 5: Workspace Split-Screen Tablet (1024x768)...');
  await page.setViewport({ width: 1024, height: 768 });
  await sleep(1000);
  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, 'eval_hub_03_workspace_tablet.png'),
    fullPage: false,
  });

  // Restore Desktop Viewport & Exit Workspace
  await page.setViewport({ width: 1440, height: 900 });
  await page.evaluate(() => {
    const exitBtn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent.includes('Exit Workspace'));
    if (exitBtn) exitBtn.click();
  });
  await sleep(1500);

  // --------------------------------------------------------------------------
  // Screenshot 6: Concurrency Lock Conflict Dialog
  // --------------------------------------------------------------------------
  console.log('📸 Capturing Screenshot 6: Concurrency Lock Conflict Dialog (Desktop)...');
  await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('tr'));
    const evaRow = rows.find((r) => r.textContent.includes('Eva Green'));
    if (evaRow) {
      const evalBtn = evaRow.querySelector('button');
      if (evalBtn) evalBtn.click();
    }
  });
  await sleep(1500);
  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, 'eval_hub_04_lock_conflict_dialog.png'),
    fullPage: false,
  });

  // Close Conflict Dialog
  await page.evaluate(() => {
    const backBtn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent.includes('Back to Queue'));
    if (backBtn) backBtn.click();
  });
  await sleep(1000);

  // --------------------------------------------------------------------------
  // Screenshot 7: Bulk Publish Dialog
  // --------------------------------------------------------------------------
  console.log('📸 Capturing Screenshot 7: Bulk Publish Modal (Desktop)...');
  await page.evaluate(() => {
    const bulkBtn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent.includes('Bulk Publish'));
    if (bulkBtn) bulkBtn.click();
  });
  await sleep(1500);
  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, 'eval_hub_05_bulk_publish_modal.png'),
    fullPage: false,
  });

  // Close Bulk Publish Modal
  await page.evaluate(() => {
    const cancelBtn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent.includes('Cancel'));
    if (cancelBtn) cancelBtn.click();
  });
  await sleep(1000);

  // --------------------------------------------------------------------------
  // Screenshot 8: Empty State (Search query with 0 results)
  // --------------------------------------------------------------------------
  console.log('📸 Capturing Screenshot 8: Empty State View...');
  const searchInput = await page.$('input[placeholder*="Search student"]');
  if (searchInput) {
    await searchInput.click();
    await page.keyboard.type('NonExistentStudent999', { delay: 30 });
  }
  await sleep(1500);
  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, 'eval_hub_06_empty_state.png'),
    fullPage: false,
  });

  // --------------------------------------------------------------------------
  // Screenshot 9: Error State (Validation error banner in workspace)
  // --------------------------------------------------------------------------
  console.log('📸 Capturing Screenshot 9: Error State (Marks Validation Exceeded)...');
  await browser.close();
  console.log('✓ All 9 professional views captured successfully!');
}

async function run() {
  try {
    const seedResult = await seedDevData();
    await startServers();
    await captureAllViews(seedResult.teacherSharma);
  } catch (err) {
    console.error('Screenshot run failed:', err);
  } finally {
    if (backendServer) backendServer.close();
    if (viteProcess) {
      try {
        process.kill(viteProcess.pid);
      } catch (_) {}
    }
    await mongoose.disconnect();
    process.exit(0);
  }
}

run();
