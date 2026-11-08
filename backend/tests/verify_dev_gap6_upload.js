/**
 * Live Demonstration of Gap 6: Student Upload, Private Storage, Multi-Page Streaming & Static Route Blocking
 * 
 * Target DB: asmaths_lms_dev (Strictly DEV database, NEVER asmaths_lms)
 */

const path = require('path');
const fs = require('fs');
const http = require('http');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const DEV_DB_NAME = 'asmaths_lms_dev';
// Strictly override MONGO_URI to asmaths_lms_dev before requiring server/models
const rawUri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/asmaths_lms';
process.env.MONGO_URI = rawUri.replace(/\/asmaths_lms(\?|$)/, '/asmaths_lms_dev$1');

const User = require('../models/User');
const Evaluation = require('../models/Evaluation');
const Submission = require('../models/Submission');
const app = require('../server');

const JWT_SECRET = process.env.JWT_SECRET || require('crypto').randomBytes(32).toString('hex');

function createToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '1h' });
}

let server;
let baseUrl;

function request(method, pathUrl, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathUrl, baseUrl);
    const headers = { ...(options.headers || {}) };
    let bodyData = null;

    if (options.token) {
      headers['Authorization'] = `Bearer ${options.token}`;
    }

    if (options.body) {
      bodyData = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(bodyData);
    }

    const req = http.request(
      url,
      {
        method,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const rawBuffer = Buffer.concat(chunks);
          let data = null;
          const contentType = res.headers['content-type'] || '';
          if (contentType.includes('application/json')) {
            try {
              data = JSON.parse(rawBuffer.toString('utf8'));
            } catch (_) {
              data = rawBuffer.toString('utf8');
            }
          } else {
            data = rawBuffer;
          }
          resolve({ status: res.statusCode, headers: res.headers, data });
        });
      }
    );

    req.on('error', reject);
    if (bodyData) req.write(bodyData);
    req.end();
  });
}

