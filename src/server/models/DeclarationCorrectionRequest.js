const mongoose = require("mongoose");

const proposedChangeSchema = new mongoose.Schema({
  field: { type: String, required: true, enum: ["date", "statement"] },
  value: { type: mongoose.Schema.Types.Mixed, required: true }
}, { _id: false, strict: "throw" });

const schema = new mongoose.Schema({
  requestId: { type: String, required: true },
  declarationId: { type: String, required: true },
  hospitalId: { type: String, required: true },
  centreId: { type: String, required: true },
  baseVersion: {
    type: Number,
    required: true,
    min: 1,
    validate: { validator: Number.isInteger, message: "baseVersion must be a positive integer" }
  },
  proposedChanges: {
    type: [proposedChangeSchema],
    required: true,
    validate: { validator: changes => Array.isArray(changes) && changes.length > 0, message: "At least one proposed change is required" }
  },
  reason: { type: String, required: true, trim: true, validate: { validator: value => value.length > 0, message: "reason is required" } },
  status: { type: String, required: true, enum: ["PENDING_REVIEW", "REVISION_REQUIRED", "APPROVED"] },
  requestedBy: { type: String, required: true },
  requestedAt: { type: Date, default: Date.now },
  reviewedBy: String,
  reviewedAt: Date,
  reviewReason: String,
  resultingVersion: {
    type: Number,
    min: 1,
    validate: { validator: value => value == null || Number.isInteger(value), message: "resultingVersion must be a positive integer" }
  },
  revisionOfRequestId: String
}, {
  timestamps: true,
  autoIndex: false,
  autoCreate: false
});

// Index declarations only. Automatic index/collection creation is disabled;
// any index rollout requires separate approval.
schema.index({ requestId: 1 }, { unique: true, name: "correction_request_id_unique" });
schema.index(
  { declarationId: 1 },
  { unique: true, partialFilterExpression: { status: "PENDING_REVIEW" }, name: "one_pending_correction_per_declaration" }
);
schema.index({ hospitalId: 1, centreId: 1, status: 1, requestedAt: -1 }, { name: "correction_request_hospital_queue" });
schema.index({ status: 1, requestedAt: 1 }, { name: "correction_request_review_queue" });

schema.pre("validate", function validateRequestFields(next) {
  const paths = (this.proposedChanges || []).map(change => change.field);
  if (new Set(paths).size !== paths.length) return next(new Error("proposedChanges cannot contain duplicate fields"));
  if (this.status === "REVISION_REQUIRED" && (!this.reviewReason || !this.reviewReason.trim())) {
    return next(new Error("reviewReason is required when a correction is rejected"));
  }
  if (this.status === "APPROVED" && !Number.isInteger(this.resultingVersion)) {
    return next(new Error("resultingVersion is required for an approved correction"));
  }
  next();
});

module.exports = mongoose.models.DeclarationCorrectionRequest || mongoose.model("DeclarationCorrectionRequest", schema);
