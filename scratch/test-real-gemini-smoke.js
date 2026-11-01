const fs = require('fs');
const path = require('path');
const { PDFDocument, rgb } = require(path.resolve(__dirname, '../backend/node_modules/pdf-lib'));

const API_BASE = 'https://asmathse-backend-3.onrender.com/api';

async function runRealGeminiSmokeTest() {
  console.log('🚀 [SMOKE TEST 1]: Testing Real PDF Generation & Live Gemini Multimodal Extraction...');

  // 1. Create a clean 1-page Math Question Paper PDF
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([595.28, 841.89]);
  
  const textContent = 
`AS MATHS EDUCATOR — MATHEMATICS EVALUATION PAPER
Course: Engineering Mathematics | Max Marks: 25

Q1(a). [5 Marks]
Evaluate the definite integral:
\\int_{0}^{\\pi/2} \\frac{\\sqrt{\\sin x}}{\\sqrt{\\sin x} + \\sqrt{\\cos x}} dx

Q1(b). [2 Marks]
If A is an invertible matrix such that A^2 - 4A - 5I = 0, find A^{-1}.

Q2. [10 Marks]
Find the eigenvalues and corresponding eigenvectors of the matrix:
A = \\begin{pmatrix} 3 & 1 \\\\ 1 & 3 \\end{pmatrix}
`;

  page.drawText(textContent, { x: 50, y: 750, size: 12, lineHeight: 18 });
  const pdfBytes = await pdfDoc.save();
  const base64Pdf = Buffer.from(pdfBytes).toString('base64');
  const fileDataUrl = `data:application/pdf;base64,${base64Pdf}`;

  console.log(`📄 Generated test PDF (${pdfBytes.length} bytes, base64: ${base64Pdf.length} chars).`);

  // 2. Stage temporary test document
  console.log('📤 Staging temporary document on backend...');
  const stagingPayload = {
    title: `Smoke Test Staging — ${Date.now()}`,
    type: 'import_staging',
    course: 'engineering',
    branch: 'CSE',
    semester: 1,
    subject: 'Mathematics',
    fileName: 'math_smoke_test.pdf',
    fileDataUrl: fileDataUrl,
  };

  const stageRes = await fetch(`${API_BASE}/content`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(stagingPayload),
  });

  if (!stageRes.ok) {
    const errText = await stageRes.text();
    throw new Error(`Staging failed (${stageRes.status}): ${errText}`);
  }

  const stagedItem = await stageRes.json();
  const testId = stagedItem.id || stagedItem._id;
  console.log(`✅ Staged item created with ID: ${testId}`);

  try {
    // 3. Trigger live streaming Gemini Vision extraction
    console.log(`🧠 Triggering Gemini Vision extraction on ${API_BASE}/content/${testId}/generate-answer-key-stream...`);
    const streamRes = await fetch(`${API_BASE}/content/${testId}/generate-answer-key-stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream'
      },
      body: JSON.stringify({
        fileDataUrl,
        customPrompt: 'Extract all questions Q1(a), Q1(b), Q2 with precise LaTeX notation and step-by-step derivations.'
      })
    });

    console.log(`Stream response status: ${streamRes.status}`);

    if (!streamRes.ok) {
      const errText = await streamRes.text();
      console.warn(`Stream endpoint returned status ${streamRes.status}: ${errText}. Attempting batch fallback...`);
      
      const batchRes = await fetch(`${API_BASE}/content/${testId}/generate-answer-key`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileDataUrl })
      });
      console.log(`Batch response status: ${batchRes.status}`);
      const batchData = await batchRes.json();
      console.log('Batch result:', JSON.stringify(batchData, null, 2));
      return batchData;
    }

    // Read SSE stream
    const reader = streamRes.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    const receivedQuestions = [];
    let completePayload = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split('\n\n');
      buffer = blocks.pop() || '';

      for (const block of blocks) {
        if (!block.trim()) continue;
        const lines = block.split('\n');
        let eventType = 'message';
        let dataStr = '';

        for (const line of lines) {
          if (line.startsWith('event:')) {
            eventType = line.replace(/^event:\s*/, '').trim();
          } else if (line.startsWith('data:')) {
            dataStr += line.replace(/^data:\s*/, '');
          }
        }

        if (dataStr) {
          try {
            const dataObj = JSON.parse(dataStr);
            if (eventType === 'status') {
              console.log(`  [STATUS] ${dataObj.percent || ''}% — ${dataObj.message}`);
            } else if (eventType === 'question') {
              console.log(`  [QUESTION EXTRACTED] Q${dataObj.question?.q_no || '?'}: ${dataObj.question?.problem_statement_latex?.substring(0, 60)}... (${dataObj.question?.max_marks} Marks)`);
              receivedQuestions.push(dataObj.question || dataObj);
            } else if (eventType === 'complete') {
              console.log('  [COMPLETE] Stream concluded successfully!');
              completePayload = dataObj.answerKey || dataObj;
            } else if (eventType === 'error') {
              console.error('  [ERROR] Stream error event:', dataObj.message);
            }
          } catch (pe) {
            // raw text chunk
          }
        }
      }
    }

    console.log(`\n🎉 Total Questions Extracted: ${receivedQuestions.length}`);
    receivedQuestions.forEach((q, idx) => {
      console.log(`--- Question ${idx + 1} ---`);
      console.log(`  No: ${q.q_no}`);
      console.log(`  Marks: ${q.max_marks}`);
      console.log(`  Problem: ${q.problem_statement_latex}`);
      console.log(`  Final Answer: ${q.final_answer_latex}`);
    });

    return { receivedQuestions, completePayload };
  } finally {
    // Clean up staging item
    console.log(`🧹 Cleaning up staging document ${testId}...`);
    await fetch(`${API_BASE}/content/${testId}`, { method: 'DELETE' });
    console.log('✅ Staging document deleted.');
  }
}

runRealGeminiSmokeTest()
  .then(res => {
    console.log('\n🏁 Real Gemini Smoke Test Completed Successfully.');
    process.exit(0);
  })
  .catch(err => {
    console.error('\n💥 Real Gemini Smoke Test Error:', err.message);
    process.exit(1);
  });
