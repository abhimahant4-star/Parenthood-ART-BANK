const mongoose = require("mongoose");

const fileSchema = new mongoose.Schema({
  fileId: { type: String, required: true },
  originalName: { type: String, required: true },
  label: { type: String, default: "" },
  storageName: { type: String, required: true },
  mimeType: { type: String, required: true },
  size: { type: Number, required: true }
}, { _id: false });

const schema = new mongoose.Schema({
  attachmentId: { type: String, required: true, unique: true, index: true },
  hospitalId: { type: String, required: true, index: true },
  centreId: { type: String, required: true, index: true },
  relatedId: { type: String, default: "", index: true },
  category: { type: String, required: true },
  label: { type: String, required: true },
  status: { type: String, enum: ["DRAFT", "SUBMITTED"], default: "DRAFT", index: true },
  files: { type: [fileSchema], default: [] },
  createdBy: String,
  submittedBy: String,
  submittedAt: Date
}, { timestamps: true });

module.exports = mongoose.models.Attachment || mongoose.model("Attachment", schema);
