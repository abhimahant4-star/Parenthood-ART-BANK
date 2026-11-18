const mongoose = require("mongoose");

const schema = new mongoose.Schema(
  {
    declarationId: {
      type: String,
      unique: true,
      index: true,
      required: true
    },

    coupleId: {
      type: String,
      required: true,
      index: true
    },

    hospitalId: {
      type: String,
      required: true,
      index: true
    },

    centreId: {
      type: String,
      required: true,
      index: true
    },

    declarationType: {
      type: String,
      required: true
    },

    confirmations: {
      type: mongoose.Schema.Types.Mixed,
      required: true
    },

    declarationData: {
      type: mongoose.Schema.Types.Mixed,
      default: {}
    },
    // Missing values on legacy records are interpreted as version 1 by
    // declarationVersionService; no bulk backfill is required.
    currentVersion: {
      type: Number,
      min: 1,
      validate: {
        validator: value => value == null || Number.isInteger(value),
        message: "currentVersion must be a positive integer"
      }
    },
    // Tracks which declaration version the latest accepted signature covers.
    lastSignedVersion: {
      type: Number,
      min: 1,
      validate: {
        validator: value => value == null || Number.isInteger(value),
        message: "lastSignedVersion must be a positive integer"
      }
    },
    // Conditional claim used to guarantee one open correction request even
    // when the separately managed partial unique index is not installed.
    pendingCorrectionRequestId: {
      type: String,
      default: undefined
    },
    vialIds: [String],
    signerId: String,
    signerSnapshot: mongoose.Schema.Types.Mixed,

    status: {
      type: String,
      enum: [
        "DRAFT",
        "SUBMITTED",
        "CORRECTION_REQUIRED",
        "APPROVED"
      ],
      default: "DRAFT",
      index: true
    },

    submittedBy: String,
    submittedAt: Date,

    correctionReason: String,
    correctedBy: String,
    correctedAt: Date
  },
  {
    timestamps: true
  }
);

module.exports = mongoose.models.Declaration || mongoose.model("Declaration", schema);
