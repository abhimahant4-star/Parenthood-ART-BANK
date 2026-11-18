"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { projectAuditLog, projectAuditValues } = require("../services/auditPrivacyService");
const { makeOperationalAuditDocument } = require("../services/operationalAuditService");

test("donor creation audit accepts the model's title-case Active status", () => {
  const event = makeOperationalAuditDocument({
    actorId: "actor-fixture",
    role: "ART_BANK_STAFF",
    event: "DONOR_CREATED",
    entityId: "DONOR-FIXTURE",
    metadata: { status: "Active" }
  });
  assert.deepEqual(event.newValues, { status: "Active" });
});

test("audit response omits historical payloads and derives summary from the event", () => {
  const projected = projectAuditLog({
    _id: "audit-fixture",
    userId: "actor-fixture",
    role: "ART_BANK_STAFF",
    action: "DONOR_UPDATED",
    entity: "Donor",
    entityId: "DONOR-FIXTURE",
    summary: "sensitive free-text summary",
    oldValues: { aadhaar: "not-for-response", password: "not-for-response" },
    newValues: { status: "Active", aadhaar: "not-for-response", proposedChanges: [{ field: "name", value: "not-for-response" }] },
    createdAt: new Date("2026-01-01T00:00:00Z")
  });
  assert.equal(projected.summary, "donor updated");
  assert.deepEqual(projected.newValues, { status: "Active" });
  assert.equal(Object.hasOwn(projected, "oldValues"), false);
  assert.equal(JSON.stringify(projected).includes("not-for-response"), false);
});

test("audit response retains safe scalar metadata and rejects nested or invalid values", () => {
  assert.deepEqual(projectAuditValues({
    status: "RELEASED", count: 12, active: true, hospitalId: "HOSP-1",
    reason: "not allowed", signatureData: "not allowed", payload: { nested: true }, version: "2"
  }), { status: "RELEASED", count: 12, active: true, hospitalId: "HOSP-1" });
  assert.equal(projectAuditValues({ reason: "only" }), undefined);
  assert.equal(projectAuditValues([{ status: "RELEASED" }]), undefined);
});

test("malformed audit identifiers and event names are replaced with safe empty values", () => {
  const projected = projectAuditLog({ action: "login failed with sensitive detail", entityId: "contains spaces and details", role: "unknown" });
  assert.equal(projected.action, "AUDIT_EVENT");
  assert.equal(projected.summary, "audit event");
  assert.equal(projected.entityId, "");
  assert.equal(projected.role, "");
});
