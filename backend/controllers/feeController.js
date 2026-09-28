const Fee = require('../models/Fee');
const Student = require('../models/Student');
const User = require('../models/User');

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Helper to determine standard monthly fee based on course / stream
const getDefaultMonthlyFee = (stream, classLevel) => {
  const s = String(stream || '').toLowerCase();
  if (s.includes('jee')) return 4000;
  if (s.includes('eng')) return 3500;
  if (s.includes('bsc')) return 2500;
  if (s.includes('cbse')) {
    const c = String(classLevel || '').toLowerCase();
    if (c.includes('11') || c.includes('12')) return 2500;
    return 2000;
  }
  return 2500;
};

// Helper to generate default 12-month schedule for a student
const generateDefaultMonths = (monthlyFee, academicYear = '2026-2027') => {
  const year = 2026;
  const currentMonthIdx = new Date().getMonth(); // 0 to 11

  return MONTH_NAMES.map((m, idx) => {
    let initialStatus = 'Pending';
    // If earlier month of 2026, mark as Overdue or Pending
    if (idx < currentMonthIdx) {
      initialStatus = 'Pending';
    }

    return {
      month: m,
      year: year,
      monthIndex: idx + 1,
      status: initialStatus,
      amount: monthlyFee,
      paidDate: null,
      receiptNo: null,
      paymentMode: 'UPI / Online',
      remarks: ''
    };
  });
};

// Helper to recalculate summary totals
const recalculateTotals = (feeDoc) => {
  let paid = 0;
  let pending = 0;
  let overdue = 0;

  feeDoc.months.forEach(m => {
    const amt = typeof m.amount === 'number' ? m.amount : feeDoc.monthlyFee;
    if (m.status === 'Paid') {
      paid += amt;
    } else if (m.status === 'Overdue') {
      overdue += amt;
    } else {
      pending += amt;
    }
  });

  feeDoc.totalPaid = paid;
  feeDoc.totalPending = pending;
  feeDoc.totalOverdue = overdue;
  feeDoc.lastUpdated = new Date();
};

