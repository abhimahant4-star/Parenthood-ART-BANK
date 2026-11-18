const { test } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const Declaration = require("../models/Declaration");
const DeclarationVersion = require("../models/DeclarationVersion");
const DeclarationCorrectionRequest = require("../models/DeclarationCorrectionRequest");
const Signature = require("../models/Signature");
const AuditLog = require("../models/AuditLog");
const versions = require("../services/declarationVersionService");
const corrections = require("../services/declarationCorrectionService");
const { recordDeclarationCorrectionEvent } = require("../services/auditService");

test("legacy declaration and signature versions resolve to version 1 without mutation", () => {
  const declaration = { declarationId: "DECL-UNIT", declarationData: { date: "2030-01-01" } };
  const signature = { declarationId: declaration.declarationId };
  assert.equal(versions.getEffectiveDeclarationVersion(declaration), 1);
  assert.equal(versions.getEffectiveSignatureVersion(signature), 1);
  assert.equal(versions.isSignatureCurrentForDeclaration(signature, declaration), true);
  assert.equal(Object.hasOwn(declaration, "currentVersion"), false);
  assert.equal(Object.hasOwn(signature, "declarationVersion"), false);
});

test("explicit malformed versions are rejected", () => {
  assert.throws(() => versions.getEffectiveDeclarationVersion({ currentVersion: 0 }), /positive integer/);
  assert.throws(() => versions.getEffectiveSignatureVersion({ declarationVersion: 1.5 }), /positive integer/);
});

test("version snapshots deep-copy Mongoose and nested Mixed data", () => {
  const declaration = new Declaration({
    declarationId: "DECL-COPY",
    coupleId: "COUPLE-COPY",
    hospitalId: "HOSP-COPY",
    centreId: "CENTRE-COPY",
    declarationType: "ART_BANK",
    confirmations: { verified: true, nested: { labels: ["original"] } },
    declarationData: { date: "2030-01-01", statement: "Original", nested: { items: [1] } },
    vialIds: ["VIAL-COPY"],
    signerId: "SIGNER-COPY",
    signerSnapshot: { name: "Signer", details: { roles: ["authorised"] } }
  });
  const snapshot = versions.buildInitialVersionSnapshot(declaration, { createdBy: "unit-user" });

  snapshot.declarationData.nested.items.push(2);
  snapshot.confirmations.nested.labels.push("changed");
  snapshot.signerSnapshot.details.roles.push("changed");
  snapshot.vialIds.push("VIAL-OTHER");

  assert.deepEqual(declaration.declarationData.nested.items, [1]);
  assert.deepEqual(declaration.confirmations.nested.labels, ["original"]);
  assert.deepEqual(declaration.signerSnapshot.details.roles, ["authorised"]);
  assert.deepEqual(declaration.vialIds, ["VIAL-COPY"]);
  assert.equal(snapshot.version, 1);
});

test("approved changes create a copied next version without sharing input or output references", () => {
  const declaration = {
    declarationId: "DECL-NEXT", currentVersion: 2, declarationType: "ART_BANK",
    confirmations: { verified: true },
    declarationData: { date: "2030-01-01", statement: "Original", donor: "DONOR-REF", nested: { values: ["source"] } },
    coupleId: "COUPLE-REF", hospitalId: "HOSP-REF", centreId: "CENTRE-REF",
    vialIds: ["VIAL-REF"], signerId: "SIGNER-REF", signerSnapshot: { version: 1 }
  };
  const proposedChanges = [
    { field: "date", value: "2030-02-03" },
    { field: "statement", value: "Corrected statement" }
  ];
  const next = versions.buildNextVersionSnapshot(declaration, proposedChanges, { createdBy: "reviewer", correctionRequestId: "REQ-1" });

  assert.equal(next.version, 3);
  assert.equal(next.declarationData.date, "2030-02-03");
  assert.equal(next.declarationData.statement, "Corrected statement");
  assert.equal(next.declarationData.donor, "DONOR-REF");
  assert.equal(next.signerId, "SIGNER-REF");
  assert.equal(declaration.declarationData.statement, "Original");
  proposedChanges[1].value = "Changed after build";
  proposedChanges.push({ field: "statement", value: "Another change" });
  next.declarationData.nested.values.push("snapshot mutation");
  declaration.declarationData.nested.values.push("source mutation");
  assert.equal(next.declarationData.statement, "Corrected statement");
  assert.deepEqual(next.declarationData.nested.values, ["source", "snapshot mutation"]);
  assert.deepEqual(declaration.declarationData.nested.values, ["source", "source mutation"]);
});

