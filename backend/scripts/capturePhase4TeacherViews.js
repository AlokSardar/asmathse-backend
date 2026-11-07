const puppeteer = require('puppeteer-core');
const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const User = require('../models/User');
const Doubt = require('../models/Doubt');
const DoubtMessage = require('../models/DoubtMessage');
const DoubtTemplate = require('../models/DoubtTemplate');
const Notification = require('../models/Notification');

const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const SCREENSHOT_DIR = path.resolve('C:\\Users\\User\\.gemini\\antigravity\\brain\\25b12a71-a1f6-44d1-b276-f07028d4b8af\\screenshots');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!fs.existsSync(SCREENSHOT_DIR)) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

// 1x1 base64 transparent gif or minimal png for sample attachment
const SAMPLE_IMAGE_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function seedDataForScreenshots(teacher, student) {
  // Clear existing doubts & notifications for clean deterministic capture
  await Doubt.deleteMany({ course: 'engineering' });
  await DoubtMessage.deleteMany({});
  await DoubtTemplate.deleteMany({ teacher: teacher._id });
  await Notification.deleteMany({});

  // 1. Breached SLA Ticket (27 hours ago -> 3 hours past 24h deadline)
  const breachedDeadline = new Date(Date.now() - 3 * 60 * 60 * 1000);
  const breachedDoubt = await Doubt.create({
    doubtCode: 'DBT-26-0012-BRCH',
    student: student._id,
    studentName: student.name,
    studentEmail: student.email,
    studentRoll: 'ENG-2026-042',
    course: 'engineering',
    branch: 'CSE',
    semester: 1,
    subject: 'Mathematics',
    topic: 'Differential Equations',
    title: 'Solve non-homogeneous second-order ODE: y\'\' + 4y = \\sin(2x)',
    status: 'escalated',
    priority: 'high',
    slaDeadline: breachedDeadline,
    slaDueAt: breachedDeadline,
    escalatedAt: new Date(Date.now() - 27 * 60 * 60 * 1000),
    escalationReason: 'Method of undetermined coefficients produces resonance division by zero. Need faculty guidance.',
    aiExplanation: {
      summary: 'Solve the linear ordinary differential equation with resonance.',
      modelUsed: 'gemini-3.8-flash',
      isFallbackModel: false,
      steps: [
        {
          stepNumber: 1,
          title: 'Characteristic Equation',
          explanation: 'Roots of r^2 + 4 = 0 are r = \\pm 2i. Complementary solution is y_c = c_1 \\cos(2x) + c_2 \\sin(2x).',
          math: 'y_c(x) = c_1 \\cos(2x) + c_2 \\sin(2x)',
        },
      ],
      finalAnswer: 'y_p(x) = -\\frac{x}{4} \\cos(2x)',
    },
    auditTrail: [
      {
        status: 'escalated',
        changedBy: student.name,
        role: 'student',
        note: 'Escalated due to resonance ambiguity.',
        timestamp: new Date(Date.now() - 27 * 60 * 60 * 1000),
      },
    ],
  });

  // 2. Active Image Doubt for Pan/Zoom/Rotate Review
  const dueSoonDeadline = new Date(Date.now() + 2 * 60 * 60 * 1000 + 45 * 60 * 1000); // 2h 45m left
  const imageDoubt = await Doubt.create({
    doubtCode: 'DBT-26-0015-IMG7',
    student: student._id,
    studentName: student.name,
    studentEmail: student.email,
    studentRoll: 'ENG-2026-042',
    course: 'engineering',
    branch: 'CSE',
    semester: 1,
    subject: 'Mathematics',
    topic: 'Integral Calculus',
    title: 'Evaluate definite integral: \\int_0^{\\pi/2} \\frac{\\sin x}{1 + \\cos^2 x} \\, dx',
    status: 'teacher_assigned',
    priority: 'normal',
    assignedTeacher: {
      id: teacher._id,
      name: teacher.name,
      email: teacher.email,
      assignedAt: new Date(Date.now() - 30 * 60 * 1000),
    },
    slaDeadline: dueSoonDeadline,
    slaDueAt: dueSoonDeadline,
    escalatedAt: new Date(Date.now() - 21 * 60 * 60 * 1000),
    escalationReason: 'Need step-by-step substitution details with limits change.',
    attachments: [
      {
        fileName: 'Handwritten_Calculus_Problem.jpg',
        mimeType: 'image/jpeg',
        base64Data: SAMPLE_IMAGE_BASE64,
        size: 1024,
      },
    ],
    aiTranscription: {
      problemText: 'Evaluate the definite integral of (sin x) / (1 + cos^2 x) dx from 0 to pi/2.',
      latexEquation: '\\int_0^{\\frac{\\pi}{2}} \\frac{\\sin x}{1 + \\cos^2 x}\\,dx',
      confidence: 0.96,
      warnings: ['Ruled paper detected', 'Clean handwriting'],
      confirmedByUser: true,
      modelUsed: 'gemini-3.5-flash',
    },
    aiExplanation: {
      summary: 'Evaluate definite integral using substitution u = cos(x).',
      modelUsed: 'gemini-3.8-flash',
      isFallbackModel: false,
      steps: [
        {
          stepNumber: 1,
          title: 'Substitute u = cos(x)',
          explanation: 'Let u = \\cos x, then du = -\\sin x \\, dx. Limits change: x = 0 \\implies u = 1, x = \\pi/2 \\implies u = 0.',
          math: '\\int_1^0 \\frac{-du}{1 + u^2} = \\int_0^1 \\frac{du}{1 + u^2}',
        },
        {
          stepNumber: 2,
          title: 'Standard Arctan Integration',
          explanation: 'Recall \\int \\frac{1}{1+u^2}du = \\arctan(u). Evaluate from 0 to 1.',
          math: '\\left[ \\arctan(u) \\right]_0^1 = \\arctan(1) - \\arctan(0) = \\frac{\\pi}{4}',
        },
      ],
      finalAnswer: '\\frac{\\pi}{4}',
      quickCheck: 'Integrand is positive on [0, pi/2] with max 1, so integral is bounded in (0, pi/2). pi/4 ~ 0.785 is consistent.',
    },
    auditTrail: [
      {
        status: 'escalated',
        changedBy: student.name,
        role: 'student',
        note: 'Escalated by student.',
        timestamp: new Date(Date.now() - 21 * 60 * 60 * 1000),
      },
      {
        status: 'teacher_assigned',
        changedBy: teacher.name,
        role: 'teacher',
        note: `Claimed by faculty ${teacher.name}`,
        timestamp: new Date(Date.now() - 30 * 60 * 1000),
      },
    ],
  });

  // 3. Saved Templates
  await DoubtTemplate.create({
    teacher: teacher._id,
    title: 'Standard Definite Integral by Substitution',
    category: 'Calculus',
    contentPlain: 'To evaluate this integral, let us make a trigonometric substitution:\n1. Choose substitution variable u.\n2. Transform differential element du.\n3. Strictly map upper and lower limits.\n4. Integrate and substitute back.',
    contentLatex: '\\int_{a}^{b} f(g(x))g\'(x)\\,dx = \\int_{g(a)}^{g(b)} f(u)\\,du',
  });

  await DoubtTemplate.create({
    teacher: teacher._id,
    title: 'Resonance in Second-Order Linear ODEs',
    category: 'Differential Equations',
    contentPlain: 'When the forcing term matches the natural frequency of the homogeneous system, the standard trial solution fails due to resonance. Multiply the trial solution by x.',
    contentLatex: 'y_p(x) = x(A \\cos(\\omega x) + B \\sin(\\omega x))',
  });

  // 4. Notifications
  await Notification.create({
    id: `notif_breach_1`,
    title: `SLA Breached: ${breachedDoubt.doubtCode}`,
    message: `Doubt ${breachedDoubt.doubtCode} (${breachedDoubt.topic}) has breached its 24-hour SLA deadline. Immediate action required.`,
    type: 'doubt_sla_breach',
    course: 'engineering',
    branch: 'CSE',
    userId: teacher._id,
    doubtId: breachedDoubt._id,
    targetRole: 'teacher',
    isRead: false,
    createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
  });

  await Notification.create({
    id: `notif_esc_2`,
    title: 'New Student Doubt Escalated',
    message: `${student.name} escalated doubt ${imageDoubt.doubtCode} (${imageDoubt.topic}) with 24h SLA.`,
    type: 'doubt_escalation',
    course: 'engineering',
    branch: 'CSE',
    userId: teacher._id,
    doubtId: imageDoubt._id,
    targetRole: 'teacher',
    isRead: false,
    createdAt: new Date(Date.now() - 45 * 60 * 1000),
  });

  return { breachedDoubt, imageDoubt };
}

