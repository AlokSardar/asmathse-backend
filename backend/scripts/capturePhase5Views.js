const puppeteer = require('puppeteer-core');
const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const User = require('../models/User');
const Doubt = require('../models/Doubt');
const DoubtFaq = require('../models/DoubtFaq');

const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const SCREENSHOT_DIR = path.resolve('C:\\Users\\User\\.gemini\\antigravity\\brain\\25b12a71-a1f6-44d1-b276-f07028d4b8af\\screenshots');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!fs.existsSync(SCREENSHOT_DIR)) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

async function captureViews() {
  console.log('Connecting to MongoDB Atlas to ensure test data...');
  await mongoose.connect(process.env.MONGO_URI);

  const teacher = await User.findOne({ email: 'mukherjee.eng@asmaths.edu' });
  const student = await User.findOne({ email: 'student@asmaths.edu' });
  const admin = await User.findOne({ email: 'admin@asmaths.com' });

  // Ensure an FAQ exists
  let faq = await DoubtFaq.findOne({ topic: 'Calculus Limits' });
  if (!faq) {
    faq = await DoubtFaq.create({
      title: 'How to evaluate limit of (sin x)/x as x approaches 0?',
      topic: 'Calculus Limits',
      chapter: 'Unit 1: Limits & Continuity',
      course: 'engineering',
      branch: 'CSE',
      semester: 1,
      solutionPlain: 'Apply L\'Hopital\'s rule since direct substitution gives 0/0 form. Differentiating numerator gives cos(x) and denominator gives 1. Evaluated at x=0, cos(0)/1 = 1.',
      solutionLatex: '\\lim_{x \\to 0} \\frac{\\sin x}{x} = 1',
      verifiedByTeacherName: 'Prof. S. Mukherjee',
      helpfulCount: 5,
    });
  }

  // Ensure a resolved doubt exists with rating
  let solvedDoubt = await Doubt.findOne({ course: 'engineering', status: 'resolved' });
  if (!solvedDoubt) {
    solvedDoubt = await Doubt.create({
      doubtCode: 'DBT-26-0099-FAQ',
      title: 'Find the derivative of f(x) = x * ln(x)',
      course: 'engineering',
      branch: 'CSE',
      semester: 1,
      subject: 'Mathematics',
      topic: 'Differential Calculus',
      student: student._id,
      studentName: student.name,
      studentEmail: student.email,
      status: 'resolved',
      resolvedAt: new Date(),
      aiExplanation: {
        summary: 'Apply Product Rule: (u*v)\' = u\'*v + u*v\'. Here u = x and v = ln(x).',
        finalAnswer: 'f\'(x) = \\ln(x) + 1',
        conceptsUsed: ['Product Rule of Differentiation', 'Derivative of Natural Logarithm'],
        steps: [
          { stepNumber: 1, title: 'Identify functions', explanation: 'Let u(x) = x and v(x) = ln(x)', math: 'u\' = 1, \\quad v\' = \\frac{1}{x}' },
          { stepNumber: 2, title: 'Apply Product Rule', explanation: 'Multiply and combine terms', math: 'f\'(x) = (1)\\ln(x) + x\\left(\\frac{1}{x}\\right) = \\ln(x) + 1' },
        ],
      },
      studentRating: {
        score: 5,
        feedback: 'helpful',
        ratedAt: new Date(),
      },
    });
  }

  console.log('Launching browser via Edge...');
  const browser = await puppeteer.launch({
    executablePath: EDGE_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--window-size=1280,800'],
  });

  const page = await browser.newPage();

  // Helper login function
  async function loginAs(email, password, role) {
    await page.goto('http://localhost:5173/login', { waitUntil: 'networkidle2' });
    await page.waitForSelector('input[type="email"]');
    await page.evaluate(() => {
      document.querySelector('input[type="email"]').value = '';
      document.querySelector('input[type="password"]').value = '';
    });
    await page.type('input[type="email"]', email);
    await page.type('input[type="password"]', password);
    await page.click('button[type="submit"]');
    await sleep(2000);
    const targetUrl = role === 'student' ? 'http://localhost:5173/student/dashboard' : 'http://localhost:5173/admin/dashboard';
    await page.goto(targetUrl, { waitUntil: 'networkidle2' });
    await sleep(1500);
  }

  // 1. TEACHER / ADMIN VIEWS: Analytics Dashboard & FAQ Library
  console.log('\n[Capture 1]: Logging in as Master Admin to capture full Analytics...');
  await loginAs('admin@asmaths.com', 'AdminPassword123!', 'admin');

  // Navigate to Doubts Escalator
  await page.evaluate(() => {
    // Find Doubts Escalator navigation link/button
    const buttons = Array.from(document.querySelectorAll('button, a'));
    const btn = buttons.find((b) => b.textContent && b.textContent.includes('Doubts Escalator'));
    if (btn) btn.click();
  });
  await sleep(1500);

  // Click "Analytics & Insights" Tab
  await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const btn = buttons.find((b) => b.textContent && b.textContent.includes('Analytics & Insights'));
    if (btn) btn.click();
  });
  await sleep(2000);

  // Desktop Analytics Screenshot (1280x800)
  await page.setViewport({ width: 1280, height: 850 });
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'phase5_01_analytics_desktop.png'), fullPage: false });
  console.log('📸 Saved phase5_01_analytics_desktop.png');

  // Mobile Analytics Screenshots
  await page.setViewport({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'phase5_01_analytics_mobile_390.png'), fullPage: false });
  console.log('📸 Saved phase5_01_analytics_mobile_390.png');

  await page.setViewport({ width: 360, height: 780 });
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'phase5_01_analytics_mobile_360.png'), fullPage: false });
  console.log('📸 Saved phase5_01_analytics_mobile_360.png');

  await page.setViewport({ width: 768, height: 1024 });
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'phase5_01_analytics_tablet_768.png'), fullPage: false });
  console.log('📸 Saved phase5_01_analytics_tablet_768.png');

  // Click "FAQ Library" Tab
  await page.setViewport({ width: 1280, height: 800 });
  await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const btn = buttons.find((b) => b.textContent && b.textContent.includes('FAQ Library'));
    if (btn) btn.click();
  });
  await sleep(1500);

  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'phase5_02_faq_library_desktop.png'), fullPage: false });
  console.log('📸 Saved phase5_02_faq_library_desktop.png');

  await page.setViewport({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'phase5_02_faq_library_mobile.png'), fullPage: false });
  console.log('📸 Saved phase5_02_faq_library_mobile.png');

  // 2. STUDENT VIEWS: Similar Doubts Search & Rating View
  console.log('\n[Capture 2]: Logging in as Student to capture Composer Search & Solution Rating...');
  await loginAs('student@asmaths.edu', 'TestPassword123!', 'student');

  // Navigate to Doubts / Ask Doubt
  await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button, a'));
    const btn = buttons.find((b) => b.textContent && (b.textContent.includes('Doubts') || b.textContent.includes('Ask AI')));
    if (btn) btn.click();
  });
  await sleep(1500);

  // Type in Similar Search Box
  await page.setViewport({ width: 1280, height: 800 });
  await page.evaluate(() => {
    const input = document.querySelector('input[placeholder*="Search verified solutions"]');
    if (input) {
      input.value = 'limit';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
  await sleep(1000);
  await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const btn = buttons.find((b) => b.textContent && b.textContent.includes('Search') && b.closest('.bg-slate-50'));
    if (btn) btn.click();
  });
  await sleep(1500);

  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'phase5_03_student_similar_search_desktop.png'), fullPage: false });
  console.log('📸 Saved phase5_03_student_similar_search_desktop.png');

  await page.setViewport({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'phase5_03_student_similar_search_mobile.png'), fullPage: false });
  console.log('📸 Saved phase5_03_student_similar_search_mobile.png');

  // View Solved Doubt Solution with Rating Bar
  await page.setViewport({ width: 1280, height: 800 });
  await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const tab = buttons.find((b) => b.textContent && b.textContent.includes('My Doubts'));
    if (tab) tab.click();
  });
  await sleep(1500);

  // Click first resolved doubt
  await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button, div'));
    const item = buttons.find((b) => b.textContent && b.textContent.includes('View'));
    if (item) item.click();
  });
  await sleep(1500);

  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'phase5_04_student_rating_view_desktop.png'), fullPage: false });
  console.log('📸 Saved phase5_04_student_rating_view_desktop.png');

  await page.setViewport({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'phase5_04_student_rating_view_mobile.png'), fullPage: false });
  console.log('📸 Saved phase5_04_student_rating_view_mobile.png');

  await browser.close();
  await mongoose.disconnect();
  console.log('\n🎉 ALL PHASE 5 SCREENSHOTS CAPTURED SUCCESSFULLY!');
}

captureViews().catch((err) => {
  console.error('Screenshot capture failed:', err);
  process.exit(1);
});
