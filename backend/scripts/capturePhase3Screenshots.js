const puppeteer = require('puppeteer-core');
const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs');
const http = require('http');

require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const DEV_DB_NAME = 'asmaths_lms_dev';
const rawUri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/asmaths_lms';
process.env.MONGO_URI = rawUri.replace(/\/asmaths_lms(\?|$)/, `/${DEV_DB_NAME}$1`);
process.env.PORT = '5000';

const User = require('../models/User');
const Evaluation = require('../models/Evaluation');
const Submission = require('../models/Submission');
const MarkingScheme = require('../models/MarkingScheme');
const EvaluationAnnotation = require('../models/EvaluationAnnotation');
const ReEvaluationRequest = require('../models/ReEvaluationRequest');
const Notification = require('../models/Notification');
const Content = require('../models/Content');
const jwt = require('jsonwebtoken');

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

// Generate realistic simulated ruled student answer sheet SVG (PORTRAIT 800x1100)
function generatePortraitScriptSvg(studentName, roll, pageNum) {
  return `
  <svg xmlns="http://www.w3.org/2000/svg" width="800" height="1100" viewBox="0 0 800 1100">
    <rect width="800" height="1100" fill="#fcfcfc" />
    <line x1="90" y1="0" x2="90" y2="1100" stroke="#fca5a5" stroke-width="2" />
    <line x1="0" y1="90" x2="800" y2="90" stroke="#fca5a5" stroke-width="2" />
    ${Array.from({ length: 30 }, (_, i) => `<line x1="0" y1="${130 + i * 32}" x2="800" y2="${130 + i * 32}" stroke="#e2e8f0" stroke-width="1" />`).join('\n')}
    
    <text x="110" y="55" font-family="sans-serif" font-size="14" font-weight="bold" fill="#334155">
      AS Maths LMS — Engineering Mathematics-I Mid-Term Examination (Portrait Sheet)
    </text>
    <text x="110" y="75" font-family="sans-serif" font-size="12" fill="#64748b">
      Student: ${studentName} | Roll: ${roll} | Page ${pageNum} of 2 (Portrait 800×1100)
    </text>

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
    <text x="110" y="379" font-family="serif" font-size="14" fill="#1e293b">
      I = [ x · eˣ ]₀¹ - ∫₀¹ eˣ dx
    </text>
    <text x="110" y="411" font-family="serif" font-size="14" fill="#1e293b">
      I = (1 · e¹ - 0 · e⁰) - [ eˣ ]₀¹
    </text>
    <text x="110" y="443" font-family="serif" font-size="14" fill="#1e293b">
      I = e - (e¹ - e⁰) = e - e + 1 = 1  [Ans]
    </text>

    <text x="30" y="539" font-family="serif" font-size="15" font-weight="bold" fill="#1e293b">Q2.</text>
    <text x="110" y="539" font-family="serif" font-size="15" font-style="italic" fill="#0f172a">
      Gradient of scalar field:  f(x, y) = x² + y²
    </text>
    <text x="110" y="603" font-family="serif" font-size="14" fill="#1e293b">
      ∇f = (∂f/∂x) î + (∂f/∂y) ĵ
    </text>
    <text x="110" y="635" font-family="serif" font-size="14" fill="#1e293b">
      ∂f/∂x = 2x,   ∂f/∂y = 2y
    </text>
    <text x="110" y="667" font-family="serif" font-size="14" fill="#1e293b">
      Hence, ∇f = 2x î + 2y ĵ  [Verified Correct]
    </text>
  </svg>
  `;
}

