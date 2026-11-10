const mongoose = require('mongoose');

const assignmentSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    assignmentType: {
      type: String,
      enum: ['problem_set', 'homework', 'lab_sheet', 'project', 'quiz_sheet', 'other'],
      default: 'problem_set',
    },
    status: {
      type: String,
      enum: ['draft', 'active', 'completed', 'archived'],
      default: 'active',
      index: true,
    },
    totalMarks: { type: Number, default: 30 },
    dueDate: { type: Date, required: true, index: true },
    deadline: { type: Date }, // Backward compatibility with legacy schema
    attachmentUrl: { type: String },
    questionFileUrl: { type: String }, // Backward compatibility
    attachmentSize: { type: Number, default: 0 },
    attachmentName: { type: String },
    description: { type: String, default: '' },
    notifyOnPublish: { type: Boolean, default: false },
    submissionCount: { type: Number, default: 0 },
    totalStudents: { type: Number, default: 45 },

    // Cohort targeting
    course: { type: String, default: 'Engineering', index: true },
    branch: { type: String, default: 'CSE', index: true },
    stream: { type: String }, // Legacy compatibility
    semester: { type: mongoose.Schema.Types.Mixed, default: 'Semester 1' },
    classLevel: { type: String },
    subject: { type: String, default: 'Applied Mathematics' },
    isCommon: { type: Boolean, default: false },

    // Soft delete & auditing
    isDeleted: { type: Boolean, default: false, index: true },
    publishedAt: { type: Date, default: Date.now },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Query-time computed virtual for overdue detection (Amendment 1)
assignmentSchema.virtual('isOverdue').get(function () {
  if (this.status !== 'active') return false;
  const targetDate = this.dueDate || this.deadline;
  return Boolean(targetDate && new Date(targetDate) < new Date());
});

// Sync legacy fields automatically before saving (synchronous hook)
assignmentSchema.pre('save', function () {
  if (this.dueDate && !this.deadline) {
    this.deadline = this.dueDate;
  } else if (this.deadline && !this.dueDate) {
    this.dueDate = this.deadline;
  }

  if (this.attachmentUrl && !this.questionFileUrl) {
    this.questionFileUrl = this.attachmentUrl;
  } else if (this.questionFileUrl && !this.attachmentUrl) {
    this.attachmentUrl = this.questionFileUrl;
  }

  if (this.branch && !this.stream) {
    this.stream = this.branch;
  }
});

// Compound index for performant cohort filtering and sorting
assignmentSchema.index({
  course: 1,
  branch: 1,
  semester: 1,
  status: 1,
  dueDate: 1,
  isDeleted: 1,
});

module.exports = mongoose.model('Assignment', assignmentSchema);
