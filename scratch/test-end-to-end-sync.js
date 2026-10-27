// End-to-end trace and verification of Multi-Entry Upload Paths & Student Portal Sync
const assert = require('assert');

// 1. Simulate frontend relevance filtering (from academicDataService.js)
const norm = (str) => {
  if (str === null || str === undefined) return '';
  return String(str).toLowerCase().trim();
};

const isAllOrEmpty = (val) => {
  if (val === null || val === undefined) return true;
  const s = norm(val);
  return s === '' || s === 'all' || s === 'all branches' || s === 'all semesters' || s === 'all classes';
};

const isSameCourse = (c1Raw, c2Raw) => {
  if (isAllOrEmpty(c1Raw) || isAllOrEmpty(c2Raw)) return true;
  const c1 = norm(c1Raw);
  const c2 = norm(c2Raw);
  if (c1 === c2) return true;
  const isEng = (c) => c.includes('eng') || c.includes('btech') || c.includes('b.tech') || c.includes('makaut');
  const isBsc = (c) => c.includes('bsc') || c.includes('b.sc') || c.includes('science');
  const isIcse = (c) => c.includes('icse') || c.includes('isc');
  const isCbse = (c) => (c.includes('cbse') || c.includes('school') || c.includes('ncert')) && !isIcse(c);
  const isJee = (c) => c.includes('jee') || c.includes('iit') || c.includes('mains') || c.includes('advanced');

  if (isEng(c1) && isEng(c2)) return true;
  if (isBsc(c1) && isBsc(c2)) return true;
  if (isIcse(c1) && isIcse(c2)) return true;
  if (isCbse(c1) && isCbse(c2)) return true;
  if (isJee(c1) && isJee(c2)) return true;
  return false;
};

const isSameSubject = (sub1, sub2) => {
  if (!sub1 || !sub2 || isAllOrEmpty(sub1) || isAllOrEmpty(sub2)) return true;
  const n1 = norm(sub1);
  const n2 = norm(sub2);
  if (n1 === n2) return true;
  if (n1 === 'both' || n2 === 'both') return true;
  if (n1.includes('math') && n2.includes('math')) return true;
  return false;
};

const isSameClass = (c1, c2) => {
  if (!c1 || !c2) return false;
  if (isAllOrEmpty(c1) || isAllOrEmpty(c2)) return true;
  const n1 = norm(c1);
  const n2 = norm(c2);
  if (n1 === n2) return true;
  const toNum = (str) => {
    if (/12|xii/i.test(str)) return '12';
    if (/11|xi/i.test(str)) return '11';
    if (/10|x\b/i.test(str)) return '10';
    if (/9|ix/i.test(str)) return '9';
    return str.replace(/[^0-9]/g, '');
  };
  const num1 = toNum(n1);
  const num2 = toNum(n2);
  if (num1 && num2 && num1 === num2) return true;
  return false;
};

const isSameBranch = (b1Raw, b2Raw) => {
  if (isAllOrEmpty(b1Raw) || isAllOrEmpty(b2Raw)) return true;
  const b1 = norm(b1Raw);
  const b2 = norm(b2Raw);
  if (b1 === b2) return true;
  if (b1.includes('common') || b2.includes('common') || b1.includes('all') || b2.includes('all')) return true;
  const isCSE = (b) => b.includes('cse') || b.includes('computer');
  if (isCSE(b1) && isCSE(b2)) return true;
  return false;
};

const isSameSem = (s1, s2) => {
  if (isAllOrEmpty(s1) || isAllOrEmpty(s2)) return true;
  const p1 = parseInt(String(s1).replace(/[^0-9]/g, ''), 10);
  const p2 = parseInt(String(s2).replace(/[^0-9]/g, ''), 10);
  if (!isNaN(p1) && !isNaN(p2)) return p1 === p2;
  return norm(s1) === norm(s2);
};

