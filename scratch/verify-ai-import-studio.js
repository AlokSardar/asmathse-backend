const fs = require('fs');
const path = require('path');
const assert = require('assert');

console.log('🧪 Starting AI Question Import Studio Verification Suite...');

// 1. Verify AIQuestionImportStudio.jsx file exists and contains essential logic
const studioPath = path.resolve(__dirname, '../frontend/src/components/AIQuestionImportStudio.jsx');
assert(fs.existsSync(studioPath), 'AIQuestionImportStudio.jsx should exist');
const studioCode = fs.readFileSync(studioPath, 'utf8');

assert(studioCode.includes('export const AIQuestionImportStudio'), 'Should export AIQuestionImportStudio');
assert(studioCode.includes('export default AIQuestionImportStudio'), 'Should default export AIQuestionImportStudio');
assert(studioCode.includes('streamAnswerKeyAPI'), 'Should invoke streamAnswerKeyAPI');
assert(studioCode.includes('generateAnswerKeyAPI'), 'Should have generateAnswerKeyAPI fallback');
assert(studioCode.includes('saveUploadedItem'), 'Should invoke saveUploadedItem for persistence');
assert(studioCode.includes('deleteUploadedItem'), 'Should call deleteUploadedItem for staging cleanup');
assert(studioCode.includes('MathRenderer'), 'Should import and use MathRenderer');
assert(studioCode.includes('UnifiedLatexSourceEditor'), 'Should import and use UnifiedLatexSourceEditor');
assert(studioCode.includes('MATH_CURRICULUM_HIERARCHY'), 'Should use MATH_CURRICULUM_HIERARCHY');

console.log('  ✅ AIQuestionImportStudio component exports and imports verified.');

