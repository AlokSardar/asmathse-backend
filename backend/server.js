/**
 * AS Maths LMS — Clean-Slate Express REST API Server
 * Supports real-time content, Dual Exam Engine (Written & Automated MCQ),
 * Student Submissions, Evaluations, Authentication, and Batch/Student Roster synchronization.
 * Enforces strict JSON-only responses (including 404 and 500 handlers) so clients never receive HTML error pages.
 */

const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json({ limit: '25mb' }));

// In-memory store for lightweight local + cloud runtime
const db = {
  uploadedItems: [],
  evaluations: [],
  batches: [],
  students: [],
  doubts: [],
  proctorLogs: [],
};

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'AS Maths LMS Clean-Slate Backend',
    timestamp: new Date().toISOString(),
  });
});

app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'AS Maths LMS Clean-Slate Backend',
    timestamp: new Date().toISOString(),
  });
});

// Authentication endpoints (always return application/json)
const handleLogin = (req, res) => {
  const { email = '', role = 'student', name } = req.body || {};
  const cleanEmail = String(email).trim();
  if (!cleanEmail) {
    return res.status(400).json({
      success: false,
      message: 'Please provide a valid email address to sign in.',
    });
  }
  const effectiveRole =
    role || (cleanEmail.toLowerCase().includes('alok') || cleanEmail.toLowerCase().includes('admin') ? 'admin' : 'student');
  return res.json({
    success: true,
    user: {
      id: effectiveRole === 'admin' ? 'ADM-01' : `STU-${Date.now()}`,
      name: name || (effectiveRole === 'admin' ? 'Prof. Alok Sardar' : 'Aarav Sharma'),
      email: cleanEmail,
      role: effectiveRole,
      course: 'Engineering',
      branch: 'CSE',
      semester: 'Semester 1',
    },
    token: `asmaths_jwt_${Date.now()}`,
  });
};

app.post('/api/auth/login', handleLogin);
app.post('/api/auth/admin/login', handleLogin);
app.post('/api/auth/student/login', handleLogin);

app.post('/api/auth/register', (req, res) => {
  const body = req.body || {};
  if (!body.email || !body.name) {
    return res.status(400).json({
      success: false,
      message: 'Full name and email address are required for registration.',
    });
  }
  const student = {
    id: body.id || `STU-${Date.now()}`,
    status: 'Active',
    feeStatus: 'Paid',
    createdAt: new Date().toISOString(),
    ...body,
  };
  db.students.unshift(student);
  return res.status(201).json({
    success: true,
    user: { ...student, role: 'student' },
    token: `asmaths_jwt_${Date.now()}`,
  });
});

app.get('/api/content', (_req, res) => {
  res.json({ success: true, items: db.uploadedItems });
});

app.post('/api/content', (req, res) => {
  const item = {
    id: req.body.id || `ITEM-${Date.now()}`,
    createdAt: new Date().toISOString(),
    ...req.body,
  };
  const idx = db.uploadedItems.findIndex((i) => i.id === item.id);
  if (idx >= 0) {
    db.uploadedItems[idx] = { ...db.uploadedItems[idx], ...item };
  } else {
    db.uploadedItems.unshift(item);
  }
  res.status(201).json({ success: true, item });
});

app.delete('/api/content/:id', (req, res) => {
  db.uploadedItems = db.uploadedItems.filter((i) => i.id !== req.params.id);
  res.json({ success: true });
});

app.post('/api/content/bulk-delete', (req, res) => {
  const idSet = new Set(Array.isArray(req.body?.ids) ? req.body.ids : []);
  db.uploadedItems = db.uploadedItems.filter((i) => !idSet.has(i.id));
  res.json({ success: true });
});

app.get('/api/evaluations', (_req, res) => {
  res.json({ success: true, evaluations: db.evaluations });
});

app.post('/api/evaluations', (req, res) => {
  const record = {
    id: req.body.id || `SUB-${Date.now()}`,
    submittedAt: req.body.submittedAt || new Date().toISOString(),
    ...req.body,
  };
  const idx = db.evaluations.findIndex((e) => e.id === record.id);
  if (idx >= 0) {
    db.evaluations[idx] = { ...db.evaluations[idx], ...record };
  } else {
    db.evaluations.unshift(record);
  }
  res.status(201).json({ success: true, evaluation: record });
});

app.delete('/api/evaluations/:id', (req, res) => {
  db.evaluations = db.evaluations.filter((e) => e.id !== req.params.id);
  res.json({ success: true });
});

app.post('/api/evaluations/batch-delete', (req, res) => {
  const idSet = new Set(Array.isArray(req.body?.ids) ? req.body.ids : []);
  db.evaluations = db.evaluations.filter((e) => !idSet.has(e.id));
  res.json({ success: true });
});

app.get('/api/batches', (_req, res) => {
  res.json({ success: true, batches: db.batches });
});

app.post('/api/batches', (req, res) => {
  const batch = { id: req.body.id || `BATCH-${Date.now()}`, ...req.body };
  const idx = db.batches.findIndex((b) => b.id === batch.id);
  if (idx >= 0) db.batches[idx] = { ...db.batches[idx], ...batch };
  else db.batches.unshift(batch);
  res.status(201).json({ success: true, batch });
});

app.get('/api/students', (_req, res) => {
  res.json({ success: true, students: db.students });
});

app.post('/api/students', (req, res) => {
  const student = { id: req.body.id || `STU-${Date.now()}`, ...req.body };
  const idx = db.students.findIndex((s) => s.id === student.id);
  if (idx >= 0) db.students[idx] = { ...db.students[idx], ...student };
  else db.students.unshift(student);
  res.status(201).json({ success: true, student });
});

// JSON 404 Catch-All Handler (Never returns HTML "Cannot GET/POST ...")
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `API endpoint not found: ${req.method} ${req.originalUrl}`,
  });
});

// JSON 500 Global Error Middleware (Never returns HTML stack traces)
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('[AS Maths LMS Backend Error]:', err.message);
  res.status(err.status || 500).json({
    success: false,
    message: err.message || 'Internal server error occurred.',
  });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`AS Maths LMS Clean-Slate API listening on port ${PORT}`);
  });
}

module.exports = app;
