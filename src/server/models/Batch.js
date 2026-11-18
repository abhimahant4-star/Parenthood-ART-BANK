const mongoose = require("mongoose");

const schema = new mongoose.Schema({

  batchId: {
    type: String,
    unique: true,
    index: true,
    required: true
  },

  donor: Object,

  batchDate: Date,

  stockClassification: {
    type: String,
    enum: ["KARYOTYPE_TESTED", "NORMAL_STOCK"],
    default: "NORMAL_STOCK"
  },

  collectionAt: {
    type: Date,
    required: true
  },

  vialCount: {
    type: Number,
    required: true,
    min: 1
  },

  // Blood group of donor/batch
  bloodGroup: {
    type: String
  },

  quarantineStart: Date,

  quarantineEnd: Date,

  testing: mongoose.Schema.Types.Mixed,

  repeatTest: mongoose.Schema.Types.Mixed,

  releaseStatus: {
    type: String,
    default: "QUARANTINED"
  },

  approvedBy: String,

  attachments: [
    mongoose.Schema.Types.ObjectId
  ],

  notes: String,
  documentsVerified: { type: Boolean, default: false }

}, {
  timestamps: true
});

module.exports = mongoose.models.Batch || mongoose.model("Batch", schema);
