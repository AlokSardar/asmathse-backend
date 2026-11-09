/**
 * Enterprise-Grade Tests & Schedule Workspace Controller
 * Provides centralized management, live server-side status computation,
 * calendar feeds, cohort analytics, and safe lifecycle management.
 */

const mongoose = require('mongoose');
const { assertDevOrTestDatabase } = require('../utils/dbGuard');
const {
  formatInIST,
  parseISTToUTC,
  resolveTestTimestamps,
  computeTestStatus,
  hasCohortConflict,
} = require('../utils/scheduleTime');

const ClassTest = require('../models/ClassTest');
const Evaluation = require('../models/Evaluation');
const TestSubmission = require('../models/TestSubmission');
const Student = require('../models/Student');
const User = require('../models/User');
const Notification = require('../models/Notification');
const AuditLog = require('../models/AuditLog');

// Helper: Escape string for regex
function escapeRegex(str) {
  return String(str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Helper: Strip answer keys and solutions from test payload
function sanitizeTestPayload(testObj) {
  if (!testObj) return null;
  const sanitized = { ...testObj };

  delete sanitized.answerKey;
  delete sanitized.solutionSet;
  delete sanitized.correctAnswers;
  delete sanitized.solution;
  delete sanitized.solutions;
  delete sanitized.explanation;

  if (Array.isArray(sanitized.questions)) {
    sanitized.questions = sanitized.questions.map((q) => {
      const qCopy = { ...q };
      delete qCopy.answerKey;
      delete qCopy.solution;
      delete qCopy.solutions;
      delete qCopy.explanation;
      delete qCopy.correctOption;
      delete qCopy.correctAnswer;
      delete qCopy.correctAnswers;
      return qCopy;
    });
  }

  return sanitized;
}

// Helper: Verify teacher course/branch scope access
function checkTeacherAccess(user, test) {
  if (!user || !test) return true;
  const role = String(user.role || '').toLowerCase();
  if (role !== 'teacher' || user.id === 'master_admin_id') {
    return true; // Admin / master admin has full access across all cohorts
  }
  const teacherCourse = user.targetCourse || user.course;
  const teacherBranch = user.branch || user.stream;
  if (teacherCourse && test.course && test.course.toLowerCase() !== teacherCourse.toLowerCase()) {
    return false;
  }
  if (teacherBranch && !teacherBranch.toLowerCase().includes('all') && !test.isCommon && !test.isCommonFirstYear) {
    const testBranch = test.branch || test.stream;
    if (testBranch && !/all|common/i.test(testBranch) && testBranch.toLowerCase() !== teacherBranch.toLowerCase()) {
      return false;
    }
  }
  return true;
}

// Helper: Build teacher/admin role-scoped query
function buildScopedQuery(req, isArchivedOnly = false) {
  const user = req.user;
  const role = String(user?.role || '').toLowerCase();

  const andClauses = isArchivedOnly
    ? [{ isArchived: true }]
    : [{ isArchived: { $ne: true } }];

  if (role === 'teacher' && user?.id !== 'master_admin_id') {
    const teacherCourse = user?.targetCourse || user?.course;
    const teacherBranch = user?.branch || user?.stream;
    if (teacherCourse) {
      andClauses.push({ course: new RegExp(`^${escapeRegex(teacherCourse)}$`, 'i') });
    }
    if (teacherBranch && !teacherBranch.toLowerCase().includes('all')) {
      andClauses.push({
        $or: [
          { branch: new RegExp(`^${escapeRegex(teacherBranch)}$`, 'i') },
          { stream: new RegExp(`^${escapeRegex(teacherBranch)}$`, 'i') },
          { isCommon: true },
          { isCommonFirstYear: true },
        ],
      });
    }
  }

  return { $and: andClauses };
}

// Helper: Apply flexible cohort filtering (handles semester as "Semester 1", "Sem 1", "1", or numeric 1, and tests with isCommon / all branches)
function applyCohortFilter(baseQuery, { course, branch, semester } = {}) {
  const andClauses = [];

  if (baseQuery && typeof baseQuery === 'object') {
    if (Array.isArray(baseQuery.$and)) {
      andClauses.push(...baseQuery.$and);
    } else {
      for (const [k, v] of Object.entries(baseQuery)) {
        if (k !== '$and') andClauses.push({ [k]: v });
      }
    }
  }

  // 1. Course Filter
  if (course && course !== 'All') {
    andClauses.push({ course: new RegExp(`^${escapeRegex(course)}$`, 'i') });
  }

  // 2. Branch Filter: handle specific branch, 'All', or common tests
  if (branch && branch !== 'All') {
    const branchRegex = new RegExp(`^${escapeRegex(branch)}$`, 'i');
    andClauses.push({
      $or: [
        { branch: branchRegex },
        { stream: branchRegex },
        { isCommon: true },
        { isCommonFirstYear: true },
        { branch: /^(all|common)$/i },
        { stream: /^(all|common)$/i },
      ],
    });
  }

  // 3. Semester Filter: handle "Semester 1", "Sem 1", "1", or numeric 1
  if (semester && semester !== 'All') {
    const semStr = String(semester).trim();
    const semNum = parseInt(semStr.replace(/[^0-9]/g, ''), 10);
    const semesterOrConditions = [
      { semester: new RegExp(`^${escapeRegex(semStr)}$`, 'i') },
    ];
    if (!isNaN(semNum)) {
      semesterOrConditions.push({ semester: semNum });
      semesterOrConditions.push({ semester: String(semNum) });
      semesterOrConditions.push({ semester: new RegExp(`(^|\\b)Semester\\s*${semNum}(\\b|$)`, 'i') });
      semesterOrConditions.push({ semester: new RegExp(`(^|\\b)Sem\\s*${semNum}(\\b|$)`, 'i') });
    }
    andClauses.push({ $or: semesterOrConditions });
  }

  return andClauses.length > 0 ? { $and: andClauses } : {};
}

// Helper: Count eligible students in cohort
async function countEligibleStudents(test) {
  try {
    if (Array.isArray(test.targetStudentEmails) && test.targetStudentEmails.length > 0) {
      return test.targetStudentEmails.length;
    }

    const studentFilter = { role: 'student' };
    if (test.course) {
      studentFilter.course = new RegExp(`^${escapeRegex(test.course)}$`, 'i');
    }

    const branch = test.branch || test.stream;
    const isCommon = test.isCommon || (branch && /all/i.test(branch));
    if (!isCommon && branch) {
      studentFilter.branch = new RegExp(`^${escapeRegex(branch)}$`, 'i');
    }

    if (test.semester) {
      const semNum = String(test.semester).replace(/[^0-9]/g, '');
      if (semNum) {
        studentFilter.$or = [
          { semester: new RegExp(`(^|\\b)${semNum}(\\b|$)`, 'i') },
          { semester: test.semester },
        ];
      }
    }

    const count = await User.countDocuments(studentFilter);
    return count > 0 ? count : 30; // Clean fallback for empty local dev cohorts
  } catch (_) {
    return 30;
  }
}

// ============================================================================
// 1. OVERVIEW TAB ENDPOINT
// ============================================================================
exports.getOverview = async (req, res) => {
  try {
    assertDevOrTestDatabase();

    const baseScoped = buildScopedQuery(req);
    const scopedQuery = applyCohortFilter(baseScoped, req.query);

    const tests = await ClassTest.find(scopedQuery).lean();
    const serverNow = new Date();

    let completedCount = 0;
    let ongoingCount = 0;
    let upcomingCount = 0;
    let draftCount = 0;

    const ongoingNow = [];
    const upcomingList = [];

    const testIds = [];

    for (const t of tests) {
      const status = computeTestStatus(t, serverNow);
      const timestamps = resolveTestTimestamps(t);
      const testId = String(t.testId || t.id || t._id);
      if (t._id) testIds.push(String(t._id));
      if (t.id) testIds.push(String(t.id));
      if (t.testId) testIds.push(String(t.testId));

      if (status === 'completed') completedCount++;
      else if (status === 'ongoing') {
        ongoingCount++;
        ongoingNow.push({
          id: testId,
          _id: t._id,
          title: t.title,
          course: t.course,
          branch: t.branch,
          semester: t.semester,
          startAt: timestamps.startAt,
          endAt: timestamps.endAt,
          remainingMs: Math.max(0, timestamps.endAt.getTime() - serverNow.getTime()),
          formattedEndIST: formatInIST(timestamps.endAt),
          durationMinutes: timestamps.durationMinutes,
        });
      } else if (status === 'upcoming') {
        upcomingCount++;
        if (timestamps.startAt) {
          upcomingList.push({
            id: testId,
            _id: t._id,
            title: t.title,
            course: t.course,
            branch: t.branch,
            semester: t.semester,
            startAt: timestamps.startAt,
            endAt: timestamps.endAt,
            countdownMs: Math.max(0, timestamps.startAt.getTime() - serverNow.getTime()),
            formattedStartIST: formatInIST(timestamps.startAt),
            scheduleEstimated: timestamps.scheduleEstimated,
          });
        }
      } else if (status === 'draft') {
        draftCount++;
      }
    }

    // Sort upcoming ascending by startAt
    upcomingList.sort((a, b) => new Date(a.startAt) - new Date(b.startAt));
    const nextUp = upcomingList.slice(0, 5);

    // Query published/autoGraded evaluations for genuine metrics
    const evalQuery = {
      $or: [{ published: true }, { autoGraded: true }],
      $and: [
        {
          $or: [
            { testId: { $in: testIds } },
            { examId: { $in: testIds } },
          ],
        },
      ],
    };

    const evals = await Evaluation.find(evalQuery)
      .select('testId examId marksObtained totalMarks score percentage studentEmail submittedAt')
      .lean();

    const totalAttempts = evals.length;
    let avgScore = 0;

    if (totalAttempts > 0) {
      const totalPct = evals.reduce((sum, ev) => {
        const pct = typeof ev.percentage === 'number'
          ? ev.percentage
          : (ev.marksObtained != null && ev.totalMarks ? (ev.marksObtained / ev.totalMarks) * 100 : 0);
        return sum + pct;
      }, 0);
      avgScore = parseFloat((totalPct / totalAttempts).toFixed(1));
    }

    // Calculate per-test recent results
    const resultsByTest = {};
    for (const ev of evals) {
      const tid = String(ev.testId || ev.examId);
      if (!resultsByTest[tid]) {
        resultsByTest[tid] = { attempts: 0, scores: [] };
      }
      resultsByTest[tid].attempts++;
      const score = typeof ev.percentage === 'number'
        ? ev.percentage
        : (ev.marksObtained != null && ev.totalMarks ? (ev.marksObtained / ev.totalMarks) * 100 : 0);
      resultsByTest[tid].scores.push(score);
    }

    const recentResults = tests
      .filter((t) => {
        const id1 = String(t._id);
        const id2 = t.id ? String(t.id) : null;
        const id3 = t.testId ? String(t.testId) : null;
        return resultsByTest[id1] || (id2 && resultsByTest[id2]) || (id3 && resultsByTest[id3]);
      })
      .slice(0, 5)
      .map((t) => {
        const id1 = String(t._id);
        const id2 = t.id ? String(t.id) : null;
        const id3 = t.testId ? String(t.testId) : null;
        const stats = resultsByTest[id1] || (id2 && resultsByTest[id2]) || (id3 && resultsByTest[id3]);
        const avg = stats.scores.reduce((a, b) => a + b, 0) / stats.scores.length;
        const top = Math.max(...stats.scores);
        return {
          id: id2 || id3 || id1,
          title: t.title,
          attempts: stats.attempts,
          averageScore: parseFloat(avg.toFixed(1)),
          topScore: parseFloat(top.toFixed(1)),
        };
      });

    return res.status(200).json({
      success: true,
      kpis: {
        totalTests: tests.length,
        completed: completedCount,
        ongoing: ongoingCount,
        upcoming: upcomingCount,
        draft: draftCount,
        totalAttempts,
        averageScore: avgScore,
      },
      ongoingNow,
      nextUp,
      recentResults,
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
};

// ============================================================================
// 2. TESTS & EXAMS MASTER LIST ENDPOINT
// ============================================================================
exports.getTestsList = async (req, res) => {
  try {
    assertDevOrTestDatabase();

    const {
      status: requestedStatus,
      type,
      search,
      startDate,
      endDate,
      page = 1,
      limit = 20,
      sortBy = 'startAt',
      sortOrder = 'desc',
    } = req.query;

    const isArchiveRequested = requestedStatus === 'archived';
    const baseScoped = buildScopedQuery(req, isArchiveRequested);
    const scopedQuery = applyCohortFilter(baseScoped, req.query);

    if (search && search.trim()) {
      const sReg = new RegExp(escapeRegex(search.trim()), 'i');
      scopedQuery.$and = scopedQuery.$and || [];
      scopedQuery.$and.push({
        $or: [{ title: sReg }, { subject: sReg }, { topic: sReg }],
      });
    }

    const allScopedTests = await ClassTest.find(scopedQuery).lean();
    const serverNow = new Date();

    // Compute dynamic status and counters across all scoped tests
    const statusCounts = {
      all: 0,
      ongoing: 0,
      upcoming: 0,
      completed: 0,
      draft: 0,
    };

    const enrichedTests = [];

    for (const t of allScopedTests) {
      const computedStatus = computeTestStatus(t, serverNow);
      const timestamps = resolveTestTimestamps(t);

      statusCounts.all++;
      if (computedStatus === 'ongoing') statusCounts.ongoing++;
      else if (computedStatus === 'upcoming') statusCounts.upcoming++;
      else if (computedStatus === 'completed') statusCounts.completed++;
      else if (computedStatus === 'draft') statusCounts.draft++;

      // Filter by requested status chip if provided
      if (requestedStatus && requestedStatus !== 'all' && computedStatus !== requestedStatus) {
        continue;
      }

      // Filter by test type
      if (type && type !== 'all') {
        const testMode = String(t.testMode || '').toLowerCase();
        const reqType = type.toLowerCase();
        if (reqType === 'mcq' && !testMode.includes('mcq') && !t.isOnlineTest) continue;
        if (reqType === 'written' && testMode.includes('mcq')) continue;
      }

      // Filter by date range
      if (startDate && timestamps.startAt) {
        if (new Date(timestamps.startAt) < new Date(startDate)) continue;
      }
      if (endDate && timestamps.startAt) {
        if (new Date(timestamps.startAt) > new Date(endDate)) continue;
      }

      enrichedTests.push({
        ...sanitizeTestPayload(t),
        id: String(t._id),
        _id: t._id,
        status: computedStatus,
        startAt: timestamps.startAt,
        endAt: timestamps.endAt,
        scheduleEstimated: timestamps.scheduleEstimated,
        formattedStartIST: timestamps.startAt ? formatInIST(timestamps.startAt) : 'Date not set',
        durationMinutes: timestamps.durationMinutes,
      });
    }

    // Sort enriched tests
    enrichedTests.sort((a, b) => {
      let valA = a[sortBy];
      let valB = b[sortBy];
      if (sortBy === 'startAt') {
        valA = a.startAt ? new Date(a.startAt).getTime() : 0;
        valB = b.startAt ? new Date(b.startAt).getTime() : 0;
      }
      if (valA < valB) return sortOrder === 'asc' ? -1 : 1;
      if (valA > valB) return sortOrder === 'asc' ? 1 : -1;
      return 0;
    });

    // Pagination
    const pageNum = Math.max(1, parseInt(page, 10));
    const pageSize = Math.max(1, parseInt(limit, 10));
    const totalRecords = enrichedTests.length;
    const paginatedTests = enrichedTests.slice((pageNum - 1) * pageSize, pageNum * pageSize);

    // Fetch attempts ratio and average score for paginated tests
    const pTestIds = [];
    for (const pt of paginatedTests) {
      if (pt._id) pTestIds.push(String(pt._id));
      if (pt.id) pTestIds.push(String(pt.id));
      if (pt.testId) pTestIds.push(String(pt.testId));
    }

    const evalStats = await Evaluation.aggregate([
      {
        $match: {
          $or: [{ published: true }, { autoGraded: true }],
          $and: [
            {
              $or: [
                { testId: { $in: pTestIds } },
                { examId: { $in: pTestIds } },
              ],
            },
          ],
        },
      },
      {
        $group: {
          _id: '$testId',
          submittedCount: { $sum: 1 },
          avgScore: {
            $avg: {
              $cond: [
                { $gt: ['$percentage', null] },
                '$percentage',
                {
                  $cond: [
                    { $and: [{ $gt: ['$marksObtained', null] }, { $gt: ['$totalMarks', 0] }] },
                    { $multiply: [{ $divide: ['$marksObtained', '$totalMarks'] }, 100] },
                    0,
                  ],
                },
              ],
            },
          },
        },
      },
    ]);

    const statMap = {};
    evalStats.forEach((s) => {
      statMap[String(s._id)] = {
        submittedCount: s.submittedCount,
        avgScore: parseFloat((s.avgScore || 0).toFixed(1)),
      };
    });

    // Attach eligible students and attempts ratio
    for (const pt of paginatedTests) {
      const tid = String(pt.testId || pt.id || pt._id);
      const st = statMap[tid] || { submittedCount: 0, avgScore: null };
      const eligible = await countEligibleStudents(pt);

      pt.submittedCount = st.submittedCount;
      pt.eligibleCount = eligible;
      pt.attemptsRatio = `${st.submittedCount} / ${eligible}`;
      pt.averageScore = st.avgScore;
    }

    return res.status(200).json({
      success: true,
      data: paginatedTests,
      statusCounts,
      pagination: {
        total: totalRecords,
        page: pageNum,
        limit: pageSize,
        totalPages: Math.ceil(totalRecords / pageSize),
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
};

// ============================================================================
// 3. CALENDAR FEED ENDPOINT
// ============================================================================
exports.getCalendarEvents = async (req, res) => {
  try {
    assertDevOrTestDatabase();

    const baseScoped = buildScopedQuery(req);
    const scopedQuery = applyCohortFilter(baseScoped, req.query);
    const { start, end } = req.query;

    const tests = await ClassTest.find(scopedQuery).lean();
    const serverNow = new Date();

    const events = [];

    for (const t of tests) {
      const timestamps = resolveTestTimestamps(t);
      if (!timestamps.startAt || !timestamps.endAt) continue;

      if (start && timestamps.endAt < new Date(start)) continue;
      if (end && timestamps.startAt > new Date(end)) continue;

      const computedStatus = computeTestStatus(t, serverNow);

      events.push({
        id: String(t.testId || t.id || t._id),
        _id: t._id,
        title: t.title,
        course: t.course,
        branch: t.branch,
        semester: t.semester,
        start: timestamps.startAt,
        end: timestamps.endAt,
        status: computedStatus,
        scheduleEstimated: timestamps.scheduleEstimated,
        formattedStartIST: formatInIST(timestamps.startAt),
        formattedEndIST: formatInIST(timestamps.endAt),
        durationMinutes: timestamps.durationMinutes,
        hasConflict: false,
      });
    }

    // Flag cohort scheduling conflicts
    for (let i = 0; i < events.length; i++) {
      for (let j = i + 1; j < events.length; j++) {
        if (hasCohortConflict(events[i], events[j])) {
          events[i].hasConflict = true;
          events[j].hasConflict = true;
          events[i].conflictWith = events[j].title;
          events[j].conflictWith = events[i].title;
        }
      }
    }

    return res.status(200).json({ success: true, data: events });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
};

// ============================================================================
// 4. TEST DETAIL DRAWER ENDPOINT
// ============================================================================
exports.getTestDetails = async (req, res) => {
  try {
    assertDevOrTestDatabase();
    const { id } = req.params;

    const test = await ClassTest.findOne({
      $or: [
        { _id: mongoose.Types.ObjectId.isValid(id) ? id : null },
        { id },
        { testId: id },
      ],
    }).lean();

    if (!test) {
      return res.status(404).json({ success: false, message: 'Test not found' });
    }

    if (!checkTeacherAccess(req.user, test)) {
      return res.status(403).json({ success: false, message: 'Access denied: test outside assigned course/branch' });
    }

    const serverNow = new Date();
    const computedStatus = computeTestStatus(test, serverNow);
    const timestamps = resolveTestTimestamps(test);
    const eligibleCount = await countEligibleStudents(test);

    // Attempts and results summary
    const testMatchIds = [String(test._id)];
    if (test.id) testMatchIds.push(String(test.id));
    if (test.testId) testMatchIds.push(String(test.testId));

    const evaluations = await Evaluation.find({
      $and: [
        {
          $or: [
            { testId: { $in: testMatchIds } },
            { examId: { $in: testMatchIds } },
          ],
        },
        { $or: [{ published: true }, { autoGraded: true }] },
      ],
    }).lean();

    const totalSubmissions = evaluations.length;
    const scores = evaluations.map((e) =>
      typeof e.percentage === 'number'
        ? e.percentage
        : e.marksObtained != null && e.totalMarks ? (e.marksObtained / e.totalMarks) * 100 : 0
    );

    const avgScore = scores.length > 0 ? parseFloat((scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1)) : null;
    const topScore = scores.length > 0 ? Math.max(...scores) : null;

    const sanitized = sanitizeTestPayload(test);

    return res.status(200).json({
      success: true,
      data: {
        ...sanitized,
        status: computedStatus,
        startAt: timestamps.startAt,
        endAt: timestamps.endAt,
        scheduleEstimated: timestamps.scheduleEstimated,
        formattedStartIST: timestamps.startAt ? formatInIST(timestamps.startAt) : 'Date not set',
        formattedEndIST: timestamps.endAt ? formatInIST(timestamps.endAt) : 'Date not set',
        eligibleCount,
        submittedCount: totalSubmissions,
        attemptsRatio: `${totalSubmissions} / ${eligibleCount}`,
        averageScore: avgScore,
        topScore,
        rescheduleHistory: test.rescheduleHistory || [],
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
};

// ============================================================================
// 5. RESCHEDULE ENDPOINT
// ============================================================================
exports.rescheduleTest = async (req, res) => {
  try {
    assertDevOrTestDatabase();
    const { id } = req.params;
    const { newStartAt, durationMinutes: newDuration, scheduledTime, reason } = req.body;
    const user = req.user;
    const role = String(user?.role || '').toLowerCase();

    if (!newStartAt) {
      return res.status(400).json({ success: false, message: 'newStartAt is required' });
    }

    const test = await ClassTest.findOne({
      $or: [
        { _id: mongoose.Types.ObjectId.isValid(id) ? id : null },
        { id },
        { testId: id },
      ],
    });

    if (!test) {
      return res.status(404).json({ success: false, message: 'Test not found' });
    }

    if (!checkTeacherAccess(user, test)) {
      return res.status(403).json({ success: false, message: 'Access denied: test outside assigned course/branch' });
    }

    const serverNow = new Date();
    const currentStatus = computeTestStatus(test, serverNow);
    const currentTimestamps = resolveTestTimestamps(test);

    // Permission rule: ongoing or completed tests can ONLY be rescheduled by admin with mandatory reason
    if (currentStatus === 'ongoing' || currentStatus === 'completed') {
      if (role !== 'admin' && user?.id !== 'master_admin_id') {
        return res.status(403).json({
          success: false,
          message: 'Only administrators can reschedule an ongoing or completed test.',
        });
      }
      if (!reason || !reason.trim()) {
        return res.status(400).json({
          success: false,
          message: 'A mandatory justification reason is required to reschedule an ongoing or completed test.',
        });
      }
    }

    const parsedStart = new Date(newStartAt);
    if (isNaN(parsedStart.getTime())) {
      return res.status(400).json({ success: false, message: 'Invalid newStartAt date format' });
    }

    // Past date constraint: non-admins cannot reschedule into the past
    if (parsedStart < serverNow && role !== 'admin' && user?.id !== 'master_admin_id') {
      return res.status(400).json({
        success: false,
        message: 'Cannot reschedule a test to a date or time in the past.',
      });
    }

    const duration = Number(newDuration || test.durationMinutes || 45);

    // Duration constraint for ongoing test: cannot shrink duration below elapsed time
    if (currentStatus === 'ongoing' && currentTimestamps.startAt) {
      const elapsedMinutes = Math.ceil((serverNow.getTime() - currentTimestamps.startAt.getTime()) / 60000);
      if (duration < elapsedMinutes) {
        return res.status(400).json({
          success: false,
          message: `Cannot shrink duration below elapsed test duration (${elapsedMinutes} minutes).`,
        });
      }
    }

    const parsedEnd = new Date(parsedStart.getTime() + duration * 60 * 1000);

    // Append to rescheduleHistory
    const historyItem = {
      previousStart: currentTimestamps.startAt,
      previousEnd: currentTimestamps.endAt,
      newStart: parsedStart,
      newEnd: parsedEnd,
      reason: reason || 'Scheduled adjustment',
      rescheduledBy: user?.name || user?.email || 'Admin',
      rescheduledAt: serverNow,
    };

    test.rescheduleHistory = test.rescheduleHistory || [];
    test.rescheduleHistory.push(historyItem);

    // Update fields & dual-write legacy
    test.startAt = parsedStart;
    test.endAt = parsedEnd;
    test.durationMinutes = duration;
    test.examDate = parsedStart;
    test.scheduledTime = scheduledTime || formatInIST(parsedStart, { includeTimezone: false });
    test.scheduleEstimated = false;

    await test.save();

    // Generate notification for students
    try {
      await Notification.create({
        id: `notif_resched_${Date.now()}`,
        title: 'Exam Rescheduled',
        message: `"${test.title}" has been rescheduled to ${formatInIST(parsedStart)}.`,
        type: 'classtest',
        course: test.course,
        branch: test.branch,
        semester: test.semester,
        contentId: test.id || test.testId || String(test._id),
      });
    } catch (_) {}

    // Audit log
    try {
      await AuditLog.create({
        action: 'test_rescheduled',
        actor: { id: user?.id, email: user?.email, role: user?.role },
        target: { id: test._id, title: test.title },
        details: historyItem,
      });
    } catch (_) {}

    return res.status(200).json({
      success: true,
      message: 'Test rescheduled successfully',
      data: {
        startAt: test.startAt,
        endAt: test.endAt,
        formattedStartIST: formatInIST(test.startAt),
        rescheduleHistory: test.rescheduleHistory,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
};

// ============================================================================
// 6. ARCHIVE & UNARCHIVE ENDPOINTS
// ============================================================================
exports.archiveTest = async (req, res) => {
  try {
    assertDevOrTestDatabase();
    const { id } = req.params;
    const user = req.user;

    const test = await ClassTest.findOne({
      $or: [
        { _id: mongoose.Types.ObjectId.isValid(id) ? id : null },
        { id },
        { testId: id },
      ],
    });

    if (!test) {
      return res.status(404).json({ success: false, message: 'Test not found' });
    }

    if (!checkTeacherAccess(user, test)) {
      return res.status(403).json({ success: false, message: 'Access denied: test outside assigned course/branch' });
    }

    // Safety guard: active student sessions in progress cannot be archived
    const activeSubmissions = await TestSubmission.countDocuments({
      test: { $in: [String(test._id), test.id, test.testId] },
      status: { $in: ['evaluating', 'in_progress', 'attempting'] },
    });

    if (activeSubmissions > 0) {
      return res.status(400).json({
        success: false,
        message: `Cannot archive test: ${activeSubmissions} student session(s) are actively in progress.`,
      });
    }

    test.isArchived = true;
    test.archivedAt = new Date();
    await test.save();

    // Audit log
    try {
      await AuditLog.create({
        action: 'test_archived',
        actor: { id: user?.id, email: user?.email, role: user?.role },
        target: { id: test._id, title: test.title },
      });
    } catch (_) {}

    return res.status(200).json({ success: true, message: 'Test archived successfully' });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
};

exports.unarchiveTest = async (req, res) => {
  try {
    assertDevOrTestDatabase();
    const { id } = req.params;
    const user = req.user;

    const test = await ClassTest.findOne({
      $or: [
        { _id: mongoose.Types.ObjectId.isValid(id) ? id : null },
        { id },
        { testId: id },
      ],
    });

    if (!test) {
      return res.status(404).json({ success: false, message: 'Test not found' });
    }

    if (!checkTeacherAccess(user, test)) {
      return res.status(403).json({ success: false, message: 'Access denied: test outside assigned course/branch' });
    }

    test.isArchived = false;
    test.archivedAt = null;
    await test.save();

    try {
      await AuditLog.create({
        action: 'test_unarchived',
        actor: { id: user?.id, email: user?.email, role: user?.role },
        target: { id: test._id, title: test.title },
      });
    } catch (_) {}

    return res.status(200).json({ success: true, message: 'Test restored from archive' });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
};

// ============================================================================
// 7. DUPLICATE TEST ENDPOINT
// ============================================================================
exports.duplicateTest = async (req, res) => {
  try {
    assertDevOrTestDatabase();
    const { id } = req.params;
    const user = req.user;

    const original = await ClassTest.findOne({
      $or: [
        { _id: mongoose.Types.ObjectId.isValid(id) ? id : null },
        { id },
        { testId: id },
      ],
    }).lean();

    if (!original) {
      return res.status(404).json({ success: false, message: 'Original test not found' });
    }

    if (!checkTeacherAccess(user, original)) {
      return res.status(403).json({ success: false, message: 'Access denied: test outside assigned course/branch' });
    }

    // Clone configuration and questions exclusively (zero attempts, zero results, unscheduled draft)
    const newDoc = { ...original };
    delete newDoc._id;
    delete newDoc.id;
    delete newDoc.testId;
    delete newDoc.createdAt;
    delete newDoc.updatedAt;

    newDoc.title = `[Copy] ${original.title}`;
    newDoc.status = 'draft';
    newDoc.isDraft = true;
    newDoc.published = false;
    newDoc.startAt = null;
    newDoc.endAt = null;
    newDoc.examDate = null;
    newDoc.scheduledTime = '';
    newDoc.scheduleEstimated = false;
    newDoc.isArchived = false;
    newDoc.archivedAt = null;
    newDoc.rescheduleHistory = [];

    // Deep clone questions
    if (Array.isArray(original.questions)) {
      newDoc.questions = JSON.parse(JSON.stringify(original.questions));
    }

    const created = new ClassTest(newDoc);
    await created.save();

    try {
      await AuditLog.create({
        action: 'test_duplicated',
        actor: { id: user?.id, email: user?.email, role: user?.role },
        target: { id: created._id, title: created.title },
        details: { originalId: original._id },
      });
    } catch (_) {}

    return res.status(201).json({
      success: true,
      message: 'Test duplicated as a draft',
      data: sanitizeTestPayload(created.toObject()),
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
};

// ============================================================================
// 8. TEST ANALYTICS ENDPOINT
// ============================================================================
exports.getAnalytics = async (req, res) => {
  try {
    assertDevOrTestDatabase();
    const { id } = req.params;
    const user = req.user;
    const role = String(user?.role || '').toLowerCase();

    const test = await ClassTest.findOne({
      $or: [
        { _id: mongoose.Types.ObjectId.isValid(id) ? id : null },
        { id },
        { testId: id },
      ],
    }).lean();

    if (!test) {
      return res.status(404).json({ success: false, message: 'Test not found' });
    }

    if (!checkTeacherAccess(user, test)) {
      return res.status(403).json({ success: false, message: 'Access denied: test outside assigned course/branch' });
    }

    const testMatchIds = [String(test._id)];
    if (test.id) testMatchIds.push(String(test.id));
    if (test.testId) testMatchIds.push(String(test.testId));

    const evals = await Evaluation.find({
      $and: [
        {
          $or: [
            { testId: { $in: testMatchIds } },
            { examId: { $in: testMatchIds } },
          ],
        },
        { $or: [{ published: true }, { autoGraded: true }] },
      ],
    }).lean();

    if (evals.length === 0) {
      return res.status(200).json({
        success: true,
        hasSufficientData: false,
        message: 'Not enough data for analytics',
        attempts: 0,
      });
    }

    const scores = evals.map((e) =>
      typeof e.percentage === 'number'
        ? e.percentage
        : e.marksObtained != null && e.totalMarks ? (e.marksObtained / e.totalMarks) * 100 : 0
    );

    scores.sort((a, b) => a - b);
    const total = scores.length;
    const mean = parseFloat((scores.reduce((a, b) => a + b, 0) / total).toFixed(1));
    const mid = Math.floor(total / 2);
    const median = total % 2 !== 0 ? scores[mid] : parseFloat(((scores[mid - 1] + scores[mid]) / 2).toFixed(1));
    const highest = scores[total - 1];
    const lowest = scores[0];

    // Pass rate (marks >= passingMarks or 40%)
    const passThreshold = test.passingMarks ? (test.passingMarks / (test.fullMarks || 50)) * 100 : 40;
    const passedCount = scores.filter((s) => s >= passThreshold).length;
    const passRate = parseFloat(((passedCount / total) * 100).toFixed(1));

    // Score distribution bins
    const bins = [
      { range: '0-20%', count: 0 },
      { range: '21-40%', count: 0 },
      { range: '41-60%', count: 0 },
      { range: '61-80%', count: 0 },
      { range: '81-100%', count: 0 },
    ];

    scores.forEach((s) => {
      if (s <= 20) bins[0].count++;
      else if (s <= 40) bins[1].count++;
      else if (s <= 60) bins[2].count++;
      else if (s <= 80) bins[3].count++;
      else bins[4].count++;
    });

    // Question-level difficulty index for MCQs
    const questionStats = [];
    if (Array.isArray(test.questions) && test.questions.length > 0) {
      test.questions.forEach((q, idx) => {
        const qNum = String(idx + 1);
        let correctCount = 0;
        let attemptCount = 0;

        evals.forEach((ev) => {
          if (Array.isArray(ev.questionMarks)) {
            const qm = ev.questionMarks.find((m) => String(m.questionNumber) === qNum);
            if (qm) {
              attemptCount++;
              if (qm.marksAwarded > 0) correctCount++;
            }
          }
        });

        const diffIndex = attemptCount > 0 ? parseFloat(((correctCount / attemptCount) * 100).toFixed(1)) : null;
        questionStats.push({
          questionNumber: qNum,
          topic: q.topic || `Question ${qNum}`,
          type: q.type || 'MCQ',
          marks: q.marks || 4,
          attempted: attemptCount,
          correctRate: diffIndex,
          difficulty: diffIndex == null ? 'N/A' : diffIndex >= 75 ? 'Easy' : diffIndex >= 40 ? 'Medium' : 'Hard',
        });
      });
    }

    return res.status(200).json({
      success: true,
      hasSufficientData: true,
      attempts: total,
      metrics: {
        mean,
        median,
        highest,
        lowest,
        passRate,
        passThreshold,
      },
      distribution: bins,
      questionStats,
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
};

// ============================================================================
// 9. CSV EXPORT ENDPOINT (Anti-Injection & Privacy Protected)
// ============================================================================
exports.exportResultsCSV = async (req, res) => {
  try {
    assertDevOrTestDatabase();
    const { id } = req.params;
    const user = req.user;

    const test = await ClassTest.findOne({
      $or: [
        { _id: mongoose.Types.ObjectId.isValid(id) ? id : null },
        { id },
        { testId: id },
      ],
    }).lean();

    if (!test) {
      return res.status(404).json({ success: false, message: 'Test not found' });
    }

    if (!checkTeacherAccess(user, test)) {
      return res.status(403).json({ success: false, message: 'Access denied: test outside assigned course/branch' });
    }

    const testMatchIds = [String(test._id)];
    if (test.id) testMatchIds.push(String(test.id));
    if (test.testId) testMatchIds.push(String(test.testId));

    const evals = await Evaluation.find({
      $and: [
        {
          $or: [
            { testId: { $in: testMatchIds } },
            { examId: { $in: testMatchIds } },
          ],
        },
        { $or: [{ published: true }, { autoGraded: true }] },
      ],
    })
      .select('studentRoll rollNumber studentName marksObtained totalMarks percentage grade submittedAt')
      .limit(1000) // Strict row capping
      .lean();

    // Sanitize formula injection
    const sanitizeCsvCell = (val) => {
      if (val === null || val === undefined) return '';
      let s = String(val).trim();
      if (/^[=+\-@\t\r]/.test(s)) {
        s = `'${s}`;
      }
      return `"${s.replace(/"/g, '""')}"`;
    };

    const headers = ['Roll Number', 'Student Name', 'Marks Obtained', 'Total Marks', 'Percentage', 'Grade', 'Submitted At (IST)'];
    const rows = [headers.join(',')];

    for (const ev of evals) {
      const roll = ev.studentRoll || ev.rollNumber || 'N/A';
      const name = ev.studentName || 'Student';
      const marks = ev.marksObtained != null ? ev.marksObtained : 'N/A';
      const total = ev.totalMarks || test.fullMarks || 50;
      const pct = typeof ev.percentage === 'number' ? `${ev.percentage.toFixed(1)}%` : 'N/A';
      const grade = ev.grade || 'N/A';
      const submitted = ev.submittedAt ? formatInIST(ev.submittedAt) : 'N/A';

      rows.push([
        sanitizeCsvCell(roll),
        sanitizeCsvCell(name),
        sanitizeCsvCell(marks),
        sanitizeCsvCell(total),
        sanitizeCsvCell(pct),
        sanitizeCsvCell(grade),
        sanitizeCsvCell(submitted),
      ].join(','));
    }

    const csvContent = rows.join('\r\n');

    // Audit log
    try {
      await AuditLog.create({
        action: 'test_results_exported',
        actor: { id: user?.id, email: user?.email, role: user?.role },
        target: { id: test._id, title: test.title },
        details: { exportCount: evals.length },
      });
    } catch (_) {}

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="Test_Results_${test._id}.csv"`);
    return res.status(200).send(csvContent);
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
};

// ============================================================================
// 10. COHORT ANALYTICS ENDPOINT (Aggregated Overview for Cohort)
// ============================================================================
exports.getCohortAnalytics = async (req, res) => {
  try {
    assertDevOrTestDatabase();
    const baseScoped = buildScopedQuery(req);
    const scopedQuery = applyCohortFilter(baseScoped, req.query);

    const tests = await ClassTest.find(scopedQuery).lean();
    if (!tests || tests.length === 0) {
      return res.status(200).json({
        success: true,
        hasSufficientData: false,
        totalTests: 0,
        totalEvaluations: 0,
        tests: [],
      });
    }

    const testMatchIds = [];
    for (const t of tests) {
      testMatchIds.push(String(t._id));
      if (t.id) testMatchIds.push(String(t.id));
      if (t.testId) testMatchIds.push(String(t.testId));
    }

    const evals = await Evaluation.find({
      $and: [
        {
          $or: [
            { testId: { $in: testMatchIds } },
            { examId: { $in: testMatchIds } },
          ],
        },
        { $or: [{ published: true }, { autoGraded: true }] },
      ],
    }).lean();

    const serverNow = new Date();

    if (evals.length === 0) {
      return res.status(200).json({
        success: true,
        hasSufficientData: false,
        totalTests: tests.length,
        totalEvaluations: 0,
        tests: tests.map((t) => ({
          id: String(t.testId || t.id || t._id),
          _id: t._id,
          title: t.title,
          course: t.course,
          branch: t.branch,
          semester: t.semester,
          status: computeTestStatus(t, serverNow),
          totalSubmissions: 0,
          averageScore: null,
        })),
      });
    }

    const scores = evals.map((e) =>
      typeof e.percentage === 'number'
        ? e.percentage
        : e.marksObtained != null && e.totalMarks ? (e.marksObtained / e.totalMarks) * 100 : 0
    );

    scores.sort((a, b) => a - b);
    const totalEvals = scores.length;
    const mean = parseFloat((scores.reduce((a, b) => a + b, 0) / totalEvals).toFixed(1));
    const mid = Math.floor(totalEvals / 2);
    const median = totalEvals % 2 !== 0 ? scores[mid] : parseFloat(((scores[mid - 1] + scores[mid]) / 2).toFixed(1));
    const highest = scores[totalEvals - 1];
    const lowest = scores[0];

    const passedCount = scores.filter((s) => s >= 40).length;
    const passRate = parseFloat(((passedCount / totalEvals) * 100).toFixed(1));

    const bins = [
      { range: '0-20%', count: 0 },
      { range: '21-40%', count: 0 },
      { range: '41-60%', count: 0 },
      { range: '61-80%', count: 0 },
      { range: '81-100%', count: 0 },
    ];

    scores.forEach((s) => {
      if (s <= 20) bins[0].count++;
      else if (s <= 40) bins[1].count++;
      else if (s <= 60) bins[2].count++;
      else if (s <= 80) bins[3].count++;
      else bins[4].count++;
    });

    // Per-test stats
    const perTestMap = {};
    for (const ev of evals) {
      const matchKey = String(ev.testId || ev.examId);
      if (!perTestMap[matchKey]) perTestMap[matchKey] = [];
      const pct = typeof ev.percentage === 'number'
        ? ev.percentage
        : ev.marksObtained != null && ev.totalMarks ? (ev.marksObtained / ev.totalMarks) * 100 : 0;
      perTestMap[matchKey].push(pct);
    }

    const testSummaries = tests.map((t) => {
      const id1 = String(t._id);
      const id2 = t.id ? String(t.id) : null;
      const id3 = t.testId ? String(t.testId) : null;
      const tScores = perTestMap[id1] || (id2 && perTestMap[id2]) || (id3 && perTestMap[id3]) || [];
      const tAvg = tScores.length > 0 ? parseFloat((tScores.reduce((a, b) => a + b, 0) / tScores.length).toFixed(1)) : null;
      return {
        id: String(t.testId || t.id || t._id),
        _id: t._id,
        title: t.title,
        course: t.course,
        branch: t.branch,
        semester: t.semester,
        status: computeTestStatus(t, serverNow),
        totalSubmissions: tScores.length,
        averageScore: tAvg,
      };
    });

    return res.status(200).json({
      success: true,
      hasSufficientData: true,
      totalTests: tests.length,
      totalEvaluations: totalEvals,
      metrics: {
        mean,
        median,
        highest,
        lowest,
        passRate,
        passThreshold: 40,
      },
      distribution: bins,
      tests: testSummaries,
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
};
