const { test } = require("node:test");
const assert = require("node:assert/strict");
const versions = require("../services/declarationVersionService");
const corrections = require("../services/declarationCorrectionService");
const { makeAuditDocument } = require("../services/auditService");
const { sessionVersionMatches } = require("../middleware/auth");
const { csvCell, csvFromRecords } = require("../services/csvService");
const { minimizeCoupleIdentity } = require("../services/privacyService");
const { makeOperationalAuditDocument, recordOperationalEvent } = require("../services/operationalAuditService");
const AuditLog = require("../models/AuditLog");
const { publicErrorMessage } = require("../services/errorResponseService");
const { formatCoupleId } = require("../services/coupleIdService");

test("legacy signatures remain version one and are not current after declaration version advances", () => {
  const legacySignature = { declarationId: "DECL-UNIT" };
  assert.equal(versions.getEffectiveSignatureVersion(legacySignature), 1);
  assert.equal(versions.isSignatureCurrentForDeclaration(legacySignature, { currentVersion: 1 }), true);
  assert.equal(versions.isSignatureCurrentForDeclaration(legacySignature, { currentVersion: 2 }), false);
});

test("couple IDs are short, year-scoped and sequential", () => {
  assert.equal(formatCoupleId(2026, 1), "CASE-2026-0001");
  assert.equal(formatCoupleId(2026, 10000), "CASE-2026-10000");
  assert.throws(() => formatCoupleId(1999, 1), RangeError);
  assert.throws(() => formatCoupleId(2026, 0), RangeError);
});

test("correction request validation admits only date and statement fields", () => {
  const valid = corrections.validateCorrectionRequest({
    baseVersion: 1,
    reason: "Correction reason",
    proposedChanges: [{ field: "date", value: "2028-02-29" }, { field: "statement", value: "Updated statement" }]
  });
  assert.equal(valid.proposedChanges.length, 2);
  for (const value of ["2027-02-29", "2028/02/29", 20280229]) {
    assert.throws(() => corrections.validateCorrectionRequest({ ...valid, proposedChanges: [{ field: "date", value }] }));
  }
});

test("signature-created audit event excludes signature contents and permits no correction request id", () => {
  const audit = makeAuditDocument({
    actorId: "test-actor", role: "HOSPITAL_USER", event: "DECLARATION_SIGNATURE_CREATED",
    declarationId: "DECL-UNIT", baseVersion: 2, ip: "127.0.0.1"
  });
  assert.equal(audit.action, "DECLARATION_SIGNATURE_CREATED");
  assert.equal(audit.entity, "Signature");
  assert.equal(audit.entityId, "DECL-UNIT");
  assert.equal(JSON.stringify(audit).includes("signatureData"), false);
  assert.throws(() => makeAuditDocument({
    actorId: "test-actor", role: "HOSPITAL_USER", event: "DECLARATION_SIGNATURE_CREATED",
    declarationId: "DECL-UNIT", baseVersion: 2, signatureData: "sensitive"
  }), /unsupported or sensitive fields/);
});

test("signature invalidation audit event is linked to the correction request without signature payload", () => {
  const audit = makeAuditDocument({
    actorId: "test-reviewer", role: "ART_BANK_ADMIN", event: "DECLARATION_SIGNATURE_INVALIDATED",
    declarationId: "DECL-UNIT", requestId: "DCR-UNIT", baseVersion: 1, resultingVersion: 2
  });
  assert.equal(audit.action, "DECLARATION_SIGNATURE_INVALIDATED");
  assert.equal(audit.entity, "Signature");
  assert.equal(audit.entityId, "DCR-UNIT");
  assert.equal(audit.newValues.requestId, "DCR-UNIT");
  assert.throws(() => makeAuditDocument({
    actorId: "test-reviewer", role: "ART_BANK_ADMIN", event: "DECLARATION_SIGNATURE_INVALIDATED",
    declarationId: "DECL-UNIT", baseVersion: 1
  }), /requestId is required/);
  assert.throws(() => makeAuditDocument({
    actorId: "test-reviewer", role: "ART_BANK_ADMIN", event: "DECLARATION_SIGNATURE_INVALIDATED",
    declarationId: "DECL-UNIT", requestId: "DCR-UNIT", signatureData: "sensitive"
  }), /unsupported or sensitive fields/);
  assert.equal(JSON.stringify(audit).includes("signatureData"), false);
});

test("legacy tokens without a session version are rejected after session-version enforcement", () => {
  assert.equal(sessionVersionMatches(undefined, 1), false);
  assert.equal(sessionVersionMatches(1, undefined), true);
  assert.equal(sessionVersionMatches(1, 1), true);
  assert.equal(sessionVersionMatches(1, 2), false);
  assert.equal(sessionVersionMatches("2", 2), false);
});