test("version service exposes no snapshot update or delete helper", () => {
  assert.equal(Object.hasOwn(versions, "updateDeclarationVersion"), false);
  assert.equal(Object.hasOwn(versions, "deleteDeclarationVersion"), false);
  assert.equal(typeof versions.persistDeclarationVersion, "function");
  assert.equal(DeclarationVersion.schema.options.autoIndex, false);
  assert.equal(DeclarationVersion.schema.options.autoCreate, false);
  assert.ok(DeclarationVersion.schema.indexes().some(([keys, options]) => keys.declarationId === 1 && keys.version === 1 && options.unique));
});

test("append-only persistence boundary performs only a copied insert with the exact session", async () => {
  const original = DeclarationVersion.create;
  const session = { marker: "version-session" };
  const source = {
    declarationId: "DECL-PERSIST", version: 1, declarationType: "ART_BANK",
    confirmations: { nested: ["before"] }, declarationData: { nested: { values: [1] } },
    coupleId: "COUPLE-PERSIST", hospitalId: "HOSP-PERSIST", centreId: "CENTRE-PERSIST",
    vialIds: ["VIAL-PERSIST"], createdBy: "unit-test"
  };
  let args;
  DeclarationVersion.create = async (...received) => {
    args = received;
    return [received[0][0]];
  };
  try {
    const inserted = await versions.persistDeclarationVersion(source, { session });
    assert.equal(args.length, 2);
    assert.equal(args[1].session, session);
    assert.deepEqual(Object.keys(args[1]), ["session"]);
    source.declarationData.nested.values.push(2);
    inserted.confirmations.nested.push("after");
    assert.deepEqual(args[0][0].declarationData.nested.values, [1]);
    assert.deepEqual(source.confirmations.nested, ["before"]);
  } finally {
    DeclarationVersion.create = original;
  }
});

test("correction validation permits only date and statement without a new statement length cap", () => {
  const longStatement = "x".repeat(20000);
  const result = corrections.validateCorrectionRequest({
    baseVersion: 1,
    reason: "Correcting the declaration",
    proposedChanges: [
      { field: "date", value: "2030-02-03" },
      { field: "statement", value: longStatement }
    ]
  });
  assert.equal(result.proposedChanges[1].value.length, 20000);
  assert.equal(result.reason, "Correcting the declaration");
});

test("correction validation rejects protected, unknown, nested, duplicate and malformed changes", () => {
  const base = { baseVersion: 1, reason: "Reason", proposedChanges: [{ field: "date", value: "2030-02-03" }] };
  for (const field of ["status", "signerId", "hospitalId", "coupleId", "vialIds", "donor", "date.value", "clinicalField"]) {
    assert.throws(() => corrections.validateCorrectionRequest({ ...base, proposedChanges: [{ field, value: "2030-02-03" }] }), /Only date and statement/);
  }
  assert.throws(() => corrections.validateCorrectionRequest({ ...base, unexpected: true }), /unsupported fields/);
  assert.throws(() => corrections.validateCorrectionRequest({ ...base, proposedChanges: [base.proposedChanges[0], base.proposedChanges[0]] }), /duplicate fields/);
  assert.throws(() => corrections.validateCorrectionRequest({ ...base, proposedChanges: [{ field: "date", value: "2030-02-30" }] }), /invalid/);
  assert.throws(() => corrections.validateCorrectionRequest({ ...base, proposedChanges: [{ field: "date", value: 20300203 }] }), /YYYY-MM-DD/);
  assert.throws(() => corrections.validateCorrectionRequest({ ...base, proposedChanges: [{ field: "date", value: "2030/02/03" }] }), /YYYY-MM-DD/);
  assert.throws(() => corrections.validateCorrectionRequest({ ...base, proposedChanges: [{ field: "statement", value: 12 }] }), /non-empty string/);
  assert.throws(() => corrections.validateCorrectionRequest({ ...base, proposedChanges: [{ field: "statement", value: { text: "wrong type" } }] }), /non-empty string/);
  assert.throws(() => corrections.validateCorrectionRequest({ ...base, proposedChanges: [{ field: "statement", value: "   " }] }), /non-empty string/);
  assert.throws(() => corrections.validateCorrectionRequest({ ...base, reason: " " }), /reason is required/);
  assert.throws(() => corrections.validateReviewReason(" "), /review reason is required/);
});

test("snapshot builder independently rejects invalid date and statement values", () => {
  const declaration = { currentVersion: 1, declarationData: { date: "2030-01-01", statement: "Current" } };
  const metadata = { createdBy: "reviewer" };
  for (const value of [20300102, "2030/01/02", "2030-02-30"]) {
    assert.throws(() => versions.buildNextVersionSnapshot(declaration, [{ field: "date", value }], metadata));
  }
  for (const value of [12, { text: "wrong type" }, "   "]) {
    assert.throws(() => versions.buildNextVersionSnapshot(declaration, [{ field: "statement", value }], metadata));
  }
  assert.deepEqual(declaration.declarationData, { date: "2030-01-01", statement: "Current" });
});

