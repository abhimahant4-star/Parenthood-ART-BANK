const mongoose = require("mongoose");
const imageVersionSchema = new mongoose.Schema({
  version: Number,
  storageName: String,
  mimeType: String,
  originalName: String
}, { _id: false });

const schema = new mongoose.Schema({
  signerId: { type: String, unique: true, index: true, required: true },
  name: { type: String, required: true },
  designation: { type: String, required: true },
  status: { type: String, enum: ["ACTIVE", "INACTIVE"], default: "ACTIVE", index: true },
  version: { type: Number, default: 1 },
  imageStorageName: { type: String, required: true },
  imageMimeType: { type: String, enum: ["image/png", "image/jpeg"], required: true },
  imageOriginalName: { type: String, required: true },
  imageVersions: { type: [imageVersionSchema], default: [] },
  createdBy: String,
  updatedBy: String
}, { timestamps: true });

module.exports = mongoose.models.AuthorizedSigner || mongoose.model("AuthorizedSigner", schema);