function filterForStudent(items, course, branch, sem, selectedClass, subject) {
  return items.filter(item => {
    if (!item) return false;
    const effectiveItemCourse = (item.board && /icse/i.test(item.board)) || (item.course && /icse/i.test(item.course)) ? 'icse' :
      item.board || item.course || 
      ((item.classLevel || item.class || item.class_name || item.className) && /class/i.test(String(item.classLevel || item.class || item.class_name || item.className)) ? (item.stream && /icse/i.test(item.stream) ? 'icse' : 'cbse') : 
      (item.stream && /icse/i.test(item.stream) ? 'icse' : (item.stream && /cbse/i.test(item.stream) ? 'cbse' : (item.stream && /btech|cse|ece|ee|me|ce|it|general|science|bsc/i.test(item.stream) ? (item.stream.includes('bsc') ? 'bsc' : 'engineering') : 'engineering'))));

    const normCourse = norm(course);
    if (normCourse.includes('eng') || normCourse.includes('btech')) {
      if (item.board && (/cbse/i.test(item.board) || /icse/i.test(item.board))) return false;
      if ((item.classLevel || item.class || item.class_name) && /class/i.test(String(item.classLevel || item.class || item.class_name))) return false;
      if (!isSameCourse(effectiveItemCourse, course)) return false;
      const semNum = parseInt(String(sem || item.semester).replace(/[^0-9]/g, ''), 10);
      const isCommon1stYr = (semNum === 1 || semNum === 2) && (
        item.isCommonFirstYear ||
        norm(item.branch).includes('common') ||
        norm(item.branch).includes('all') ||
        norm(item.stream).includes('common')
      );
      if (!isCommon1stYr && !isSameBranch(item.branch || item.stream, branch)) return false;
      if (!isSameSem(item.semester, sem)) return false;
    } else if (normCourse.includes('icse') || normCourse.includes('isc')) {
      if (!isSameCourse(effectiveItemCourse, 'icse')) return false;
      const itemClass = item.classLevel || item.class || item.class_name || item.className || item.classNumber;
      if (itemClass && !isSameClass(itemClass, selectedClass)) return false;
      if (!isSameSubject(item.subject, subject)) return false;
    } else if (normCourse.includes('cbse') || normCourse.includes('school')) {
      if (!isSameCourse(effectiveItemCourse, 'cbse')) return false;
      const itemClass = item.classLevel || item.class || item.class_name || item.className || item.classNumber;
      if (itemClass && !isSameClass(itemClass, selectedClass)) return false;
      if (!isSameSubject(item.subject, subject)) return false;
    }
    return true;
  });
}

// ── Test Cases ──

console.log('--- Starting Multi-Entry Upload & Student Portal Sync Test ---');

// Test Item 1: Uploaded from Global Upload Modal (CBSE Class 9 Math Syllabus)
const item1_cbse_syllabus = {
  id: 'up_001',
  title: 'CBSE Class 9 Real Numbers & Polynomials Syllabus',
  type: 'syllabus',
  course: 'cbse',
  board: 'CBSE',
  branch: null,
  stream: 'CBSE',
  semester: null,
  classLevel: 'Class 9',
  class: 'Class 9',
  class_name: 'Class 9',
  classNumber: 9,
  subject: 'Mathematics',
  academicYear: '2026-2027',
  fileName: 'real_numbers_syllabus.pdf'
};

// Test Item 2: Uploaded from Course Hub (CBSE Class 9 Math Study Material / YouTube)
const item2_cbse_material = {
  id: 'up_002',
  title: 'Coordinate Geometry Video Lecture',
  type: 'materials',
  resourceType: 'youtube',
  videoUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  course: 'cbse',
  board: 'CBSE',
  branch: null,
  stream: 'CBSE',
  semester: null,
  classLevel: 'Class 9',
  class: 'Class 9',
  class_name: 'Class 9',
  classNumber: 9,
  subject: 'Mathematics',
  academicYear: '2026-2027'
};

// Test Item 3: Uploaded from Question Bank (CBSE Class 9 Math PYQ)
const item3_cbse_pyq = {
  id: 'up_003',
  title: 'Triangles Mid-Term PYQ 2025',
  type: 'pyq',
  category: 'pyq',
  isPYQ: true,
  course: 'cbse',
  board: 'CBSE',
  branch: null,
  stream: 'CBSE',
  semester: null,
  classLevel: 'Class 9',
  class: 'Class 9',
  classNumber: 9,
  subject: 'Mathematics',
  academicYear: '2026-2027'
};

// Test Item 4: Uploaded from Class Tests / Online Exam Deployment (CBSE Class 9 Math Online Test)
const item4_cbse_test = {
  id: 'up_004',
  title: 'Linear Equations in Two Variables Class Test',
  type: 'classtest',
  isOnlineTest: true,
  course: 'cbse',
  board: 'CBSE',
  branch: null,
  stream: 'CBSE',
  semester: null,
  classLevel: 'Class 9',
  class: 'Class 9',
  classNumber: 9,
  subject: 'Mathematics',
  academicYear: '2026-2027'
};

