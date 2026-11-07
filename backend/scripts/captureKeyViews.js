const puppeteer = require('puppeteer-core');
const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const User = require('../models/User');
const Doubt = require('../models/Doubt');
const DoubtMessage = require('../models/DoubtMessage');
const DoubtQuota = require('../models/DoubtQuota');

const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const SCREENSHOT_DIR = path.resolve('C:\\Users\\User\\.gemini\\antigravity\\brain\\25b12a71-a1f6-44d1-b276-f07028d4b8af\\screenshots');

if (!fs.existsSync(SCREENSHOT_DIR)) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

async function setupTestData(student) {
  // Clear any old test doubts for this student to keep state crisp and clean
  await Doubt.deleteMany({ student: student._id });
  await DoubtMessage.deleteMany({});

  // Reset student daily quota to 1 used (4 remaining)
  const todayStr = new Date().toISOString().split('T')[0];
  await mongoose.models.StudentDailyQuota.findOneAndUpdate(
    { studentId: student._id.toString(), date: todayStr },
    { $set: { count: 1 } },
    { upsert: true }
  );

  // 1. A transcribed doubt (Stage 1 Confirmation)
  const transcribedDoubt = new Doubt({
    doubtCode: 'DBT-26-0042-TRNS',
    student: student._id,
    studentName: student.name,
    studentEmail: student.email,
    course: 'Engineering',
    branch: 'CSE',
    semester: 1,
    topic: 'Differential & Integral Calculus',
    title: 'Evaluate definite integral with trigonometric substitution',
    language: 'en',
    status: 'transcribed',
    aiTranscription: {
      problemText: 'Evaluate the definite integral of (sin x) / (1 + cos^2 x) dx from 0 to pi/2.',
      latexEquation: '\\int_0^{\\frac{\\pi}{2}} \\frac{\\sin x}{1 + \\cos^2 x}\\,dx',
      confidence: 0.98,
      warnings: ['Ruled notebook paper detected', 'Slight hand tilt (+4 deg)'],
      confirmedByUser: false,
      transcribedAt: new Date(),
      modelUsed: 'gemini-3.5-flash',
    },
  });
  await transcribedDoubt.save();

  // 2. An AI answered doubt (Pedagogical Solution Card + Followup thread)
  const answeredDoubt = new Doubt({
    doubtCode: 'DBT-26-0038-SOLV',
    student: student._id,
    studentName: student.name,
    studentEmail: student.email,
    course: 'Engineering',
    branch: 'CSE',
    semester: 1,
    topic: 'Differential & Integral Calculus',
    title: 'Evaluate definite integral: int_0^{pi/2} (sin x)/(1 + cos^2 x) dx',
    language: 'en',
    status: 'ai_answered',
    followupCount: 1,
    aiExplanation: {
      summary: 'Find the exact value of the definite integral $I = \\int_0^{\\frac{\\pi}{2}} \\frac{\\sin x}{1 + \\cos^2 x}\\,dx$ using the substitution $u = \\cos x$.',
      conceptsUsed: ['Integration by Substitution', 'Standard Arctangent Integral', 'Fundamental Theorem of Calculus'],
      steps: [
        {
          stepNumber: 1,
          title: 'Choose the appropriate algebraic substitution',
          explanation: 'Notice that the derivative of $\\cos x$ is $-\\sin x$, and the numerator contains $\\sin x\\,dx$. We let $u = \\cos x$.',
          math: 'u = \\cos x \\implies du = -\\sin x\\,dx \\implies \\sin x\\,dx = -du',
        },
        {
          stepNumber: 2,
          title: 'Transform the integration limits',
          explanation: 'When changing variables in a definite integral, transform the upper and lower limits corresponding to $u = \\cos x$:',
          math: 'x = 0 \\implies u = \\cos(0) = 1, \\quad x = \\frac{\\pi}{2} \\implies u = \\cos\\left(\\frac{\\pi}{2}\\right) = 0',
        },
        {
          stepNumber: 3,
          title: 'Rewrite and evaluate the integral in terms of u',
          explanation: 'Substitute $u$, $du$, and the new limits into the integral. We can absorb the negative sign by swapping the upper and lower limits:',
          math: 'I = \\int_1^0 \\frac{-du}{1 + u^2} = \\int_0^1 \\frac{du}{1 + u^2} = \\left[ \\arctan(u) \\right]_0^1',
        },
        {
          stepNumber: 4,
          title: 'Apply the Fundamental Theorem of Calculus',
          explanation: 'Compute the difference of the antiderivative evaluated at the upper and lower limits:',
          math: 'I = \\arctan(1) - \\arctan(0) = \\frac{\\pi}{4} - 0 = \\frac{\\pi}{4}',
        },
      ],
      finalAnswer: '\\int_0^{\\frac{\\pi}{2}} \\frac{\\sin x}{1 + \\cos^2 x}\\,dx = \\frac{\\pi}{4}',
      quickCheck: 'Since $\\sin x > 0$ and $1 + \\cos^2 x \\in [1, 2]$ on $(0, \\pi/2)$, the integrand is strictly positive and bounded by $1/2 \\le f(x) \\le 1$. Hence $\\frac{\\pi}{4} \\approx 0.785$ lies safely within $(0.5 \\times \\frac{\\pi}{2}, 1 \\times \\frac{\\pi}{2}) = [0.785, 1.57]$.',
      commonMistakes: [
        'Forgetting to transform the limits of integration when substituting $u = \\cos x$.',
        'Dropping the negative sign from $du = -\\sin x\\,dx$ without reversing the integration limits.',
        'Confusing $\\int \\frac{1}{1 + u^2}du = \\arctan(u)$ with natural log $\\ln(1 + u^2)$.',
      ],
      modelUsed: 'gemini-3.8-flash',
      isFallbackModel: false,
      disclaimer: 'AI-generated, may contain mistakes',
      generatedAt: new Date(),
    },
  });
  await answeredDoubt.save();

  // Create messages for the answered doubt
  await DoubtMessage.create({
    doubt: answeredDoubt._id,
    authorRole: 'student',
    authorName: student.name,
    messageType: 'student_question',
    contentPlain: 'How do I evaluate int_0^{pi/2} (sin x)/(1 + cos^2 x) dx step-by-step?',
    contentLatex: '\\int_0^{\\frac{\\pi}{2}} \\frac{\\sin x}{1 + \\cos^2 x}\\,dx',
  });

  await DoubtMessage.create({
    doubt: answeredDoubt._id,
    authorRole: 'ai',
    authorName: 'AI Pedagogical Tutor (Tier 1)',
    messageType: 'explanation',
    contentPlain: 'Here is the step-by-step pedagogical solution.',
    contentLatex: '\\frac{\\pi}{4}',
    structuredSteps: answeredDoubt.aiExplanation.steps,
    finalAnswer: answeredDoubt.aiExplanation.finalAnswer,
  });

  await DoubtMessage.create({
    doubt: answeredDoubt._id,
    authorRole: 'student',
    authorName: student.name,
    messageType: 'followup',
    contentPlain: 'Why did the limits swap from 1 to 0 into 0 to 1 in Step 3?',
    contentLatex: '\\int_1^0 -f(u)du = \\int_0^1 f(u)du',
  });

  await DoubtMessage.create({
    doubt: answeredDoubt._id,
    authorRole: 'ai',
    authorName: 'AI Pedagogical Tutor (Tier 1)',
    messageType: 'explanation',
    contentPlain: 'By the standard property of definite integrals, reversing the direction of integration introduces a minus sign: $\\int_a^b g(u)\\,du = -\\int_b^a g(u)\\,du$. Since we had $-\\int_1^0 \\frac{du}{1+u^2}$, the negative sign cancels out when we change the lower limit to 0 and the upper limit to 1.',
    contentLatex: '-\\int_1^0 \\frac{du}{1 + u^2} = \\int_0^1 \\frac{du}{1 + u^2}',
  });

  // 3. An Escalated doubt with 24h SLA
  const escalatedDoubt = new Doubt({
    doubtCode: 'DBT-26-0035-ESCL',
    student: student._id,
    studentName: student.name,
    studentEmail: student.email,
    course: 'Engineering',
    branch: 'CSE',
    semester: 1,
    topic: 'Ordinary Differential Equations',
    title: 'Solve non-homogeneous second-order ODE with method of undetermined coefficients',
    language: 'en',
    status: 'escalated',
    priority: 'high',
    escalatedAt: new Date(Date.now() - 3 * 3600 * 1000), // 3 hours ago
    slaDueAt: new Date(Date.now() + 21 * 3600 * 1000), // 21 hours remaining
    escalationReason: 'Need faculty verification of the particular solution ansatz when roots of characteristic equation overlap with forcing term.',
  });
  await escalatedDoubt.save();

  // 4. An Error doubt (AI failure state with send to teacher)
  const errorDoubt = new Doubt({
    doubtCode: 'DBT-26-0044-ERR',
    student: student._id,
    studentName: student.name,
    studentEmail: student.email,
    course: 'Engineering',
    branch: 'CSE',
    semester: 1,
    topic: 'Complex Analysis',
    title: 'Residue theorem computation over branch-cut contour',
    language: 'en',
    status: 'error',
    lastErrorMessage: 'The AI model could not reach convergence on the multi-valued complex contour branch cut. For mathematical precision, please escalate to faculty.',
  });
  await errorDoubt.save();

  return { transcribedDoubt, answeredDoubt, escalatedDoubt, errorDoubt };
}

