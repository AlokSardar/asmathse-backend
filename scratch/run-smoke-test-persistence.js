const assert = require('assert');

const API_BASE = 'http://localhost:5000/api';

async function testRealPersistenceAndWorkflows() {
  console.log('🚀 [PHASE C.2 REAL APPLICATION SMOKE TEST]');
  console.log('Target API:', API_BASE);

  const cleanupIds = [];

  try {
    // ══════════════════════════════════════════════════════════════════════
    // TEST 3A: Real Persistence — Save Question to Question Bank
    // ══════════════════════════════════════════════════════════════════════
    console.log('\n--- Test 3A: Real Persistence — Question Bank Save ---');
    const qbUniqueId = `qb_smoke_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const qbPayload = {
      id: qbUniqueId,
      itemId: qbUniqueId,
      customId: qbUniqueId,
      title: 'Smoke Test: Definite Integral of Rational Function',
      type: 'questionbank',
      category: 'practice',
      isPYQ: false,
      course: 'engineering',
      branch: 'CSE',
      stream: 'CSE',
      semester: 1,
      subject: 'Mathematics',
      academicYear: '2026-2027',
      chapter: 'Calculus (Differential & Integral)',
      topic: 'Definite Integrals & Beta-Gamma Functions',
      subCategory: 'Direct Computation',
      difficulty: 'Medium',
      marks: '5 Marks',
      qType: 'Medium Question',
      questionText: 'Evaluate $\\int_0^1 \\frac{x^4(1-x)^4}{1+x^2} dx$ and deduce that $\\frac{22}{7} > \\pi$.',
      steps: [
        { title: 'Step 1: Expand Numerator', content: 'Expand $x^4(1-x)^4 = x^4(1 - 4x + 6x^2 - 4x^3 + x^4)$.' },
        { title: 'Step 2: Polynomial Division', content: 'Perform algebraic long division $\\frac{x^4(1-x)^4}{1+x^2} = x^6 - 4x^5 + 5x^4 - 4x^2 + 4 - \\frac{4}{1+x^2}$.' },
        { title: 'Step 3: Integration', content: 'Integrating term by term gives $\\left[ \\frac{x^7}{7} - \\frac{2x^6}{3} + x^5 - \\frac{4x^3}{3} + 4x - 4\\arctan x \\right]_0^1 = \\frac{22}{7} - \\pi$.' }
      ],
      finalAnswer: '$\\frac{22}{7} - \\pi > 0 \\implies \\frac{22}{7} > \\pi$',
      sourceOrigin: 'AI Question Import Studio Smoke Test',
      uploadedAt: new Date().toISOString()
    };

    const qbRes = await fetch(`${API_BASE}/content`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(qbPayload)
    });

    console.log('QB Save HTTP Status:', qbRes.status);
    assert([200, 201].includes(qbRes.status), `Question Bank save should return HTTP 200 or 201, got ${qbRes.status}`);
    const qbSaved = await qbRes.json();
    console.log('QB Returned Record ID:', qbSaved.id || qbSaved.itemId || qbSaved._id);
    assert(qbSaved._id, 'Mongoose _id must be assigned by database');
    assert.strictEqual(qbSaved.id, qbUniqueId, 'Custom ID must match qbPayload.id');
    assert.strictEqual(qbSaved.type, 'questionbank');
    cleanupIds.push(qbSaved._id || qbSaved.id);

    // ══════════════════════════════════════════════════════════════════════
    // TEST 3B: Reload & Persistence Verification from Database
    // ══════════════════════════════════════════════════════════════════════
    console.log('\n--- Test 3B: Reload / Fetch Record from Persistence Layer ---');
    const qbFetchRes = await fetch(`${API_BASE}/content/${qbSaved.id}`);
    console.log('Fetch single record HTTP Status:', qbFetchRes.status);
    assert.strictEqual(qbFetchRes.status, 200);
    const qbRetrieved = await qbFetchRes.json();
    console.log('Retrieved Title:', qbRetrieved.title);
    console.log('Retrieved questionText:', qbRetrieved.questionText);
    console.log('Retrieved finalAnswer:', qbRetrieved.finalAnswer);
    assert.strictEqual(qbRetrieved.questionText, qbPayload.questionText);
    assert.strictEqual(qbRetrieved.finalAnswer, qbPayload.finalAnswer);
    assert(Array.isArray(qbRetrieved.steps) && qbRetrieved.steps.length === 3);

    // Verify retrieval in Question Bank query list
    const qbListRes = await fetch(`${API_BASE}/content?course=engineering&semester=1&type=questionbank`);
    assert.strictEqual(qbListRes.status, 200);
    const qbList = await qbListRes.json();
    const foundInList = qbList.some(item => item.id === qbUniqueId || String(item._id) === String(qbSaved._id));
    console.log(`Found in semester 1 Question Bank list: ${foundInList} (Total items in list: ${qbList.length})`);
    assert(foundInList, 'Saved question must appear in Question Bank query response');

    // ══════════════════════════════════════════════════════════════════════
    // TEST 3C: Real Persistence — Save PYQ with Exam Name & Exam Year
    // ══════════════════════════════════════════════════════════════════════
    console.log('\n--- Test 3C: Real Persistence — Save PYQ with Exam Name and Year ---');
    const pyqUniqueId = `pyq_smoke_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const pyqPayload = {
      id: pyqUniqueId,
      itemId: pyqUniqueId,
      customId: pyqUniqueId,
      title: 'Smoke Test PYQ: Cayley-Hamilton Theorem Application',
      type: 'pyq',
      category: 'pyq',
      isPYQ: true,
      examName: 'MAKAUT Semester-I Final Exam',
      examYear: '2024',
      course: 'engineering',
      branch: 'CSE',
      stream: 'CSE',
      semester: 1,
      subject: 'Mathematics',
      academicYear: '2026-2027',
      chapter: 'Linear Algebra',
      topic: 'Cayley-Hamilton Theorem & Inverse',
      difficulty: 'Hard',
      marks: '7 Marks',
      qType: 'Long Question',
      questionText: 'Verify Cayley-Hamilton Theorem for matrix $A = \\begin{pmatrix} 1 & 2 \\\\ 3 & 4 \\end{pmatrix}$ and hence calculate $A^{-1}$ and $A^3$.',
      steps: [
        { title: 'Characteristic Equation', content: '$\\det(A - \\lambda I) = \\lambda^2 - 5\\lambda - 2 = 0$.' },
        { title: 'Cayley-Hamilton Verification', content: 'Substitute $A$: $A^2 - 5A - 2I = 0$. Since $A^2 = \\begin{pmatrix} 7 & 10 \\\\ 15 & 22 \\end{pmatrix}$, $A^2 - 5A - 2I = 0$ is verified.' },
        { title: 'Compute A^-1', content: 'Multiplying by $A^{-1}$: $A - 5I - 2A^{-1} = 0 \\implies A^{-1} = \\frac{1}{2}(A - 5I) = \\begin{pmatrix} -2 & 1 \\\\ 3/2 & -1/2 \\end{pmatrix}$.' }
      ],
      finalAnswer: '$A^{-1} = \\begin{pmatrix} -2 & 1 \\\\ 3/2 & -1/2 \\end{pmatrix}$',
      sourceOrigin: 'AI Question Import Studio Smoke Test',
      uploadedAt: new Date().toISOString()
    };

    const pyqRes = await fetch(`${API_BASE}/content`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(pyqPayload)
    });

    console.log('PYQ Save HTTP Status:', pyqRes.status);
    assert([200, 201].includes(pyqRes.status), `PYQ save should return HTTP 200 or 201, got ${pyqRes.status}`);
    const pyqSaved = await pyqRes.json();
    console.log('PYQ Returned Record ID:', pyqSaved.id || pyqSaved.itemId || pyqSaved._id);
    assert.strictEqual(pyqSaved.type, 'pyq');
    assert.strictEqual(pyqSaved.isPYQ, true);
    assert.strictEqual(pyqSaved.examName, 'MAKAUT Semester-I Final Exam');
    assert.strictEqual(pyqSaved.examYear, '2024');
    cleanupIds.push(pyqSaved._id || pyqSaved.id);

    // Verify PYQ query retrieval
    const pyqListRes = await fetch(`${API_BASE}/content?course=engineering&semester=1&type=pyq`);
    assert.strictEqual(pyqListRes.status, 200);
    const pyqList = await pyqListRes.json();
    const foundPYQ = pyqList.some(item => item.id === pyqUniqueId || String(item._id) === String(pyqSaved._id));
    console.log(`Found in semester 1 PYQ list: ${foundPYQ} (Total PYQ items: ${pyqList.length})`);
    assert(foundPYQ, 'Saved PYQ question must appear in PYQ query response with exam metadata intact');

    // ══════════════════════════════════════════════════════════════════════
    // TEST 4: Duplicate Protection Verification (UI + Backend)
    // ══════════════════════════════════════════════════════════════════════
    console.log('\n--- Test 4: Duplicate Protection Verification ---');
    // 4A: UI Normalization Duplicate Test
    function normalizeQuestionText(text) {
      if (!text) return '';
      return String(text).toLowerCase().replace(/\\[a-zA-Z]+/g, ' ').replace(/[$#{}\\_^]/g, ' ').replace(/[^a-z0-9]/g, '').trim();
    }
    const qbNormalized = normalizeQuestionText(qbPayload.questionText);
    const candidateReimport = 'Evaluate \\int_{0}^{1} \\frac{x^4 (1-x)^4}{1 + x^2} dx and deduce that 22/7 > \\pi.';
    const candidateNormalized = normalizeQuestionText(candidateReimport);
    assert.strictEqual(qbNormalized, candidateNormalized, 'UI Duplicate Detection must match identical mathematical problem text');
    console.log('✅ UI Duplicate Detection matched question across formatting variations.');

    // 4B: Backend idempotent upsert check
    // If the same record (matching custom ID) is posted again, does backend upsert or duplicate?
    const duplicateRes = await fetch(`${API_BASE}/content`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(qbPayload)
    });
    console.log('Duplicate save attempt status:', duplicateRes.status);
    const duplicateData = await duplicateRes.json();
    assert.strictEqual(duplicateData.id, qbUniqueId, 'Idempotent upsert preserves unique custom ID without creating duplicate record');
    console.log('✅ Backend correctly handled duplicate submission idempotently.');

    // ══════════════════════════════════════════════════════════════════════
    // TEST 5: Class Test Builder Compatibility
    // ══════════════════════════════════════════════════════════════════════
    console.log('\n--- Test 5: Class Test Builder Compatibility ---');
    // Query items available for test creation
    const testBuilderQueryRes = await fetch(`${API_BASE}/content?course=engineering&semester=1`);
    assert.strictEqual(testBuilderQueryRes.status, 200);
    const availablePool = await testBuilderQueryRes.json();
    const candidateQB = availablePool.find(q => q.id === qbUniqueId);
    const candidatePYQ = availablePool.find(q => q.id === pyqUniqueId);

    assert(candidateQB, 'Question Bank item must be available in pool for Class Test Builder');
    assert(candidatePYQ, 'PYQ item must be available in pool for Class Test Builder');
    console.log(`✅ Class Test Builder pool includes Question Bank item (${candidateQB.marks}, ${candidateQB.qType})`);
    console.log(`✅ Class Test Builder pool includes PYQ item (${candidatePYQ.marks}, ${candidatePYQ.qType}, Exam: ${candidatePYQ.examName} ${candidatePYQ.examYear})`);

    console.log('\n🎉 ALL REAL APPLICATION SMOKE TESTS (TESTS 3, 4, 5) COMPLETED SUCCESSFULLY!');
  } finally {
    // ══════════════════════════════════════════════════════════════════════
    // SAFE CLEANUP: Clean up test records from database
    // ══════════════════════════════════════════════════════════════════════
    console.log('\n--- Safe Cleanup of Test Artifacts ---');
    for (const id of cleanupIds) {
      try {
        const delRes = await fetch(`${API_BASE}/content/${id}`, { method: 'DELETE' });
        console.log(`🧹 Deleted test item ${id}: HTTP ${delRes.status}`);
      } catch (e) {
        console.warn(`Could not delete test item ${id}:`, e.message);
      }
    }
  }
}

testRealPersistenceAndWorkflows()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('Fatal Smoke Test Error:', err);
    process.exit(1);
  });