test("DeclarationVersion blocks all supported query/model mutation paths without database access", async () => {
  const id = new mongoose.Types.ObjectId();
  const operations = [
    ["updateOne", () => DeclarationVersion.updateOne({ _id: id }, { $set: { version: 2 } })],
    ["updateMany", () => DeclarationVersion.updateMany({ _id: id }, { $set: { version: 2 } })],
    ["findOneAndUpdate", () => DeclarationVersion.findOneAndUpdate({ _id: id }, { $set: { version: 2 } })],
    ["replaceOne", () => DeclarationVersion.replaceOne({ _id: id }, { version: 2 })],
    ["findOneAndDelete", () => DeclarationVersion.findOneAndDelete({ _id: id })],
    ["deleteOne", () => DeclarationVersion.deleteOne({ _id: id })],
    ["deleteMany", () => DeclarationVersion.deleteMany({ _id: id })]
  ];
  if (typeof DeclarationVersion.findOneAndRemove === "function") {
    operations.push(["findOneAndRemove", () => DeclarationVersion.findOneAndRemove({ _id: id })]);
  }
  if (typeof DeclarationVersion.find === "function" && typeof DeclarationVersion.find({}).remove === "function") {
    operations.push(["query.remove", () => DeclarationVersion.find({ _id: id }).remove()]);
  }

  for (const [name, makeQuery] of operations) {
    const query = makeQuery();
    query.setOptions({ bufferTimeoutMS: 10 });
    await assert.rejects(query.exec(), /Declaration versions are immutable/, name);
    assert.equal(mongoose.connection.readyState, 0, `${name} must not connect to MongoDB`);
  }

  await assert.rejects(
    DeclarationVersion.bulkWrite([{ deleteOne: { filter: { _id: id } } }]),
    /Declaration versions are immutable/,
    "bulkWrite"
  );
  const existing = DeclarationVersion.hydrate({
    _id: id, version: 1, declarationId: "DECL-IMMUTABLE", declarationType: "ART_BANK",
    confirmations: { verified: true }, coupleId: "COUPLE-IMMUTABLE", hospitalId: "HOSP-IMMUTABLE",
    centreId: "CENTRE-IMMUTABLE", createdBy: "unit-test"
  });
  await assert.rejects(existing.deleteOne(), /Declaration versions are immutable/, "document.deleteOne");
  existing.version = 2;
  await assert.rejects(existing.save(), /Declaration versions are immutable/, "document.save");
  await assert.rejects(DeclarationVersion.bulkSave([existing]), /Declaration versions are immutable/, "bulkSave");
  assert.equal(mongoose.connection.readyState, 0);
});

test("correction request model validates fields and declares code-only indexes", async () => {
  const valid = new DeclarationCorrectionRequest({
    requestId: "REQ-1", declarationId: "DECL-1", hospitalId: "HOSP-1", centreId: "CENTRE-1",
    baseVersion: 1, proposedChanges: [{ field: "statement", value: "Corrected" }],
    reason: "Required reason", status: "PENDING_REVIEW", requestedBy: "hospital-user"
  });
  await valid.validate();
  assert.equal(DeclarationCorrectionRequest.schema.options.autoIndex, false);
  assert.equal(DeclarationCorrectionRequest.schema.options.autoCreate, false);
  const indexNames = DeclarationCorrectionRequest.schema.indexes().map(([, options]) => options.name);
  assert.deepEqual(indexNames, [
    "correction_request_id_unique", "one_pending_correction_per_declaration",
    "correction_request_hospital_queue", "correction_request_review_queue"
  ]);
  const rejectedWithoutReason = new DeclarationCorrectionRequest({
    requestId: "REQ-2", declarationId: "DECL-1", hospitalId: "HOSP-1", centreId: "CENTRE-1",
    baseVersion: 1, proposedChanges: [{ field: "date", value: "2030-01-01" }],
    reason: "Required reason", status: "REVISION_REQUIRED", requestedBy: "hospital-user"
  });
  await assert.rejects(rejectedWithoutReason.validate(), /reviewReason is required/);
});

