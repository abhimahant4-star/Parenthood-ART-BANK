const mongoose = require("mongoose");

const schema = new mongoose.Schema({
  userId: String,
  role: String,
  action: String,
  entity: String,
  entityId: String,
  summary: String,
  oldValues: mongoose.Schema.Types.Mixed,
  newValues: mongoose.Schema.Types.Mixed,
  ip: String,
  createdAt: { type: Date, default: Date.now, immutable: true }
}, { versionKey: false });

schema.pre("save", async function rejectAuditUpdate() {
  if (!this.isNew) throw new Error("Audit log records are append-only");
});

for (const method of ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "deleteOne", "deleteMany", "findOneAndDelete", "findOneAndRemove", "remove"]) {
  schema.pre(method, async function rejectAuditQueryMutation() {
    throw new Error("Audit log records are append-only");
  });
}

schema.pre("deleteOne", { document: true, query: false }, async function rejectAuditDocumentDelete() {
  throw new Error("Audit log records are append-only");
});

schema.pre("bulkWrite", async function rejectAuditBulkWrite() {
  throw new Error("Audit log records are append-only");
});

module.exports = mongoose.models.AuditLog || mongoose.model("AuditLog", schema);