test("production error responses hide internal exception messages but development retains diagnostics", () => {
  const internal = new Error("database connection detail");
  assert.equal(publicErrorMessage(internal, "Request failed", true), "Request failed");
  assert.equal(publicErrorMessage(internal, "Request failed", false), "database connection detail");
  assert.equal(publicErrorMessage(null, "Request failed", false), "Request failed");
});

test("CSV exports quote values and neutralize formula-leading cells including whitespace prefixes", () => {
  for (const formula of ["=1+1", "+1+1", "-1+1", "@SUM(A1:A2)", "  =1+1", "\t=1+1", "\r=1+1"]) {
    const cell = csvCell(formula);
    assert.equal(cell.startsWith("\"'"), true, JSON.stringify(formula));
  }
  assert.equal(csvCell("ordinary,\"text\""), '"ordinary,""text"""');
  const csv = csvFromRecords([{ field: "=HYPERLINK(\"x\")" }], ["field"]);
  assert.equal(csv.includes("'="), true);
  assert.equal(csv.charCodeAt(0), 0xfeff);
});

test("bank admin and staff API projections omit couple identity fields while hospital and super admin retain them", () => {
  const couple = { coupleId: "CASE-1", husband: { name: "A", idNumber: "private" }, wife: { name: "B", idNumber: "private" } };
  for (const role of ["ART_BANK_ADMIN", "ART_BANK_STAFF"]) {
    const result = minimizeCoupleIdentity(couple, role);
    assert.equal(Object.hasOwn(result, "husband"), false);
    assert.equal(Object.hasOwn(result, "wife"), false);
  }
  assert.equal(minimizeCoupleIdentity(couple, "HOSPITAL_USER").husband.idNumber, "private");
  assert.equal(minimizeCoupleIdentity(couple, "SUPER_ADMIN").wife.idNumber, "private");
  assert.equal(couple.husband.idNumber, "private");

  const aadhaar = "123456789012";
  const aadhaarCouple = {
    coupleId: "CASE-AADHAAR",
    husband: { idType: "Aadhaar", idNumber: aadhaar, idNumberHash: "private-hash" },
    wife: { idType: "Aadhaar", idNumber: "12••••••••90", idNumberHash: "private-hash" }
  };
  const hospitalProjection = minimizeCoupleIdentity(aadhaarCouple, "HOSPITAL_USER");
  assert.equal(hospitalProjection.husband.idNumber, "12••••••••12");
  assert.equal(hospitalProjection.wife.idNumber, "12••••••••90");
  assert.equal(Object.hasOwn(hospitalProjection.husband, "idNumberHash"), false);
  assert.equal(Object.hasOwn(hospitalProjection.wife, "idNumberHash"), false);
  assert.equal(aadhaarCouple.husband.idNumber, aadhaar);
  const shortAadhaarProjection = minimizeCoupleIdentity({
    husband: { idType: "Aadhaar", idNumber: "1234" }
  }, "HOSPITAL_USER");
  assert.equal(shortAadhaarProjection.husband.idNumber, "••••");
});

test("operational audit accepts safe allowlisted metadata and rejects payload-like fields", () => {
  const document = makeOperationalAuditDocument({
    actorId: "test-user", role: "ART_BANK_ADMIN", event: "BATCH_RELEASED", entityId: "BATCH-TEST",
    metadata: { previousStatus: "QUARANTINED", status: "RELEASED", count: 4 }
  });
  assert.equal(document.action, "BATCH_RELEASED");
  assert.deepEqual(document.newValues, { previousStatus: "QUARANTINED", status: "RELEASED", count: 4 });
  const userEvent = makeOperationalAuditDocument({ actorId: "test-user", role: "SUPER_ADMIN", event: "USER_CREATED", entityId: "USER-1", metadata: { assignedRole: "HOSPITAL_USER", active: true } });
  assert.deepEqual(userEvent.newValues, { assignedRole: "HOSPITAL_USER", active: true });
  const bankDispatchEvent = makeOperationalAuditDocument({
    actorId: "test-user", role: "SUPER_ADMIN", event: "BANK_DISPATCH_ORDER_CREATED",
    entityId: "ORD-TEST", metadata: { status: "PENDING", count: 1, hospitalId: "HOSP-1", centreId: "CENTRE-1" }
  });
  assert.equal(bankDispatchEvent.entity, "Order");
  assert.equal(bankDispatchEvent.action, "BANK_DISPATCH_ORDER_CREATED");
  const attachmentEvent = makeOperationalAuditDocument({
    actorId: "test-user", role: "HOSPITAL_USER", event: "ATTACHMENT_UPLOADED",
    entityId: "ATT-TEST", metadata: {
      attachmentId: "ATT-TEST", hospitalId: "HOSP-1", centreId: "CENTRE-1",
      category: "IDENTITY_DOCUMENT", relatedId: "CASE-2026-0001", count: 1
    }
  });
  assert.deepEqual(attachmentEvent.newValues.category, "IDENTITY_DOCUMENT");
  assert.throws(() => makeOperationalAuditDocument({
    actorId: "test-user", role: "HOSPITAL_USER", event: "ATTACHMENT_UPLOADED",
    entityId: "ATT-TEST", metadata: { category: "UNRECOGNIZED_DOCUMENT" }
  }), /category is invalid/);
  for (const metadata of [
    { reason: "private" }, { proposedChanges: [{ field: "statement", value: "private" }] },
    { aadhaar: "private" }, { signatureData: "private" }, { password: "private" }, { details: { nested: true } }
  ]) {
    assert.throws(() => makeOperationalAuditDocument({ actorId: "u", role: "SUPER_ADMIN", event: "DONOR_CREATED", entityId: "DONOR-X", metadata }), /unsupported or sensitive/);
  }
});