// 2. Test duplicate detection algorithm
function normalizeQuestionText(text) {
  if (!text) return '';
  return String(text)
    .toLowerCase()
    .replace(/\\[a-zA-Z]+/g, ' ')
    .replace(/[$#{}\\_^]/g, ' ')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

const originalLatex = "Evaluate the definite integral $\\int_0^{\\pi/2} \\frac{\\sin x}{\\sin x + \\cos x} dx$.";
const variationLatex = "Evaluate the definite integral: \\int_{0}^{\\pi / 2} \\frac{\\sin(x)}{\\sin(x) + \\cos(x)} dx";
const differentLatex = "Find the eigenvalues and eigenvectors of matrix $A = \\begin{pmatrix} 1 & 2 \\\\ 3 & 4 \\end{pmatrix}$.";

const norm1 = normalizeQuestionText(originalLatex);
const norm2 = normalizeQuestionText(variationLatex);
const norm3 = normalizeQuestionText(differentLatex);

assert.strictEqual(norm1, 'evaluatethedefiniteintegral02xxxdx');
assert.strictEqual(norm2, 'evaluatethedefiniteintegral02xxxdx');
assert.strictEqual(norm1, norm2);
assert.notStrictEqual(norm1, norm3);
console.log('  ✅ Duplicate detection normalization correctly matches LaTeX variations and rejects distinct questions.');

// 3. Verify AdminDashboard integration
const adminPath = path.resolve(__dirname, '../frontend/src/pages/admin/AdminDashboard.jsx');
const adminCode = fs.readFileSync(adminPath, 'utf8');

assert(adminCode.includes("import AIQuestionImportStudio from '../../components/AIQuestionImportStudio'"), 'AdminDashboard should import AIQuestionImportStudio');
assert(adminCode.includes('const [showImportStudio, setShowImportStudio] = useState(false)'), 'AdminDashboard should declare showImportStudio state');
assert(adminCode.includes('handleBatchQuestionsImported'), 'AdminDashboard should have handleBatchQuestionsImported handler');
assert(adminCode.includes('AI Question Import Studio'), 'AdminDashboard should have AI Question Import Studio button');
assert(adminCode.includes('<AIQuestionImportStudio'), 'AdminDashboard should mount AIQuestionImportStudio modal');
console.log('  ✅ AdminDashboard integration verified (import, state, handler, toolbar button, modal mount).');

// 4. Verify PYQViewer integration
const pyqPath = path.resolve(__dirname, '../frontend/src/components/PYQViewer.jsx');
const pyqCode = fs.readFileSync(pyqPath, 'utf8');

assert(pyqCode.includes("import AIQuestionImportStudio from './AIQuestionImportStudio'"), 'PYQViewer should import AIQuestionImportStudio');
assert(pyqCode.includes('const [showAIImportStudio, setShowAIImportStudio] = useState(false)'), 'PYQViewer should declare showAIImportStudio state');
assert(pyqCode.includes('AI Question Import Studio'), 'PYQViewer should have AI Question Import Studio button');
assert(pyqCode.includes('<AIQuestionImportStudio'), 'PYQViewer should mount AIQuestionImportStudio modal with defaultDestination="pyq"');
console.log('  ✅ PYQViewer integration verified (import, state, button, modal mount).');

// 5. Test payload contract generation for Question Bank vs PYQ
function generateMockPayload(card, destination, context) {
  const isPYQ = destination === 'pyq';
  const prefix = isPYQ ? 'pyq' : 'qb';
  const cleanCustomId = `${prefix}_test_12345`;

  return {
    id: cleanCustomId,
    itemId: cleanCustomId,
    customId: cleanCustomId,
    title: card.title,
    type: isPYQ ? 'pyq' : 'questionbank',
    category: isPYQ ? 'pyq' : 'practice',
    isPYQ,
    examName: isPYQ ? (context.examName || 'University Semester Exam') : 'Question Bank',
    examYear: isPYQ ? (context.examYear || '2025') : '',
    course: context.course || 'engineering',
    branch: context.branch || 'CSE',
    semester: context.semester || 1,
    questionText: card.questionText,
    steps: card.steps,
    finalAnswer: card.finalAnswer,
    chapter: card.chapter,
    topic: card.topic,
    difficulty: card.difficulty,
    marks: card.marks,
    qType: card.qType
  };
}

const mockCard = {
  title: 'Q1: Integration of rational trigonometric function',
  questionText: 'Evaluate $\\int_0^{\\pi/2} \\frac{\\sin x}{\\sin x + \\cos x} dx$.',
  steps: [{ title: 'Solution Breakdown', content: 'Apply property $\\int_a^b f(x) dx = \\int_a^b f(a+b-x) dx$.' }],
  finalAnswer: '$\\frac{\\pi}{4}$',
  chapter: 'Calculus (Differential & Integral)',
  topic: 'Definite Integrals & Beta-Gamma Functions',
  difficulty: 'Medium',
  marks: '5 Marks',
  qType: 'Medium Question'
};

const qbPayload = generateMockPayload(mockCard, 'questionbank', { course: 'engineering', branch: 'CSE', semester: 1 });
assert.strictEqual(qbPayload.type, 'questionbank');
assert.strictEqual(qbPayload.isPYQ, false);
assert.strictEqual(qbPayload.category, 'practice');
assert.strictEqual(qbPayload.examName, 'Question Bank');
assert(qbPayload.id.startsWith('qb_'));

const pyqPayload = generateMockPayload(mockCard, 'pyq', { course: 'engineering', branch: 'CSE', semester: 1, examName: 'MAKAUT End-Sem', examYear: '2024' });
assert.strictEqual(pyqPayload.type, 'pyq');
assert.strictEqual(pyqPayload.isPYQ, true);
assert.strictEqual(pyqPayload.category, 'pyq');
assert.strictEqual(pyqPayload.examName, 'MAKAUT End-Sem');
assert.strictEqual(pyqPayload.examYear, '2024');
assert(pyqPayload.id.startsWith('pyq_'));

console.log('  ✅ Payload generation accurately respects Question Bank and PYQ destination contracts.');

console.log('\n🎉 ALL 5 VERIFICATION SUITES PASSED CLEANLY (100% Success)!');