async function run() {
  console.log('Connecting to database...');
  await mongoose.connect(process.env.MONGO_URI);

  const student = await User.findOne({ email: 'student@asmaths.edu' });
  if (!student) {
    throw new Error('Test student not found.');
  }

  // Obtain real login token from backend
  const loginRes = await fetch('http://localhost:5000/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    const testPassword = process.env.TEST_STUDENT_PASSWORD || 'TestPassword123!';
    body: JSON.stringify({ email: 'student@asmaths.edu', password: testPassword }),
  });
  const loginData = await loginRes.json();
  const token = loginData.token;

  const { transcribedDoubt, answeredDoubt, escalatedDoubt, errorDoubt } = await setupTestData(student);

  console.log('Launching Edge browser via puppeteer-core...');
  const browser = await puppeteer.launch({
    executablePath: EDGE_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
  });

  const page = await browser.newPage();

  const userSessionObj = {
    id: student._id.toString(),
    email: student.email,
    name: student.name,
    role: 'student',
    course: 'Engineering',
    branch: 'CSE',
    semester: 'Semester 1',
    authenticatedAt: Date.now(),
    expiresAt: Date.now() + 24 * 3600 * 1000,
    token: token,
  };

  const setupPageSession = async () => {
    await page.goto('http://127.0.0.1:5173/login', { waitUntil: 'networkidle0' });
    await page.evaluate(
      (user, tok) => {
        const serialized = JSON.stringify(user);
        localStorage.setItem('as_maths_active_user_v2', serialized);
        localStorage.setItem('as_maths_auth_token_v2', tok);
        sessionStorage.setItem('as_maths_active_user_v2', serialized);
        sessionStorage.setItem('as_maths_auth_token_v2', tok);
      },
      userSessionObj,
      token
    );
  };

  await setupPageSession();

  // Helper to capture a specific view in both desktop and mobile viewports
  const captureBoth = async (filenameBase, setupAction) => {
    // 1. Desktop (1280x850)
    await page.setViewport({ width: 1280, height: 850 });
    await page.goto('http://127.0.0.1:5173/student/dashboard?tab=doubts', { waitUntil: 'networkidle0' });
    await new Promise((r) => setTimeout(r, 1000));
    if (setupAction) await setupAction();
    await new Promise((r) => setTimeout(r, 800));
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${filenameBase}_desktop.png`), fullPage: true });

    // 2. Mobile (375x800)
    await page.setViewport({ width: 375, height: 800, isMobile: true });
    await page.goto('http://127.0.0.1:5173/student/dashboard?tab=doubts', { waitUntil: 'networkidle0' });
    await new Promise((r) => setTimeout(r, 1000));
    if (setupAction) await setupAction();
    await new Promise((r) => setTimeout(r, 800));
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${filenameBase}_mobile.png`), fullPage: true });
  };

  console.log('--- 1. Capturing Composer View ---');
  await captureBoth('01_composer', async () => {
    await page.evaluate(() => {
      const textarea = document.querySelector('textarea[placeholder*="LaTeX"]');
      if (textarea) {
        textarea.value = 'Evaluate the limit: \\lim_{x \\to 0} \\frac{\\sin(3x)}{\\tan(2x)} + \\int_0^1 x^2 \\sqrt{1 - x}\\,dx';
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
  });

  console.log('--- 2. Capturing Stage 1 Transcription Confirmation Card ---');
  await captureBoth('02_confirmation', async () => {
    await page.waitForSelector('#doubt-tab-my', { visible: true });
    await page.click('#doubt-tab-my');
    await new Promise((r) => setTimeout(r, 600));
    await page.waitForSelector(`#doubt-item-${transcribedDoubt.doubtCode}`, { visible: true });
    await page.click(`#doubt-item-${transcribedDoubt.doubtCode}`);
  });

  console.log('--- 3. Capturing Pedagogical Solution Card with Reasoning & KaTeX ---');
  await captureBoth('03_solution', async () => {
    await page.waitForSelector('#doubt-tab-my', { visible: true });
    await page.click('#doubt-tab-my');
    await new Promise((r) => setTimeout(r, 600));
    await page.waitForSelector(`#doubt-item-${answeredDoubt.doubtCode}`, { visible: true });
    await page.click(`#doubt-item-${answeredDoubt.doubtCode}`);
  });

  console.log('--- 4. Capturing My Doubts List with Status Badges & 24h SLA ---');
  await captureBoth('04_mydoubts', async () => {
    await page.waitForSelector('#doubt-tab-my', { visible: true });
    await page.click('#doubt-tab-my');
  });

  console.log('--- 5. Capturing Quota Exceeded State with Send-to-Teacher ---');
  // Set student usage count to 5 (quota exhausted)
  const todayStr = new Date().toISOString().split('T')[0];
  await mongoose.models.StudentDailyQuota.findOneAndUpdate(
    { studentId: student._id.toString(), date: todayStr },
    { $set: { count: 5 } },
    { upsert: true }
  );

  await captureBoth('05_quota_exceeded', async () => {
    // Quota banner renders automatically on load
  });

  console.log('--- 6. Capturing AI-Failure State with Send-to-Teacher ---');
  // Reset quota to 1 so student has normal quota again
  await mongoose.models.StudentDailyQuota.findOneAndUpdate(
    { studentId: student._id.toString(), date: todayStr },
    { $set: { count: 1 } },
    { upsert: true }
  );

  await captureBoth('06_aifailure', async () => {
    await page.waitForSelector('#doubt-tab-my', { visible: true });
    await page.click('#doubt-tab-my');
    await new Promise((r) => setTimeout(r, 600));
    await page.waitForSelector(`#doubt-item-${errorDoubt.doubtCode}`, { visible: true });
    await page.click(`#doubt-item-${errorDoubt.doubtCode}`);
  });

  console.log('All screenshots captured successfully!');
  await browser.close();
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('Screenshot script error:', err);
  process.exit(1);
});