test("signer lifecycle audit events allow version/status metadata without image contents", () => {
  const created = makeOperationalAuditDocument({ actorId: "test-user", role: "SUPER_ADMIN", event: "SIGNER_CREATED", entityId: "SIGNER-TEST", metadata: { version: 1 } });
  const updated = makeOperationalAuditDocument({ actorId: "test-user", role: "SUPER_ADMIN", event: "SIGNER_UPDATED", entityId: "SIGNER-TEST", metadata: { version: 2 } });
  const status = makeOperationalAuditDocument({ actorId: "test-user", role: "SUPER_ADMIN", event: "SIGNER_STATUS_CHANGED", entityId: "SIGNER-TEST", metadata: { previousStatus: "ACTIVE", status: "INACTIVE", version: 3 } });
  assert.deepEqual(created.newValues, { version: 1 });
  assert.deepEqual(updated.newValues, { version: 2 });
  assert.deepEqual(status.newValues, { previousStatus: "ACTIVE", status: "INACTIVE", version: 3 });
  for (const event of [created, updated, status]) assert.equal(JSON.stringify(event).includes("storageName"), false);
  assert.throws(() => makeOperationalAuditDocument({ actorId: "test-user", role: "SUPER_ADMIN", event: "SIGNER_UPDATED", entityId: "SIGNER-TEST", metadata: { version: 2, signatureData: "private" } }), /unsupported or sensitive/);
});

test("login audit events contain no credentials or session tokens", () => {
  for (const event of ["LOGIN_SUCCESS", "LOGIN_BLOCKED_ACTIVE_SESSION", "SESSION_REPLACED"]) {
    const document = makeOperationalAuditDocument({ actorId: "test-user", role: "HOSPITAL_USER", event, entityId: "test-user-id" });
    assert.equal(document.action, event);
    assert.equal(document.entity, "AUTH");
    assert.equal(Object.hasOwn(document, "sessionId"), false);
    assert.equal(Object.hasOwn(document, "password"), false);
  }
});

test("operational audit forwards the exact transaction session without persisting it", async () => {
  const original = AuditLog.create;
  const session = { marker: "transaction-session" };
  let captured;
  AuditLog.create = async (...args) => { captured = args; return [args[0][0]]; };
  try {
    await recordOperationalEvent({ actorId: "actor-1", role: "SUPER_ADMIN", event: "USER_CREATED", entityId: "user-1", metadata: { assignedRole: "ART_BANK_STAFF" }, session });
  } finally {
    AuditLog.create = original;
  }
  assert.equal(captured[1].session, session);
  assert.equal(Object.hasOwn(captured[0][0], "session"), false);
});

test("AuditLog query and bulk write mutation paths reject writes without database access", async () => {
  const operations = [
    () => AuditLog.updateOne({ _id: "audit-test" }, { $set: { action: "changed" } }).exec(),
    () => AuditLog.updateMany({}, { $set: { action: "changed" } }).exec(),
    () => AuditLog.findOneAndUpdate({}, { $set: { action: "changed" } }).exec(),
    () => AuditLog.replaceOne({}, {}).exec(),
    () => AuditLog.deleteOne({ _id: "audit-test" }).exec(),
    () => AuditLog.deleteMany({ _id: "audit-test" }).exec(),
    () => AuditLog.findOneAndDelete({ _id: "audit-test" }).exec(),
    () => AuditLog.bulkWrite([{ updateOne: { filter: { _id: "audit-test" }, update: { $set: { action: "changed" } } } }])
  ];
  for (const operation of operations) await assert.rejects(operation, /append-only/);
  const document = new AuditLog({ action: "UNIT_TEST" });
  await assert.rejects(document.deleteOne(), /append-only/);
});