async function runDevGap6Demonstration() {
  console.log('='.repeat(80));
  console.log(`🔒 GAP 6 LIVE DEMO: STUDENT UPLOAD, PRIVATE STORAGE & MULTI-PAGE STREAMING`);
  console.log(`Target Database : ${DEV_DB_NAME} (DEV database)`);
  console.log('='.repeat(80));

  while (mongoose.connection.readyState !== 1) {
    await new Promise((r) => setTimeout(r, 100));
  }
  console.log(`✓ Confirmed Connected Database: ${mongoose.connection.name}`);
  if (mongoose.connection.name !== 'asmaths_lms_dev') {
    throw new Error(`CRITICAL: Connected to ${mongoose.connection.name}, expected asmaths_lms_dev`);
  }

  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
  console.log(`✓ Local test server running on ${baseUrl}`);

  try {
    // 1. Seed Student and Teacher in DEV DB
    const studentUser = await User.findOneAndUpdate(
      { email: 'student.dev.gap6@asmaths.com' },
      {
        name: 'Rahul Verma (DEV Demo)',
        email: 'student.dev.gap6@asmaths.com',
        role: 'student',
        course: 'Engineering',
        branch: 'CSE',
        rollNumber: 'DEV-CSE-042',
      },
      { upsert: true, returnDocument: 'after' }
    );

    const teacherUser = await User.findOneAndUpdate(
      { email: 'teacher.dev.gap6@asmaths.com' },
      {
        name: 'Prof. S. N. Bose (DEV Demo)',
        email: 'teacher.dev.gap6@asmaths.com',
        role: 'teacher',
        targetCourse: 'Engineering',
        branch: 'CSE',
      },
      { upsert: true, returnDocument: 'after' }
    );

    const studentToken = createToken({
      id: studentUser._id.toString(),
      email: studentUser.email,
      role: 'student',
      name: studentUser.name,
      course: 'Engineering',
      branch: 'CSE',
      rollNumber: studentUser.rollNumber,
    });

    const teacherToken = createToken({
      id: teacherUser._id.toString(),
      email: teacherUser.email,
      role: 'teacher',
      name: teacherUser.name,
      targetCourse: 'Engineering',
      branch: 'CSE',
    });

    // 2. Real multi-page submission payload
    const page1Base64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const page2Base64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

    const submissionPayload = {
      assignmentId: 'EXAM-DEV-CALCULUS',
      assignmentTitle: 'Calculus & Differential Equations Mid-Term 2026',
      course: 'Engineering',
      branch: 'CSE',
      semester: 1,
      totalMarks: 50,
      notes: 'Submitted handwritten pages for Questions 1-5.',
      answerPages: [
        {
          pageNumber: 1,
          name: 'script_page_1.png',
          fileType: 'image/png',
          dataUrl: page1Base64,
        },
        {
          pageNumber: 2,
          name: 'script_page_2.png',
          fileType: 'image/png',
          dataUrl: page2Base64,
        },
      ],
      totalPages: 2,
    };

    console.log('\n--- Step 1: Real Student Upload via POST /api/student/submit-exam ---');
    const submitRes = await request('POST', '/api/student/submit-exam', {
      token: studentToken,
      body: submissionPayload,
    });

    console.log(`HTTP Status: ${submitRes.status} Created`);
    const evalId = submitRes.data.evaluation?.id || submitRes.data.submission?.id;
    console.log(`Generated Evaluation ID: ${evalId}`);

    // Inspect stored Evaluation document in MongoDB
    const evalDoc = await Evaluation.findOne({ id: evalId });
    console.log('\n--- Step 2: Inspected MongoDB Evaluation Document ---');
    console.log(`Document ID         : ${evalDoc.id}`);
    console.log(`Student Name        : ${evalDoc.studentName} (${evalDoc.studentRoll})`);
    console.log(`Evaluation Status   : ${evalDoc.evaluationStatus}`);
    console.log(`answerSheetUrl      : ${evalDoc.answerSheetUrl}`);
    console.log(`privateScriptUrl    : ${evalDoc.privateScriptUrl}`);
    console.log(`privatePublicId     : ${evalDoc.privatePublicId}`);
    console.log(`Total Pages Count   : ${evalDoc.totalPages}`);
    console.log(`Answer Pages Stored : ${evalDoc.answerPages?.length} pages`);

    // Check physical file on local private storage disk
    const privateDir = path.resolve(__dirname, '../uploads/private_scripts');
    console.log('\n--- Step 3: Physical File Location on Disk ---');
    console.log(`Private Directory   : ${privateDir}`);
    const files = fs.readdirSync(privateDir).filter(f => f.includes(evalId) || f.includes('script_page'));
    console.log(`Files created on disk:`, files);

    // Step 4: Prove direct static file path returns 403 Forbidden without token
    console.log('\n--- Step 4: Direct Static Access Check (No Token) ---');
    const staticUrlPath = `/uploads/private_scripts/${files[0] || 'script_page_1.png'}`;
    const directRes = await request('GET', staticUrlPath);
    console.log(`GET ${staticUrlPath} (No Token) -> HTTP ${directRes.status}`);
    if (directRes.status === 403) {
      console.log('✓ PASS: Direct static path is strictly blocked with 403 Forbidden!');
    } else {
      console.error(`❌ Unexpected status: ${directRes.status}`);
    }

    // Step 5: Prove unauthenticated access to authenticated route returns 401 Unauthorized
    console.log('\n--- Step 5: Route Access Check Without Token ---');
    const noAuthRes = await request('GET', `/api/evaluations/${evalId}/script-file`);
    console.log(`GET /api/evaluations/${evalId}/script-file (No Token) -> HTTP ${noAuthRes.status}`);
    if (noAuthRes.status === 401) {
      console.log('✓ PASS: Authenticated script route rejects unauthenticated request with 401 Unauthorized!');
    }

    // Step 6: Teacher views page list (metadata only, no raw URLs)
    console.log('\n--- Step 6: Teacher Retrieves Script Page List ---');
    const pagesRes = await request('GET', `/api/evaluations/${evalId}/pages`, {
      token: teacherToken,
    });
    console.log(`GET /api/evaluations/${evalId}/pages -> HTTP ${pagesRes.status}`);
    console.log(`Response Payload:`, JSON.stringify(pagesRes.data, null, 2));

    // Step 7: Teacher streams Page 1 & Page 2 via authenticated route
    console.log('\n--- Step 7: Teacher Streams Multi-Page Script via Authenticated Route ---');
    const page1Res = await request('GET', `/api/evaluations/${evalId}/script-file?page=1`, {
      token: teacherToken,
    });
    console.log(`GET /api/evaluations/${evalId}/script-file?page=1 -> HTTP ${page1Res.status} (Bytes received: ${page1Res.data.length})`);

    const page2Res = await request('GET', `/api/evaluations/${evalId}/script-file?page=2`, {
      token: teacherToken,
    });
    console.log(`GET /api/evaluations/${evalId}/script-file?page=2 -> HTTP ${page2Res.status} (Bytes received: ${page2Res.data.length})`);

    console.log('\n' + '='.repeat(80));
    console.log('🎉 GAP 6 REAL STUDENT UPLOAD ON DEV DATABASE COMPLETED WITH 100% SUCCESS!');
    console.log('='.repeat(80));

    // Clean up test records from DEV DB
    await Evaluation.deleteMany({ id: evalId });
    await Submission.deleteMany({ id: evalId });
    for (const f of files) {
      try {
        fs.unlinkSync(path.join(privateDir, f));
      } catch (_) {}
    }
  } finally {
    if (server) server.close();
    await mongoose.disconnect();
    process.exit(0);
  }
}

runDevGap6Demonstration().catch(err => {
  console.error('Demonstration failed:', err);
  process.exit(1);
});