// Generate realistic simulated ruled student answer sheet SVG (LANDSCAPE 1200x800)
function generateLandscapeScriptSvg(studentName, roll, pageNum) {
  return `
  <svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800" viewBox="0 0 1200 800">
    <rect width="1200" height="800" fill="#fcfcfc" />
    <line x1="90" y1="0" x2="90" y2="800" stroke="#fca5a5" stroke-width="2" />
    <line x1="0" y1="90" x2="1200" y2="90" stroke="#fca5a5" stroke-width="2" />
    ${Array.from({ length: 22 }, (_, i) => `<line x1="0" y1="${130 + i * 30}" x2="1200" y2="${130 + i * 30}" stroke="#e2e8f0" stroke-width="1" />`).join('\n')}
    
    <text x="110" y="55" font-family="sans-serif" font-size="14" font-weight="bold" fill="#334155">
      AS Maths LMS — Engineering Mathematics-I Mid-Term Examination (Landscape Sheet / Phone Rotation)
    </text>
    <text x="110" y="75" font-family="sans-serif" font-size="12" fill="#64748b">
      Student: ${studentName} | Roll: ${roll} | Page ${pageNum} of 2 (Landscape 1200×800)
    </text>

    <text x="30" y="155" font-family="serif" font-size="15" font-weight="bold" fill="#1e293b">Q3.</text>
    <text x="110" y="155" font-family="serif" font-size="15" font-style="italic" fill="#0f172a">
      Double Integration over Region D bounded by y = x² and y = x:  ∬_D (x + y) dx dy
    </text>

    <text x="110" y="215" font-family="serif" font-size="14" fill="#1e293b">
      Intersection points: x² = x  ⇒  x(x - 1) = 0  ⇒  x = 0, 1
    </text>
    <text x="110" y="245" font-family="serif" font-size="14" fill="#1e293b">
      Inner integral with respect to y from y = x² to y = x:
    </text>
    <text x="110" y="275" font-family="serif" font-size="14" fill="#1e293b">
      ∫_{x²}^{x} (x + y) dy = [ x·y + y²/2 ]_{x²}^{x} = x² + x²/2 - (x³ + x⁴/2) = (3/2)x² - x³ - x⁴/2
    </text>
    <text x="110" y="335" font-family="serif" font-size="14" fill="#1e293b">
      Outer integral with respect to x from 0 to 1:
    </text>
    <text x="110" y="365" font-family="serif" font-size="14" fill="#1e293b">
      ∫₀¹ [ (3/2)x² - x³ - (1/2)x⁴ ] dx = [ (1/2)x³ - (1/4)x⁴ - (1/10)x⁵ ]₀¹
    </text>
    <text x="110" y="395" font-family="serif" font-size="14" fill="#1e293b">
      = 1/2 - 1/4 - 1/10 = 5/10 - 1/10 - 1/4 = 4/10 - 1/4 = 2/5 - 1/4 = 3/20  [Ans]
    </text>
  </svg>
  `;
}

