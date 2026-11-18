const mongoose = require("mongoose");

const schema = new mongoose.Schema(
  {
    patientId: {
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

    name: {
      type: String,
      required: true
    },

    gender: {
      type: String,
      enum: ["MALE", "FEMALE", "OTHER"]
    },

    dateOfBirth: Date,

    coupleId: {
      type: String,
      index: true
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
    }
  },
  {
    timestamps: true
  }
);

module.exports = mongoose.models.Patient || mongoose.model("Patient", schema);