async function captureViews() {
  console.log('Connecting to database and seeding test records...');
  await mongoose.connect(process.env.MONGO_URI);
  const teacher = await User.findOne({ email: 'mukherjee.eng@asmaths.edu' });
  const student = await User.findOne({ email: 'student@asmaths.edu' });

  const { breachedDoubt, imageDoubt } = await seedDataForScreenshots(teacher, student);
  console.log('Seeded test records. Launching browser...');

  const browser = await puppeteer.launch({
    executablePath: EDGE_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1280,800'],
  });

  const page = await browser.newPage();

  // Helper to login and set session in localStorage
  async function setupTeacherSession() {
    await page.goto('http://localhost:5173/login', { waitUntil: 'networkidle2' });
    await page.evaluate((teacherUser) => {
      const sessionObj = {
        token: 'test_token_phase4',
        user: {
          _id: teacherUser._id,
          id: teacherUser._id,
          name: teacherUser.name,
          email: teacherUser.email,
          role: 'teacher',
          primaryRole: 'teacher',
          targetCourse: 'engineering',
          branch: 'CSE',
        },
      };
      localStorage.setItem('asmaths_token', 'test_token_phase4');
      localStorage.setItem('asmaths_user', JSON.stringify(sessionObj.user));
    }, teacher);

    // Also inject real auth token by hitting login endpoint
    const res = await fetch('http://localhost:5000/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'mukherjee.eng@asmaths.edu', password: 'TestPassword123!' }),
    });
    const authData = await res.json();
    await page.evaluate((data) => {
      localStorage.setItem('asmaths_token', data.token);
      localStorage.setItem('asmaths_user', JSON.stringify(data.user || data));
    }, authData);
  }

  await setupTeacherSession();

  // ── VIEW 1: Teacher Queue with Filters & Counters ─────────────────────────
  console.log('Capturing View 1: Teacher Queue (Desktop & Mobile)...');
  await page.setViewport({ width: 1280, height: 800 });
  await page.goto('http://localhost:5173/admin', { waitUntil: 'networkidle2' });
  await sleep(1500);

  // Click doubts tab in sidebar if not already active
  await page.evaluate(() => {
    const doubtsBtn = Array.from(document.querySelectorAll('button')).find((b) =>
      b.textContent.includes('Doubts Escalator')
    );
    if (doubtsBtn) doubtsBtn.click();
  });
  await sleep(2000);

  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, 'phase4_01_queue_desktop.png'),
    fullPage: false,
  });

  // Mobile View
  await page.setViewport({ width: 375, height: 812, isMobile: true });
  await sleep(1000);
  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, 'phase4_01_queue_mobile.png'),
    fullPage: false,
  });

  // ── VIEW 2: Doubt Review Context with Image Pan/Zoom/Rotate ────────────────
  console.log('Capturing View 2: Doubt Review Context with Image Controls...');
  await page.setViewport({ width: 1280, height: 800 });
  await sleep(1000);

  // Click on the Image Doubt in queue list
  await page.evaluate((code) => {
    const items = Array.from(document.querySelectorAll('div'));
    const ticket = items.find((d) => d.textContent.includes(code));
    if (ticket) ticket.click();
  }, imageDoubt.doubtCode);
  await sleep(2000);

  // Click Rotate button once to show interactive rotation
  await page.evaluate(() => {
    const rotateBtn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent.includes('⟳'));
    if (rotateBtn) rotateBtn.click();
  });
  await sleep(800);

  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, 'phase4_02_review_image_desktop.png'),
    fullPage: false,
  });

  // Mobile View
  await page.setViewport({ width: 375, height: 812, isMobile: true });
  await page.evaluate(() => {
    const detailTab = Array.from(document.querySelectorAll('button')).find((b) => b.textContent.includes('Doubt Review'));
    if (detailTab) detailTab.click();
  });
  await sleep(1000);
  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, 'phase4_02_review_image_mobile.png'),
    fullPage: false,
  });

  // ── VIEW 3: Answer Studio with Live KaTeX Preview & Toolbar ────────────────
  console.log('Capturing View 3: Answer Studio with Live KaTeX Preview & Templates...');
  await page.setViewport({ width: 1280, height: 800 });
  await sleep(1000);

  // Type verified solution into editor
  await page.evaluate(() => {
    const textarea = document.querySelector('textarea');
    if (textarea) {
      textarea.value = `### Verified Faculty Derivation\n\nWe apply substitution $u = \\cos x$:\n$$\\int_0^{\\frac{\\pi}{2}} \\frac{\\sin x}{1 + \\cos^2 x}\\,dx = \\left[ -\\arctan(\\cos x) \\right]_0^{\\frac{\\pi}{2}} = -\\arctan(0) - (-\\arctan(1)) = \\frac{\\pi}{4}$$\n\nVerified by Prof. S. Mukherjee.`;
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
  await sleep(1000);

  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, 'phase4_03_answer_studio_desktop.png'),
    fullPage: false,
  });

  // Mobile View
  await page.setViewport({ width: 375, height: 812, isMobile: true });
  await page.evaluate(() => {
    const studioTab = Array.from(document.querySelectorAll('button')).find((b) => b.textContent.includes('Answer Studio'));
    if (studioTab) studioTab.click();
  });
  await sleep(1000);
  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, 'phase4_03_answer_studio_mobile.png'),
    fullPage: false,
  });

  // ── VIEW 4: Breached-SLA Item ──────────────────────────────────────────────
  console.log('Capturing View 4: Breached-SLA Item...');
  await page.setViewport({ width: 1280, height: 800 });
  await sleep(1000);

  // Select Breached Doubt
  await page.evaluate((code) => {
    const items = Array.from(document.querySelectorAll('div'));
    const ticket = items.find((d) => d.textContent.includes(code));
    if (ticket) ticket.click();
  }, breachedDoubt.doubtCode);
  await sleep(1500);

  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, 'phase4_04_breached_sla_desktop.png'),
    fullPage: false,
  });

  // ── VIEW 5: Notification List Dropdown ────────────────────────────────────
  console.log('Capturing View 5: Notification List Dropdown...');
  await page.evaluate(() => {
    const bellBtn = document.querySelector('header button[title*="Alerts"]');
    if (bellBtn) bellBtn.click();
  });
  await sleep(800);

  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, 'phase4_06_notifications_desktop.png'),
    fullPage: false,
  });

  // Close dropdown
  await page.evaluate(() => {
    const bellBtn = document.querySelector('header button[title*="Alerts"]');
    if (bellBtn) bellBtn.click();
  });
  await sleep(500);

  // ── VIEW 6: Empty Queue State ──────────────────────────────────────────────
  console.log('Capturing View 6: Empty Queue State...');
  // Filter by a search query that matches nothing
  await page.evaluate(() => {
    const searchInput = document.querySelector('input[placeholder*="Search ticket"]');
    if (searchInput) {
      searchInput.value = 'NO_MATCHING_TICKET_XYZ';
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
  await sleep(1500);

  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, 'phase4_05_empty_queue_desktop.png'),
    fullPage: false,
  });

  console.log('\nAll 6 required Phase 4 screenshots successfully captured in:');
  console.log(SCREENSHOT_DIR);

  await browser.close();
  process.exit(0);
}

captureViews().catch((err) => {
  console.error('Screenshot capture failed:', err);
  process.exit(1);
});
