/**
 * Asia/Kolkata (IST, UTC+05:30) Schedule & Status Engine
 * Handles timezone conversion, legacy derivation, and dynamic time-based status resolution.
 */

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000; // 5 hours 30 minutes in milliseconds

/**
 * Format date to human-readable string in Asia/Kolkata timezone
 * @param {Date|string|number} dateInput 
 * @param {object} options 
 * @returns {string} e.g. "10 Nov 2026, 10:00 AM IST"
 */
function formatInIST(dateInput, options = {}) {
  if (!dateInput) return 'Date not set';
  const d = new Date(dateInput);
  if (isNaN(d.getTime())) return 'Invalid Date';

  const { includeSeconds = false, includeTimezone = true } = options;

  const formatter = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: includeSeconds ? '2-digit' : undefined,
    hour12: true,
  });

  const formatted = formatter.format(d);
  return includeTimezone ? `${formatted} IST` : formatted;
}

/**
 * Parses an IST date string (YYYY-MM-DD) and optional time string ("10:00 AM" or "14:30")
 * into an absolute UTC Date object.
 * @param {string|Date} dateStr 
 * @param {string} [timeStr] 
 * @returns {Date|null}
 */
function parseISTToUTC(dateStr, timeStr) {
  if (!dateStr) return null;

  let year, month, day;

  if (dateStr instanceof Date) {
    if (isNaN(dateStr.getTime())) return null;
    // Extract IST components
    const istDate = new Date(dateStr.getTime() + IST_OFFSET_MS);
    year = istDate.getUTCFullYear();
    month = istDate.getUTCMonth();
    day = istDate.getUTCDate();
  } else if (typeof dateStr === 'string') {
    const clean = dateStr.trim();
    // Check if ISO format with time already present
    if (clean.includes('T')) {
      const parsed = new Date(clean);
      if (!isNaN(parsed.getTime())) return parsed;
    }

    const parts = clean.split(/[-/]/);
    if (parts.length === 3) {
      if (parts[0].length === 4) {
        year = parseInt(parts[0], 10);
        month = parseInt(parts[1], 10) - 1;
        day = parseInt(parts[2], 10);
      } else {
        day = parseInt(parts[0], 10);
        month = parseInt(parts[1], 10) - 1;
        year = parseInt(parts[2], 10);
      }
    } else {
      const parsed = new Date(clean);
      if (isNaN(parsed.getTime())) return null;
      return parsed;
    }
  } else {
    return null;
  }

  let hours = 0;
  let minutes = 0;

  if (timeStr && typeof timeStr === 'string' && timeStr.trim()) {
    const cleanTime = timeStr.trim();
    const isPm = /pm/i.test(cleanTime);
    const isAm = /am/i.test(cleanTime);
    const nums = cleanTime.replace(/[^0-9:]/g, '').split(':');

    if (nums.length >= 2) {
      hours = parseInt(nums[0], 10);
      minutes = parseInt(nums[1], 10);

      if (isPm && hours < 12) hours += 12;
      if (isAm && hours === 12) hours = 0;
    }
  }

  // Construct UTC timestamp representing specified IST instant
  // Since IST is UTC+5.5, UTC time = IST time - 5.5 hours
  const utcMillis = Date.UTC(year, month, day, hours, minutes, 0, 0) - IST_OFFSET_MS;
  return new Date(utcMillis);
}

/**
 * Resolves startAt, endAt, and scheduleEstimated for a test document.
 * If startAt exists, uses it directly.
 * If startAt is missing but examDate exists:
 *   - Parses examDate. If no time provided, defaults to 00:00 IST of examDate and sets scheduleEstimated = true.
 * @param {object} test 
 * @returns {{ startAt: Date|null, endAt: Date|null, scheduleEstimated: boolean, durationMinutes: number }}
 */
