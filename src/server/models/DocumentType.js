const mongoose = require("mongoose");

// Donor document types that staff created with "Create new item", kept for reuse.
const schema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 120 },
  key: { type: String, required: true, unique: true, index: true },
  createdBy: String
}, { timestamps: true });

module.exports = mongoose.models.DocumentType || mongoose.model("DocumentType", schema);
