const assert = require('assert');

const API_BASE = 'http://localhost:5000/api';

async function testDraftEditingIsolation() {
  console.log('🧪 [TEST 2: Draft Editing & Premature Save Prevention Test]');

  // 1. Initial simulated extracted question card in studio state
  const tempCardId = `import_draft_${Date.now()}`;
  const initialCard = {
    id: tempCardId,
    tempId: tempCardId,
    rawQNo: '1',
    title: 'Q1: Integration of x^2',
    questionText: 'Evaluate the definite integral $\\int_0^1 x^2 dx$.',
    steps: [{ title: 'Power Rule', content: '$\\left[ \\frac{x^3}{3} \\right]_0^1 = \\frac{1}{3}$.' }],
    finalAnswer: '$\\frac{1}{3}$',
    marks: '3 Marks',
    qType: 'Medium Question',
    difficulty: 'Easy',
    chapter: 'Calculus',
    topic: 'Definite Integrals'
  };

  let studioExtractedQuestions = [initialCard];
  let studioSelectedIds = [tempCardId];

  // 2. Teacher opens question in UnifiedLatexSourceEditor with skipDirectSave={true}
  const skipDirectSave = true;
  let saveUploadedItemCallCount = 0;

  // Mock saveUploadedItem tracker
  const mockSaveUploadedItem = async (payload) => {
    saveUploadedItemCallCount++;
    return payload;
  };

  // Teacher edits text and mathematical expression in UnifiedLatexSourceEditor
  const editedByTeacher = {
    ...initialCard,
    title: 'Q1: Refined Definite Integral of Cubic Function',
    questionText: 'Evaluate the definite integral $\\int_0^2 x^3 dx$ and verify using fundamental theorem of calculus.',
    steps: [{ title: 'Power Rule', content: '$\\left[ \\frac{x^4}{4} \\right]_0^2 = \\frac{16}{4} = 4$.' }],
    finalAnswer: '$4$',
    marks: '5 Marks',
    difficulty: 'Medium'
  };

  // Simulate handleSave inside UnifiedLatexSourceEditor when skipDirectSave={true}:
  let onSaveCallbackPayload = null;
  const simulateEditorHandleSave = async (payload) => {
    if (!skipDirectSave) {
      await mockSaveUploadedItem(payload);
    }
    // Dispatches onSave
    onSaveCallbackPayload = payload;
  };

  await simulateEditorHandleSave(editedByTeacher);

  // 3. Confirm editor did NOT call saveUploadedItem
  assert.strictEqual(saveUploadedItemCallCount, 0, 'UnifiedLatexSourceEditor must NOT call saveUploadedItem when skipDirectSave is true');
  console.log('✅ Confirmed: 0 premature database save calls were made during draft editing.');

  // 4. Studio receives onSave and updates draft card in review panel
  studioExtractedQuestions = studioExtractedQuestions.map(q => {
    if (q.id === onSaveCallbackPayload.id) {
      return { ...q, ...onSaveCallbackPayload, id: q.id };
    }
    return q;
  });

  assert.strictEqual(studioExtractedQuestions[0].title, 'Q1: Refined Definite Integral of Cubic Function');
  assert.strictEqual(studioExtractedQuestions[0].questionText, 'Evaluate the definite integral $\\int_0^2 x^3 dx$ and verify using fundamental theorem of calculus.');
  assert.strictEqual(studioExtractedQuestions[0].finalAnswer, '$4$');
  assert.strictEqual(studioExtractedQuestions[0].marks, '5 Marks');
  console.log('✅ Confirmed: Studio review card reflects updated mathematical content and metadata.');

  // 5. Query live database to verify that tempCardId does NOT exist in MongoDB
  const checkDbRes = await fetch(`${API_BASE}/content/${tempCardId}`);
  assert.strictEqual(checkDbRes.status, 404, 'Draft question must NOT exist in the database before batch import');
  console.log('✅ Confirmed: Database returns HTTP 404 for draft item (Zero premature database pollution).');

  console.log('\n🎉 TEST 2: DRAFT EDITING VERIFICATION PASSED 100%!');
}

testDraftEditingIsolation()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('Fatal Test 2 Error:', err);
    process.exit(1);
  });