function resolveTestTimestamps(test = {}) {
  const durationMinutes = Number(test.durationMinutes || test.duration) || 45;

  if (test.startAt) {
    const start = new Date(test.startAt);
    if (!isNaN(start.getTime())) {
      const end = test.endAt ? new Date(test.endAt) : new Date(start.getTime() + durationMinutes * 60 * 1000);
      return {
        startAt: start,
        endAt: !isNaN(end.getTime()) ? end : new Date(start.getTime() + durationMinutes * 60 * 1000),
        scheduleEstimated: Boolean(test.scheduleEstimated),
        durationMinutes,
      };
    }
  }

  // Fallback to legacy examDate
  const rawDate = test.examDate || test.scheduledDate || test.dueDate || test.date;
  if (!rawDate) {
    return {
      startAt: null,
      endAt: null,
      scheduleEstimated: false,
      durationMinutes,
    };
  }

  // Check if scheduledTime is provided
  const timeStr = test.scheduledTime || test.time || '';
  const parsedStart = parseISTToUTC(rawDate, timeStr);

  if (!parsedStart || isNaN(parsedStart.getTime())) {
    return {
      startAt: null,
      endAt: null,
      scheduleEstimated: false,
      durationMinutes,
    };
  }

  const end = new Date(parsedStart.getTime() + durationMinutes * 60 * 1000);
  // If time was not explicitly provided, it's an estimated start at 00:00 IST
  const isEstimated = !timeStr || !timeStr.trim();

  return {
    startAt: parsedStart,
    endAt: end,
    scheduleEstimated: isEstimated,
    durationMinutes,
  };
}

/**
 * Computes dynamic status for a test document based on current server UTC time.
 * @param {object} test 
 * @param {Date} [serverNow] 
 * @returns {'draft'|'cancelled'|'archived'|'date_not_set'|'upcoming'|'ongoing'|'completed'}
 */
function computeTestStatus(test = {}, serverNow = new Date()) {
  if (test.isArchived) return 'archived';
  if (test.isCancelled || test.status === 'cancelled') return 'cancelled';
  if (test.isDraft || test.status === 'draft') return 'draft';

  const { startAt, endAt } = resolveTestTimestamps(test);

  if (!startAt || !endAt || isNaN(startAt.getTime()) || isNaN(endAt.getTime())) {
    return 'date_not_set';
  }

  const nowMs = serverNow.getTime();
  const startMs = startAt.getTime();
  const endMs = endAt.getTime();

  if (nowMs < startMs) {
    return 'upcoming';
  } else if (nowMs >= startMs && nowMs <= endMs) {
    return 'ongoing';
  } else {
    return 'completed';
  }
}

/**
 * Checks whether two tests have overlapping time ranges and identical cohorts
 * @param {object} testA 
 * @param {object} testB 
 * @returns {boolean}
 */
function hasCohortConflict(testA, testB) {
  if (!testA || !testB) return false;
  const idA = String(testA._id || testA.id || testA.testId || '');
  const idB = String(testB._id || testB.id || testB.testId || '');
  if (idA && idB && idA === idB) return false;

  // Cohort match check
  const courseA = String(testA.course || '').toLowerCase().trim();
  const courseB = String(testB.course || '').toLowerCase().trim();
  if (courseA && courseB && courseA !== courseB) return false;

  const branchA = String(testA.branch || testA.stream || '').toLowerCase().trim();
  const branchB = String(testB.branch || testB.stream || '').toLowerCase().trim();
  const isCommonA = testA.isCommon || branchA.includes('all');
  const isCommonB = testB.isCommon || branchB.includes('all');
  if (!isCommonA && !isCommonB && branchA && branchB && branchA !== branchB) return false;

  const semA = String(testA.semester || '').toLowerCase().replace(/[^0-9]/g, '');
  const semB = String(testB.semester || '').toLowerCase().replace(/[^0-9]/g, '');
  if (semA && semB && semA !== semB) return false;

  // Time overlap check
  const timeA = resolveTestTimestamps(testA);
  const timeB = resolveTestTimestamps(testB);

  if (!timeA.startAt || !timeA.endAt || !timeB.startAt || !timeB.endAt) return false;

  return timeA.startAt.getTime() < timeB.endAt.getTime() && timeA.endAt.getTime() > timeB.startAt.getTime();
}

module.exports = {
  IST_OFFSET_MS,
  formatInIST,
  parseISTToUTC,
  resolveTestTimestamps,
  computeTestStatus,
  hasCohortConflict,
};