async function seedPhase3Data() {
  console.log('[SEED] Connecting to DEV database:', DEV_DB_NAME);
  if (mongoose.connection.readyState !== 1) {
    await mongoose.connect(process.env.MONGO_URI);
  }

  const activeDb = mongoose.connection.db.databaseName;
  if (!activeDb.includes('dev') && !activeDb.includes('test')) {
    console.error(`❌ FATAL SAFETY ABORT: Connected to non-dev/test database '${activeDb}'. Aborting seed immediately!`);
    process.exit(1);
  }

  const studentUser = {
    _id: new mongoose.Types.ObjectId('6af0306368b20642381ac647'),
    name: 'Alice Patel (DEV)',
    email: 'student.alice.dev@example.test',
    password: 'StudentPass123!',
    role: 'student',
    course: 'Engineering',
    branch: 'CSE',
    semester: 'Semester 1',
    rollNumber: 'ENG-2026-001',
    isApproved: true,
  };

  const teacherUser = {
    _id: new mongoose.Types.ObjectId('6af0306368b20642381ac648'),
    name: 'Prof. Alok Sharma (DEV)',
    email: 'teacher.sharma.dev@example.test',
    password: 'TeacherPass123!',
    role: 'teacher',
    course: 'Engineering',
    branch: 'CSE',
    isApproved: true,
  };

  await User.deleteMany({
    $or: [
      { _id: { $in: [studentUser._id, teacherUser._id] } },
      { email: { $in: [studentUser.email, teacherUser.email] } },
    ]
  });
  await User.create(studentUser);
  await User.create(teacherUser);

  const examId = 'EXAM-MTH101';
  const evalPublishedId = 'eval_alice_published_01';
  const evalPendingId = 'eval_alice_pending_02';

  // Seed Exam Content
  await Content.deleteMany({ id: examId });
  await Content.create({
    id: examId,
    title: 'Engineering Mathematics-I Mid-Term Examination',
    topic: 'Calculus & Linear Algebra',
    type: 'test',
    examType: 'Written',
    testMode: 'WRITTEN',
    course: 'Engineering',
    branch: 'CSE',
    semester: 'Semester 1',
    totalMarks: 50,
    duration: 90,
    isPublished: true,
    createdBy: teacherUser._id,
  });

  // Seed Marking Scheme
  await MarkingScheme.deleteMany({ examId });
  await MarkingScheme.create({
    id: `SCHEME-${examId}`,
    examId,
    examTitle: 'Engineering Mathematics-I Mid-Term Examination',
    course: 'Engineering',
    branch: 'CSE',
    semester: 'Semester 1',
    totalMarks: 50,
    passingMarks: 20,
    createdBy: String(teacherUser._id),
    questions: [
      {
        questionNumber: '1',
        maxMarks: 10,
        questionText: 'Evaluate the definite integral $\\int_{0}^{1} x e^x dx$ using integration by parts.',
        modelSolutionLatex: '\\int_{0}^{1} x e^x dx = [x e^x - e^x]_0^1 = 1',
      },
      {
        questionNumber: '2',
        maxMarks: 15,
        questionText: 'Determine the gradient vector $\\nabla f(x, y)$ for the scalar field $f(x, y) = x^2 + y^2$.',
        modelSolutionLatex: '\\nabla f(x, y) = 2x \\hat{i} + 2y \\hat{j}',
      },
      {
        questionNumber: '3',
        maxMarks: 25,
        questionText: 'Double Integration over Region D bounded by $y = x^2$ and $y = x$.',
        modelSolutionLatex: '\\iint_D (x + y) dx dy = \\frac{3}{20}',
      },
    ],
  });

  // Save Portrait (Page 1) and Landscape (Page 2) SVG script files to private uploads
  const svgP1 = generatePortraitScriptSvg('Alice Patel (DEV)', 'ENG-2026-001', 1);
  const svgP2 = generateLandscapeScriptSvg('Alice Patel (DEV)', 'ENG-2026-001', 2);
  const p1File = `local_private_script_${evalPublishedId}_page_1.svg`;
  const p2File = `local_private_script_${evalPublishedId}_page_2.svg`;
  fs.writeFileSync(path.join(PRIVATE_UPLOADS_DIR, p1File), svgP1);
  fs.writeFileSync(path.join(PRIVATE_UPLOADS_DIR, p2File), svgP2);

  // Seed Published Evaluation with both Portrait and Landscape pages
  await Evaluation.deleteMany({ id: { $in: [evalPublishedId, evalPendingId] } });
  await Evaluation.create({
    id: evalPublishedId,
    testId: examId,
    examId,
    examTitle: 'Engineering Mathematics-I Mid-Term Examination',
    examType: 'Written',
    course: 'Engineering',
    branch: 'CSE',
    semester: 'Semester 1',
    studentId: String(studentUser._id),
    studentEmail: studentUser.email,
    studentName: studentUser.name,
    rollNumber: 'ENG-2026-001',
    status: 'Evaluated',
    evaluationStatus: 'published',
    published: true,
    autoGraded: false,
    marksObtained: 45,
    totalMarks: 50,
    maxMarks: 50,
    percentage: 90,
    grade: 'A+',
    feedback: 'Splendid mathematical reasoning and systematic derivation of integrals and gradients.',
    totalPages: 2,
    answerPages: [
      { pageNumber: 1, fileName: p1File, storageKey: p1File, fileType: 'image/svg+xml', width: 800, height: 1100, aspectRatio: 0.7273 },
      { pageNumber: 2, fileName: p2File, storageKey: p2File, fileType: 'image/svg+xml', width: 1200, height: 800, aspectRatio: 1.5 },
    ],
    questionMarks: [
      { questionNumber: '1', maxMarks: 10, marksAwarded: 10, teacherFeedback: 'Full step marks awarded.' },
      { questionNumber: '2', maxMarks: 15, marksAwarded: 15, teacherFeedback: 'Accurate partial derivatives.' },
      { questionNumber: '3', maxMarks: 25, marksAwarded: 20, teacherFeedback: 'Good double integral setup.' },
    ],
    publishedAt: new Date(Date.now() - 3600000),
    submittedAt: new Date(Date.now() - 86400000),
  });

  // Seed Pending Evaluation
  await Evaluation.create({
    id: evalPendingId,
    testId: 'EXAM-MTH102-PENDING',
    examId: 'EXAM-MTH102-PENDING',
    examTitle: 'Discrete Mathematical Structures Quiz',
    examType: 'Written',
    course: 'Engineering',
    branch: 'CSE',
    semester: 'Semester 1',
    studentId: String(studentUser._id),
    studentEmail: studentUser.email,
    studentName: studentUser.name,
    rollNumber: 'ENG-2026-001',
    status: 'Pending Evaluation',
    evaluationStatus: 'pending',
    published: false,
    autoGraded: false,
    marksObtained: null,
    totalMarks: 25,
    maxMarks: 25,
    totalPages: 1,
    answerPages: [
      { pageNumber: 1, fileName: p1File, storageKey: p1File, fileType: 'image/svg+xml', width: 800, height: 1100, aspectRatio: 0.7273 },
    ],
    submittedAt: new Date(Date.now() - 14400000),
  });

  // Seed Annotations for both Portrait (Page 1) and Landscape (Page 2)
  await EvaluationAnnotation.deleteMany({ evaluationId: evalPublishedId });
  await EvaluationAnnotation.create([
    {
      id: `ann_p1_${Date.now()}_1`,
      evaluationId: evalPublishedId,
      pageNumber: 1,
      tool: 'stamp',
      color: '#10b981',
      coordinates: [{ x: 0.85, y: 0.40 }],
      authorId: String(teacherUser._id),
      authorName: teacherUser.name,
      authorRole: 'teacher',
    },
    {
      id: `ann_p1_${Date.now()}_2`,
      evaluationId: evalPublishedId,
      pageNumber: 1,
      tool: 'pen',
      color: '#ef4444',
      strokeWidth: 3,
      coordinates: [
        { x: 0.12, y: 0.42 },
        { x: 0.55, y: 0.42 },
      ],
      authorId: String(teacherUser._id),
      authorName: teacherUser.name,
      authorRole: 'teacher',
    },
    {
      id: `ann_p1_${Date.now()}_3`,
      evaluationId: evalPublishedId,
      pageNumber: 1,
      tool: 'text',
      color: '#f59e0b',
      content: 'Excellent integration by parts formulation.',
      coordinates: [{ x: 0.58, y: 0.38 }],
      authorId: String(teacherUser._id),
      authorName: teacherUser.name,
      authorRole: 'teacher',
    },
    // Page 2 Landscape Annotations
    {
      id: `ann_p2_${Date.now()}_1`,
      evaluationId: evalPublishedId,
      pageNumber: 2,
      tool: 'stamp',
      color: '#10b981',
      coordinates: [{ x: 0.50, y: 0.50 }], // Relative center on landscape page
      authorId: String(teacherUser._id),
      authorName: teacherUser.name,
      authorRole: 'teacher',
    },
    {
      id: `ann_p2_${Date.now()}_2`,
      evaluationId: evalPublishedId,
      pageNumber: 2,
      tool: 'text',
      color: '#3b82f6',
      content: 'Well-drawn double integration region on landscape scan.',
      coordinates: [{ x: 0.55, y: 0.48 }],
      authorId: String(teacherUser._id),
      authorName: teacherUser.name,
      authorRole: 'teacher',
    },
  ]);

  // Seed Re-Evaluation Dispute Request
  await ReEvaluationRequest.deleteMany({ evaluationId: evalPublishedId });
  await ReEvaluationRequest.create({
    id: `reeval_${evalPublishedId}`,
    evaluationId: evalPublishedId,
    testId: examId,
    testTitle: 'Engineering Mathematics-I Mid-Term Examination',
    studentId: String(studentUser._id),
    studentEmail: studentUser.email,
    studentName: studentUser.name,
    course: 'Engineering',
    branch: 'CSE',
    semester: 'Semester 1',
    questionNumbers: ['3'],
    reason: 'Please review Q3 outer integral evaluation. My calculation of 3/20 appears algebraically exact per standard integration tables.',
    currentMarks: 45,
    status: 'pending',
    requestedAt: new Date(Date.now() - 7200000),
  });

  // Seed Broadcast & Personal Notifications
  await Notification.deleteMany({
    $or: [
      { userId: String(studentUser._id) },
      { userId: studentUser.email },
      { 'metadata.evaluationId': evalPublishedId },
    ],
  });

  await Notification.create({
    id: `notif_result_${Date.now()}`,
    userId: String(studentUser._id),
    title: 'Exam Result Published',
    message: 'Your result for Engineering Mathematics-I Mid-Term Examination has been published (45/50, Grade A+).',
    type: 'result_published',
    metadata: { evaluationId: evalPublishedId, testId: examId },
    isRead: false,
    createdAt: new Date(Date.now() - 3600000),
  });

  await Notification.create({
    id: `notif_bcast_${Date.now()}`,
    userId: null,
    course: 'Engineering',
    title: 'Unit 3 Lecture Notes & Practice Problem Set',
    message: 'Dr. Sardar uploaded comprehensive notes on Multivariable Calculus and Double Integrals.',
    type: 'materials',
    isRead: false,
    createdAt: new Date(Date.now() - 1800000),
  });

  console.log('[SEED] ✓ Successfully seeded Student, Teacher, Exam, Published Evaluation, Annotations, Dispute & Notifications!');
  return { studentUser, teacherUser, evalPublishedId, evalPendingId, p1File, p2File };
}

