const mongoose = require("mongoose");

const schema = new mongoose.Schema(
  {
    coupleId: {
      type: String,
      unique: true,
      index: true,
      required: true
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

    husband: {
      name: String,
      patientId: String,
      idType: String,
      idNumber: String,
      idNumberHash: String
    },

    wife: {
      name: String,
      patientId: String,
      idType: String,
      idNumber: String,
      idNumberHash: String
    },

    status: {
      type: String,
      enum: [
        "REGISTERED",
        "ACTIVE",
        "COMPLETED",
        "CANCELLED"
      ],
      default: "REGISTERED"
    },

    mappedVialIds: [String]
  },
  {
    timestamps: true
  }
);

module.exports = mongoose.models.Couple || mongoose.model("Couple", schema);
