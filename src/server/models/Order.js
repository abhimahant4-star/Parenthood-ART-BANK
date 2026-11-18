const mongoose = require("mongoose");

const schema = new mongoose.Schema(
  {
    orderId: {
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
    donorId: {
      type: String,
      index: true
    },

    centreId: {
      type: String,
      required: true,
      index: true
    },

    requestedBy: String,

    items: [
      {
        bloodGroup: String,
        quantity: Number
      }
    ],

    purpose: String,

    status: {
      type: String,
      enum: [
        "PENDING",
        "DISPATCHED",
        "RECEIVED"
      ],
      default: "PENDING",
      index: true
    },

    vialIds: [String],

    dispatchedBy: String,
    dispatchedAt: Date,

    courierDetails: mongoose.Schema.Types.Mixed,

    receivedBy: String,
    receivedVialIds: [String],
    receivedAt: Date
  },
  {
    timestamps: true
  }
);

module.exports = mongoose.models.Order || mongoose.model("Order", schema);