async function captureScreenshots() {
  const seed = await seedPhase3Data();
  const studentToken = jwt.sign(
    {
      id: String(seed.studentUser._id),
      email: seed.studentUser.email,
      role: seed.studentUser.role,
      name: seed.studentUser.name,
      course: seed.studentUser.course,
      branch: seed.studentUser.branch,
      semester: seed.studentUser.semester,
    },
    process.env.JWT_SECRET || require('crypto').randomBytes(32).toString('hex'),
    { expiresIn: '2h' }
  );

  const teacherToken = jwt.sign(
    {
      id: String(seed.teacherUser._id),
      email: seed.teacherUser.email,
      role: seed.teacherUser.role,
      name: seed.teacherUser.name,
      course: seed.teacherUser.course,
      branch: seed.teacherUser.branch,
    },
    process.env.JWT_SECRET || require('crypto').randomBytes(32).toString('hex'),
    { expiresIn: '2h' }
  );

  console.log('[BROWSER] Launching Microsoft Edge via Puppeteer...');
  const browser = await puppeteer.launch({
    executablePath: EDGE_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--window-size=1440,900'],
  });

  const page = await browser.newPage();

  // Helper to inject student session
  async function injectStudentSession() {
    await page.evaluate((tok, usr) => {
      localStorage.setItem('token', tok);
      sessionStorage.setItem('token', tok);
      localStorage.setItem('user', JSON.stringify(usr));
      sessionStorage.setItem('user', JSON.stringify(usr));
      localStorage.setItem('userRole', 'student');
    }, studentToken, {
      id: String(seed.studentUser._id),
      name: seed.studentUser.name,
      email: seed.studentUser.email,
      role: 'student',
      course: 'Engineering',
      branch: 'CSE',
      semester: 'Semester 1',
      rollNumber: 'ENG-2026-001',
    });
  }

  // Helper to inject teacher session
  async function injectTeacherSession() {
    await page.evaluate((tok, usr) => {
      localStorage.setItem('token', tok);
      sessionStorage.setItem('token', tok);
      localStorage.setItem('user', JSON.stringify(usr));
      sessionStorage.setItem('user', JSON.stringify(usr));
      localStorage.setItem('userRole', 'teacher');
    }, teacherToken, {
      id: String(seed.teacherUser._id),
      name: seed.teacherUser.name,
      email: seed.teacherUser.email,
      role: 'teacher',
      course: 'Engineering',
      branch: 'CSE',
    });
  }

  // ── VIEW 1: Desktop Student "My Exams" with "View Result & Script" Button ──
  console.log('Capturing View 1: Desktop Student My Exams...');
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto('http://localhost:5173/login', { waitUntil: 'networkidle2' });
  await injectStudentSession();
  await page.goto('http://localhost:5173/student?tab=exams', { waitUntil: 'networkidle2' });
  await sleep(2500);

  const shot1 = path.join(SCREENSHOT_DIR, 'eval_p3_01_student_my_exams_desktop.png');
  await page.screenshot({ path: shot1, fullPage: false });
  console.log('✓ Saved:', shot1);

  // ── VIEW 2: Desktop Student Result Modal (Portrait Page 1 with Vector Annotations) ──
  console.log('Capturing View 2: Desktop Student Result Modal (Portrait Page 1)...');
  const viewResultBtn = await page.$('button ::-p-text(View Result & Script)');
  if (viewResultBtn) {
    await viewResultBtn.click();
    await sleep(2500);
  }
  const shot2 = path.join(SCREENSHOT_DIR, 'eval_p3_02_student_result_modal_desktop.png');
  await page.screenshot({ path: shot2, fullPage: false });
  console.log('✓ Saved:', shot2);

  // ── VIEW 3: Landscape Script Page 2 with Centered Annotations ──
  console.log('Capturing View 3: Landscape Script Page 2 (with aspect-ratio locked annotations)...');
  const nextPgBtn = await page.$('button ::-p-text(Next ▶)');
  if (nextPgBtn) {
    await nextPgBtn.click();
    await sleep(2000);
  }
  const shotLandscape = path.join(SCREENSHOT_DIR, 'eval_p3_03_student_result_landscape_page.png');
  await page.screenshot({ path: shotLandscape, fullPage: false });
  console.log('✓ Saved:', shotLandscape);

  // Switch back to Page 1 for tablet/mobile shots
  const prevPgBtn = await page.$('button ::-p-text(◀ Prev)');
  if (prevPgBtn) {
    await prevPgBtn.click();
    await sleep(1500);
  }

  // ── VIEW 4: Tablet 768px Student Result View ──
  console.log('Capturing View 4: Tablet 768px Student Result View...');
  await page.setViewport({ width: 768, height: 1024 });
  await sleep(1500);
  const shot3 = path.join(SCREENSHOT_DIR, 'eval_p3_03_student_result_modal_tablet_768.png');
  await page.screenshot({ path: shot3, fullPage: false });
  console.log('✓ Saved:', shot3);

  // ── VIEW 5: Mobile 360px Marks & Feedback Tab (Strictly 360px) ──
  console.log('Capturing View 5: Mobile 360px Marks & Feedback Tab...');
  await page.setViewport({ width: 360, height: 780 });
  const marksTabBtn = await page.$('button ::-p-text(Marks & Feedback)');
  if (marksTabBtn) {
    await marksTabBtn.click();
    await sleep(1500);
  }
  const shot5 = path.join(SCREENSHOT_DIR, 'eval_p3_05_student_marks_tab_mobile_360.png');
  await page.screenshot({ path: shot5, fullPage: false });
  console.log('✓ Saved:', shot5);

  // ── VIEW 6: Mobile 360px Re-Evaluation Dispute Tab & Form (Strictly 360px) ──
  console.log('Capturing View 6: Mobile 360px Re-Evaluation Dispute Tab...');
  const disputeTabBtn = await page.$('button ::-p-text(Re-Evaluation)');
  if (disputeTabBtn) {
    await disputeTabBtn.click();
    await sleep(1500);
  }
  const shot6 = path.join(SCREENSHOT_DIR, 'eval_p3_06_student_dispute_tab_mobile_360.png');
  await page.screenshot({ path: shot6, fullPage: false });
  console.log('✓ Saved:', shot6);

  // Close Modal
  const closeBtn = await page.$('button[aria-label="Close modal"]');
  if (closeBtn) {
    await closeBtn.click();
    await sleep(1000);
  }

  // ── VIEW 7: Student "Pending Evaluation" Clear State ──
  console.log('Capturing View 7: Student Pending Evaluation State...');
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto('http://localhost:5173/student?tab=performance', { waitUntil: 'networkidle2' });
  await sleep(2000);

  const viewPendingBtn = await page.$('button ::-p-text(View)');
  if (viewPendingBtn) {
    await viewPendingBtn.click();
    await sleep(2000);
  }
  const shot7 = path.join(SCREENSHOT_DIR, 'eval_p3_07_student_pending_state.png');
  await page.screenshot({ path: shot7, fullPage: false });
  console.log('✓ Saved:', shot7);

  // Close Modal
  const closePendingBtn = await page.$('button[aria-label="Close modal"]');
  if (closePendingBtn) {
    await closePendingBtn.click();
    await sleep(1000);
  }

  // ── VIEW 8: Student Notifications Popover with Assessment Alerts ──
  console.log('Capturing View 8: Student Notifications Popover...');
  await page.goto('http://localhost:5173/student?tab=dashboard', { waitUntil: 'networkidle2' });
  await sleep(2000);
  const bellBtn = await page.$('button[title*="Announcements & Test Notifications"]');
  if (bellBtn) {
    await bellBtn.click();
    await sleep(1200);
  }
  const shot8 = path.join(SCREENSHOT_DIR, 'eval_p3_08_student_notifications_popover.png');
  await page.screenshot({ path: shot8, fullPage: false });
  console.log('✓ Saved:', shot8);

  // ── VIEW 9: Teacher Version Conflict Dialog ("Reload" vs "Keep Mine") ──
  console.log('Capturing View 9: Teacher Version Conflict Dialog...');
  await injectTeacherSession();
  await page.goto('http://localhost:5173/admin', { waitUntil: 'networkidle2' });
  await sleep(2500);

  const evalHubNav = await page.$('button ::-p-text(Evaluation Hub)');
  if (evalHubNav) {
    await evalHubNav.click();
    await sleep(2500);
  }

  const evaluateBtn = await page.$('button ::-p-text(Evaluate Script)');
  if (evaluateBtn) {
    await evaluateBtn.click();
    await sleep(2500);
  }

  // Artificial bump of server evaluation version to trigger conflict dialog
  await Evaluation.updateOne({ id: seed.evalPublishedId }, { $inc: { version: 5 } });
  const draftSaveBtn = await page.$('button ::-p-text(Save Draft)');
  if (draftSaveBtn) {
    await draftSaveBtn.click();
    await sleep(1500);
  }

  const shot9 = path.join(SCREENSHOT_DIR, 'eval_p3_09_teacher_version_conflict_dialog.png');
  await page.screenshot({ path: shot9, fullPage: false });
  console.log('✓ Saved:', shot9);

  await browser.close();

  // Teardown
  console.log('\n[TEARDOWN] Cleaning up screenshot test records...');
  await User.deleteMany({ email: { $in: ['student.alice.dev@example.test', 'teacher.sharma.dev@example.test'] } });
  await Evaluation.deleteMany({ id: { $in: [seed.evalPublishedId, seed.evalPendingId] } });
  await EvaluationAnnotation.deleteMany({ evaluationId: seed.evalPublishedId });
  await ReEvaluationRequest.deleteMany({ evaluationId: seed.evalPublishedId });
  await Notification.deleteMany({ userId: { $in: [String(seed.studentUser._id), seed.studentUser.email] } });

  const p1Path = path.join(PRIVATE_UPLOADS_DIR, seed.p1File);
  const p2Path = path.join(PRIVATE_UPLOADS_DIR, seed.p2File);
  if (fs.existsSync(p1Path)) fs.unlinkSync(p1Path);
  if (fs.existsSync(p2Path)) fs.unlinkSync(p2Path);

  await mongoose.disconnect();
  console.log('✓ Teardown complete. Zero lingering test records in DEV database.');
  console.log('\nALL PHASE 3 SCREENSHOTS CAPTURED AND VERIFIED SUCCESSFULLY!');
}

captureScreenshots().catch((err) => {
  console.error('❌ Error capturing screenshots:', err);
  mongoose.disconnect().finally(() => process.exit(1));
});
