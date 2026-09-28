const mongoose = require('mongoose');

const monthSchema = new mongoose.Schema({
  month: { type: String, required: true }, // e.g., 'Jan', 'Feb', 'Mar'
  year: { type: Number, default: 2026 },
  monthIndex: { type: Number }, // 1-12
  status: { 
    type: String, 
    enum: ['Paid', 'Pending', 'Overdue'], 
    default: 'Pending' 
  },
  amount: { type: Number, default: 2500 },
  paidDate: { type: Date },
  receiptNo: { type: String },
  paymentMode: { type: String, default: 'UPI / Online' },
  remarks: { type: String }
}, { _id: false });

const feeSchema = new mongoose.Schema({
  studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Student' },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  studentName: { type: String, required: true },
  studentEmail: { type: String, required: true, index: true },
  studentWhatsapp: { type: String },
  fatherContact: { type: String },
  
  // Stream & Classification for fee structure assignment
  stream: { type: String, required: true }, // 'Engineering', 'BSc', 'JEE Mains & Advance', 'CBSE'
  branch: { type: String },
  semester: { type: mongoose.Schema.Types.Mixed },
  classLevel: { type: String },
  subject: { type: String },
  academicYear: { type: String, default: '2026-2027', index: true },
  
  // Fee Structure
  monthlyFee: { type: Number, required: true, default: 2500 },
  currency: { type: String, default: 'INR' },
  
  // 12 Months tracker
  months: [monthSchema],
  
  // Aggregated totals
  totalPaid: { type: Number, default: 0 },
  totalPending: { type: Number, default: 0 },
  totalOverdue: { type: Number, default: 0 },
  
  lastUpdated: { type: Date, default: Date.now }
}, {
  timestamps: true,
  strict: false
});

module.exports = mongoose.model('Fee', feeSchema);