// @desc    Get all students' fees (Admin overview) with auto-detection & auto-sync
// @route   GET /api/fees
// @access  Public / Admin
const getAllFees = async (req, res) => {
  try {
    // 1. Fetch all student profiles from Student collection
    const students = await Student.find({}).sort({ createdAt: -1 });

    // Also look up any users who registered as students but might not yet have an onboarding profile
    const studentUsers = await User.find({ role: 'student' });
    const userMap = new Map();
    studentUsers.forEach(u => userMap.set(u.email.toLowerCase(), u));

    // Consolidate list of student emails
    const studentRecords = [];
    const seenEmails = new Set();

    students.forEach(s => {
      const em = (s.email || '').toLowerCase();
      if (em && !seenEmails.has(em)) {
        seenEmails.add(em);
        studentRecords.push({
          studentId: s._id,
          userId: s.userId || (userMap.get(em) ? userMap.get(em)._id : null),
          name: s.name,
          email: em,
          stream: s.stream || 'Engineering',
          branch: s.branch || 'CSE',
          semester: s.semester || 1,
          classLevel: s.classLevel || '',
          subject: s.subject || '',
          academicYear: s.academicYear || '2026-2027',
          studentWhatsapp: s.studentWhatsapp || s.whatsapp || '',
          fatherContact: s.fatherContact || s.fatherWhatsapp || '',
        });
      }
    });

    studentUsers.forEach(u => {
      const em = (u.email || '').toLowerCase();
      if (em && !seenEmails.has(em)) {
        seenEmails.add(em);
        studentRecords.push({
          studentId: null,
          userId: u._id,
          name: u.name,
          email: em,
          stream: u.stream || 'Engineering',
          branch: u.branch || u.targetCourse || 'CSE',
          semester: u.semester || 1,
          classLevel: u.classLevel || '',
          subject: u.subject || '',
          academicYear: u.academicYear || '2026-2027',
          studentWhatsapp: u.studentWhatsapp || u.whatsapp || u.mobile || '',
          fatherContact: u.fatherContact || u.fatherWhatsapp || '',
        });
      }
    });

    // 2. Ensure each student has a Fee record in MongoDB
    for (const rec of studentRecords) {
      let fee = await Fee.findOne({ studentEmail: rec.email });
      if (!fee) {
        const rate = getDefaultMonthlyFee(rec.stream, rec.classLevel);
        const months = generateDefaultMonths(rate, rec.academicYear);
        fee = new Fee({
          studentId: rec.studentId,
          userId: rec.userId,
          studentName: rec.name,
          studentEmail: rec.email,
          studentWhatsapp: rec.studentWhatsapp,
          fatherContact: rec.fatherContact,
          stream: rec.stream,
          branch: rec.branch,
          semester: rec.semester,
          classLevel: rec.classLevel,
          subject: rec.subject,
          academicYear: rec.academicYear,
          monthlyFee: rate,
          currency: 'INR',
          months: months,
        });
        recalculateTotals(fee);
        await fee.save();
      } else {
        // Sync any updated stream or contact details
        let changed = false;
        if (rec.name && fee.studentName !== rec.name) { fee.studentName = rec.name; changed = true; }
        if (rec.stream && fee.stream !== rec.stream) { fee.stream = rec.stream; changed = true; }
        if (rec.branch && fee.branch !== rec.branch) { fee.branch = rec.branch; changed = true; }
        if (rec.semester && fee.semester !== rec.semester) { fee.semester = rec.semester; changed = true; }
        if (rec.studentWhatsapp && fee.studentWhatsapp !== rec.studentWhatsapp) { fee.studentWhatsapp = rec.studentWhatsapp; changed = true; }
        if (changed) {
          await fee.save();
        }
      }
    }

    // 3. Return all fee documents
    const allFees = await Fee.find({}).sort({ studentName: 1 });
    res.json(allFees);
  } catch (error) {
    console.error('Error fetching all fees:', error);
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get fee record for a specific student
// @route   GET /api/fees/student/:email
// @access  Public / Student
const getStudentFee = async (req, res) => {
  try {
    const studentEmail = (req.params.email || '').toLowerCase().trim();
    if (!studentEmail) {
      return res.status(400).json({ message: 'Valid student email is required' });
    }

    let fee = await Fee.findOne({ studentEmail });

    if (!fee) {
      // Auto-create from student profile
      const student = await Student.findOne({ email: studentEmail }) || await User.findOne({ email: studentEmail });
      const stream = student ? student.stream : 'Engineering';
      const classLevel = student ? student.classLevel : '';
      const rate = getDefaultMonthlyFee(stream, classLevel);
      const months = generateDefaultMonths(rate, student?.academicYear || '2026-2027');

      fee = new Fee({
        studentId: student ? student._id : null,
        userId: student?.userId || (student?.role === 'student' ? student._id : null),
        studentName: student ? student.name : 'Student',
        studentEmail: studentEmail,
        studentWhatsapp: student ? (student.studentWhatsapp || student.whatsapp) : '',
        fatherContact: student ? (student.fatherContact || student.fatherWhatsapp) : '',
        stream: stream,
        branch: student ? student.branch : 'CSE',
        semester: student ? student.semester : 1,
        classLevel: classLevel,
        subject: student ? student.subject : '',
        academicYear: student ? student.academicYear : '2026-2027',
        monthlyFee: rate,
        currency: 'INR',
        months: months,
      });
      recalculateTotals(fee);
      await fee.save();
    }

    res.json(fee);
  } catch (error) {
    console.error('Error fetching student fee:', error);
    res.status(500).json({ message: error.message });
  }
};

// @desc    Update a specific month's payment status (Admin action)
// @route   PUT /api/fees/update
// @access  Public / Admin
const updateFeeStatus = async (req, res) => {
  try {
    const { feeId, studentEmail, month, status, paymentMode, remarks, customAmount } = req.body;

    let fee = null;
    if (feeId) {
      fee = await Fee.findById(feeId);
    }
    if (!fee && studentEmail) {
      fee = await Fee.findOne({ studentEmail: studentEmail.toLowerCase() });
    }

    if (!fee) {
      return res.status(404).json({ message: 'Fee record not found' });
    }

    const targetMonth = fee.months.find(m => m.month === month);
    if (!targetMonth) {
      return res.status(404).json({ message: `Month ${month} not found in fee record` });
    }

    const previousStatus = targetMonth.status;
    targetMonth.status = status; // 'Paid', 'Pending', 'Overdue'

    if (customAmount && !isNaN(customAmount)) {
      targetMonth.amount = Number(customAmount);
    }

    if (status === 'Paid') {
      if (!targetMonth.receiptNo) {
        // Auto-generate professional Receipt Number: REC-YYYY-RANDOM
        const rand = Math.floor(1000 + Math.random() * 9000);
        targetMonth.receiptNo = `ASM-REC-${new Date().getFullYear()}-${month.toUpperCase()}-${rand}`;
      }
      targetMonth.paidDate = new Date();
      targetMonth.paymentMode = paymentMode || targetMonth.paymentMode || 'UPI / Online';
      if (remarks) targetMonth.remarks = remarks;
    } else {
      // Reverted to Pending or Overdue
      targetMonth.paidDate = null;
      if (status === 'Pending') {
        targetMonth.receiptNo = null;
      }
    }

    recalculateTotals(fee);
    await fee.save();

    res.json({
      success: true,
      message: `Month ${month} updated to ${status} successfully`,
      fee,
      updatedMonth: targetMonth
    });
  } catch (error) {
    console.error('Error updating fee status:', error);
    res.status(500).json({ message: error.message });
  }
};

// @desc    Update a student's base monthly fee structure
// @route   PUT /api/fees/structure
// @access  Public / Admin
const updateFeeStructure = async (req, res) => {
  try {
    const { feeId, monthlyFee } = req.body;
    const fee = await Fee.findById(feeId);
    if (!fee) {
      return res.status(404).json({ message: 'Fee record not found' });
    }

    const newRate = Number(monthlyFee);
    if (isNaN(newRate) || newRate <= 0) {
      return res.status(400).json({ message: 'Valid monthly fee amount is required' });
    }

    fee.monthlyFee = newRate;
    // Update amount for non-paid months
    fee.months.forEach(m => {
      if (m.status !== 'Paid') {
        m.amount = newRate;
      }
    });

    recalculateTotals(fee);
    await fee.save();

    res.json({ success: true, message: 'Fee structure updated successfully', fee });
  } catch (error) {
    console.error('Error updating fee structure:', error);
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  getAllFees,
  getStudentFee,
  updateFeeStatus,
  updateFeeStructure,
};