test("signature version fields remain optional and schema declares versioned uniqueness", () => {
  const signaturePath = Signature.schema.path("declarationId");
  assert.equal(signaturePath.options.required, true);
  assert.notEqual(signaturePath.options.unique, true);
  const declaredIndexes = Signature.schema.indexes();
  assert.ok(declaredIndexes.some(([keys, options]) => keys.declarationId === 1 && keys.declarationVersion === 1 && options.unique === true));
  assert.ok(!declaredIndexes.some(([keys, options]) => Object.keys(keys).length === 1 && keys.declarationId === 1 && options.unique === true));
  const legacy = new Signature({
    signatureId: "SIGN-LEGACY", declarationId: "DECL-LEGACY", coupleId: "COUPLE-1",
    hospitalId: "HOSP-1", centreId: "CENTRE-1", signedBy: "hospital-user", signatureData: "encrypted"
  });
  assert.equal(legacy.validateSync(), undefined);
  assert.equal(legacy.declarationVersion, undefined);
  assert.equal(legacy.valid, undefined);
  assert.equal(versions.getEffectiveSignatureVersion(legacy), 1);
  assert.equal(versions.isSignatureCurrentForDeclaration(legacy, { currentVersion: 2 }), false);
});

test("audit service accepts safe metadata only and emits no payload or reason fields", async () => {
  const entry = require("../services/auditService").makeAuditDocument({
    actorId: "reviewer-id", role: "ART_BANK_ADMIN", event: "DECLARATION_CORRECTION_APPROVED",
    declarationId: "DECL-AUDIT", requestId: "REQ-AUDIT", baseVersion: 1, resultingVersion: 2
  });
  assert.equal(entry.action, "DECLARATION_CORRECTION_APPROVED");
  assert.deepEqual(entry.newValues, { requestId: "REQ-AUDIT", declarationId: "DECL-AUDIT", baseVersion: 1, resultingVersion: 2 });
  assert.equal(Object.hasOwn(entry, "oldValues"), false);
  assert.equal(Object.hasOwn(entry, "signatureData"), false);
  assert.throws(() => require("../services/auditService").makeAuditDocument({
    actorId: "reviewer-id", role: "ART_BANK_ADMIN", event: "DECLARATION_CORRECTION_APPROVED",
    declarationId: "DECL-AUDIT", requestId: "REQ-AUDIT", proposedChanges: [{ field: "statement", value: "private" }]
  }), /unsupported or sensitive fields/);
  assert.throws(() => require("../services/auditService").makeAuditDocument({
    actorId: "reviewer-id", role: "ART_BANK_ADMIN", event: "DECLARATION_CORRECTION_APPROVED",
    declarationId: "DECL-AUDIT", requestId: "REQ-AUDIT", reason: "private"
  }), /unsupported or sensitive fields/);
  assert.throws(() => require("../services/auditService").makeAuditDocument({
    actorId: "reviewer-id", role: "ART_BANK_ADMIN", event: "DECLARATION_CORRECTION_APPROVED",
    declarationId: "DECL-AUDIT", requestId: "REQ-AUDIT", ip: { payload: "not metadata" }
  }), /ip must be a string/);
  for (const field of ["aadhaar", "aadhaarValue", "password", "token", "signatureData", "reason", "proposedChanges"]) {
    assert.throws(() => require("../services/auditService").makeAuditDocument({
      actorId: "reviewer-id", role: "ART_BANK_ADMIN", event: "DECLARATION_CORRECTION_APPROVED",
      declarationId: "DECL-AUDIT", requestId: "REQ-AUDIT", [field]: "private"
    }), /unsupported or sensitive fields/, field);
  }
  assert.throws(() => require("../services/auditService").makeAuditDocument({
    actorId: "reviewer-id", role: "ART_BANK_ADMIN", event: "DECLARATION_CORRECTION_APPROVED",
    declarationId: "DECL-AUDIT", requestId: "REQ-AUDIT", metadata: { nested: [{ signatureData: "private" }] }
  }), /unsupported or sensitive fields/);
});

test("audit service passes exactly the supplied session to AuditLog.create", async () => {
  const original = AuditLog.create;
  const session = { marker: "exact-session" };
  let observed;
  AuditLog.create = async (...args) => {
    observed = args;
    return [args[0][0]];
  };
  try {
    const result = await recordDeclarationCorrectionEvent({
      actorId: "reviewer-id", role: "SUPER_ADMIN", event: "DECLARATION_CORRECTION_SUBMITTED",
      declarationId: "DECL-SESSION", requestId: "REQ-SESSION", session
    });
    assert.equal(observed.length, 2);
    assert.equal(observed[1].session, session);
    assert.deepEqual(Object.keys(observed[1]), ["session"]);
    assert.equal(Object.hasOwn(observed[0][0], "session"), false);
    assert.equal(JSON.stringify(observed[0][0]).includes("exact-session"), false);
    assert.equal(result.entityId, "REQ-SESSION");
  } finally {
    AuditLog.create = original;
  }
});
