const mongoose = require("mongoose");

const schema = new mongoose.Schema({
  name: { type: String, unique: true, required: true },
  value: { type: Number, default: 0, min: 0 }
}, { versionKey: false });

module.exports = mongoose.models.IdSequence || mongoose.model("IdSequence", schema);
