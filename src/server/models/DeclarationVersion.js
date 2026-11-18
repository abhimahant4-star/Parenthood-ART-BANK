const mongoose = require("mongoose");

const schema = new mongoose.Schema({
  declarationId: { type: String, required: true },
  version: {
    type: Number,
    required: true,
    min: 1,
    validate: { validator: Number.isInteger, message: "version must be a positive integer" }
  },
  declarationType: { type: String, required: true },
  confirmations: { type: mongoose.Schema.Types.Mixed, required: true },
  declarationData: { type: mongoose.Schema.Types.Mixed, default: {} },
  coupleId: { type: String, required: true },
  hospitalId: { type: String, required: true },
  centreId: { type: String, required: true },
  vialIds: { type: [String], default: [] },
  signerId: String,
  signerSnapshot: mongoose.Schema.Types.Mixed,
  correctionRequestId: String,
  createdBy: { type: String, required: true },
  createdAt: { type: Date, default: Date.now, immutable: true }
}, {
  versionKey: false,
  autoIndex: false,
  autoCreate: false
});

// Declared for a separately approved index rollout. autoIndex/autoCreate are
// disabled so importing this model cannot create indexes or a collection.
schema.index({ declarationId: 1, version: 1 }, { unique: true, name: "declaration_version_unique" });

// Snapshots are append-only. Existing documents cannot be saved again.
schema.pre("save", async function rejectSnapshotUpdate() {
  if (!this.isNew) throw new Error("Declaration versions are immutable");
});
for (const method of ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "deleteOne", "deleteMany", "findOneAndDelete", "findOneAndRemove", "remove"]) {
  schema.pre(method, async function rejectSnapshotQueryMutation() {
    throw new Error("Declaration versions are immutable");
  });
}

// Mongoose 8.7 executes model middleware for bulkWrite. Reject all bulk writes
// so updates/deletes cannot bypass the query middleware above. bulkSave routes
// through bulkWrite and is rejected by the same guard.
schema.pre("bulkWrite", async function rejectSnapshotBulkWrite() {
  throw new Error("Declaration versions are immutable; use append-only creation");
});

// Query deleteOne middleware does not cover doc.deleteOne(), so register the
// separate document middleware path explicitly.
schema.pre("deleteOne", { document: true, query: false }, async function rejectSnapshotDocumentDelete() {
  throw new Error("Declaration versions are immutable");
});

module.exports = mongoose.models.DeclarationVersion || mongoose.model("DeclarationVersion", schema);
