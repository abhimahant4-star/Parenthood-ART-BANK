const mongoose = require("mongoose");

const schema = new mongoose.Schema(
  {
    signatureId: {
      type: String,
      unique: true,
      index: true,
      required: true
    },

    declarationId: {
      type: String,
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

    signedBy: {
      type: String,
      required: true
    },

    signatureMethod: {
      type: String,
      enum: ["DIGITAL", "E_SIGN"],
      default: "DIGITAL"
    },

    signatureData: {
      type: String,
      required: true
    },

    // Legacy signatures with no value are treated as version 1 at runtime.
    // These are additive metadata fields; signature indexes are unchanged.
    declarationVersion: {
      type: Number,
      min: 1,
      validate: {
        validator: value => value == null || Number.isInteger(value),
        message: "declarationVersion must be a positive integer"
      }
    },
    valid: Boolean,
    invalidatedAt: Date,
    invalidatedBy: String,
    invalidatedByCorrectionRequestId: String,

    signedAt: {
      type: Date,
      default: Date.now
    }
  },
  {
    timestamps: true
  }
);

// Versioned signatures require one unique record per declaration version.
// The rollout script creates this only after legacy metadata is verified;
// production connections disable automatic index creation.
schema.index(
  { declarationId: 1, declarationVersion: 1 },
  { unique: true, name: "declarationId_1_declarationVersion_1" }
);

module.exports = mongoose.models.Signature || mongoose.model("Signature", schema);
