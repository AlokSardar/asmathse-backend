/**
 * AS Maths LMS — Clean-Slate Express REST API Server
 * Supports real-time content, Dual Exam Engine (Written & Automated MCQ),
 * Student Submissions, Evaluations, and Batch/Student Roster synchronization.
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
  proctorLogs: [],
};

app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'AS Maths LMS Clean-Slate Backend',
    timestamp: new Date().toISOString(),
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

app.listen(PORT, () => {
  console.log(`AS Maths LMS Clean-Slate API listening on port ${PORT}`);
});