// Test Item 5: Uploaded for Engineering CSE Sem 1
const item5_eng_syllabus = {
  id: 'up_005',
  title: 'Engineering Mathematics-1 Calculus Syllabus',
  type: 'syllabus',
  course: 'engineering',
  board: null,
  branch: 'CSE',
  stream: 'CSE',
  semester: 1,
  classLevel: null,
  subject: 'Engineering Mathematics',
  academicYear: '2026-2027'
};

// Test Item 6: Uploaded for ICSE Class 9 Math
const item6_icse_material = {
  id: 'up_006',
  title: 'ICSE Class 9 Pure Arithmetic Guide',
  type: 'materials',
  course: 'icse',
  board: 'ICSE',
  branch: null,
  stream: 'ICSE',
  semester: null,
  classLevel: 'Class 9',
  class: 'Class 9',
  classNumber: 9,
  subject: 'Mathematics',
  academicYear: '2026-2027'
};

const allDatabaseItems = [
  item1_cbse_syllabus,
  item2_cbse_material,
  item3_cbse_pyq,
  item4_cbse_test,
  item5_eng_syllabus,
  item6_icse_material
];

// 1. Verify CBSE Class 9 Mathematics Student Perspective
const cbse9StudentItems = filterForStudent(allDatabaseItems, 'cbse', null, null, 'Class 9', 'Mathematics');
console.log('CBSE Class 9 Student Items Count:', cbse9StudentItems.length);
assert.strictEqual(cbse9StudentItems.length, 4, 'CBSE Class 9 student must receive exactly the 4 CBSE Class 9 items');
assert.ok(cbse9StudentItems.some(i => i.id === 'up_001'), 'Syllabus must be present');
assert.ok(cbse9StudentItems.some(i => i.id === 'up_002'), 'Materials must be present');
assert.ok(cbse9StudentItems.some(i => i.id === 'up_003'), 'PYQ must be present');
assert.ok(cbse9StudentItems.some(i => i.id === 'up_004'), 'Class Test must be present');
assert.ok(!cbse9StudentItems.some(i => i.id === 'up_005'), 'Engineering items must NEVER bleed into CBSE student view');
assert.ok(!cbse9StudentItems.some(i => i.id === 'up_006'), 'ICSE items must NEVER bleed into CBSE student view');
console.log('✅ CBSE Class 9 student portal filtering PASSED with 100% precision.');

// 2. Verify Engineering CSE Semester 1 Student Perspective
const engStudentItems = filterForStudent(allDatabaseItems, 'engineering', 'CSE', 1, null, 'Engineering Mathematics');
console.log('Engineering CSE Sem 1 Student Items Count:', engStudentItems.length);
assert.strictEqual(engStudentItems.length, 1, 'Engineering student must receive exactly the 1 engineering item');
assert.strictEqual(engStudentItems[0].id, 'up_005');
console.log('✅ Engineering student portal filtering PASSED (Zero CBSE/ICSE contamination).');

// 3. Verify ICSE Class 9 Student Perspective
const icseStudentItems = filterForStudent(allDatabaseItems, 'icse', null, null, 'Class 9', 'Mathematics');
console.log('ICSE Class 9 Student Items Count:', icseStudentItems.length);
assert.strictEqual(icseStudentItems.length, 1, 'ICSE student must receive exactly the 1 ICSE item');
assert.strictEqual(icseStudentItems[0].id, 'up_006');
console.log('✅ ICSE Class 9 student portal filtering PASSED (Zero CBSE/Engineering contamination).');

// 4. Verify CBSE Class 10 Student Perspective (Class isolation)
const cbse10StudentItems = filterForStudent(allDatabaseItems, 'cbse', null, null, 'Class 10', 'Mathematics');
console.log('CBSE Class 10 Student Items Count:', cbse10StudentItems.length);
assert.strictEqual(cbse10StudentItems.length, 0, 'CBSE Class 10 student must NOT see Class 9 items');
console.log('✅ Class level boundary isolation PASSED.');

console.log('\n🌟 ALL END-TO-END VERIFICATION CHECKS PASSED SUCCESSFULLY! 🌟');
