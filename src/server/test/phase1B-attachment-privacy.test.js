"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { applyStaffAttachmentScope, applyHospitalAttachmentVisibility, applyAttachmentQueryFilters, SENSITIVE_ATTACHMENT_CATEGORIES } = require("../services/attachmentPrivacyService");

test("staff attachment reads include non-sensitive records and only their own identity documents", () => {
  const filter = applyStaffAttachmentScope({}, { role: "ART_BANK_STAFF", username: "staff-17" });
  assert.deepEqual(SENSITIVE_ATTACHMENT_CATEGORIES, ["IDENTITY_DOCUMENT", "DONOR_AADHAAR"]);
  assert.deepEqual(filter, {
    $or: [
      { category: { $nin: ["IDENTITY_DOCUMENT", "DONOR_AADHAAR"] } },
      { createdBy: "staff-17" }
    ]
  });
});

test("staff without a username cannot query sensitive attachments by uploader", () => {
  const filter = applyStaffAttachmentScope({ attachmentId: "ATT-TEST" }, { role: "ART_BANK_STAFF" });
  assert.deepEqual(filter, {
    attachmentId: "ATT-TEST",
    $or: [{ category: { $nin: ["IDENTITY_DOCUMENT", "DONOR_AADHAAR"] } }]
  });
});

test("admin, super admin and hospital attachment scopes are not changed by staff privacy filter", () => {
  for (const role of ["ART_BANK_ADMIN", "SUPER_ADMIN", "HOSPITAL_USER"]) {
    const original = { attachmentId: "ATT-TEST", hospitalId: "HOSP-TEST" };
    assert.equal(applyStaffAttachmentScope(original, { role, username: "user-1" }), original);
    assert.deepEqual(original, { attachmentId: "ATT-TEST", hospitalId: "HOSP-TEST" });
  }
});

test("hospital visibility excludes submitted donor Aadhaar scans but retains submitted files and own couple IDs", () => {
  const filter = applyHospitalAttachmentVisibility({ hospitalId: "HOSP-1", centreId: "CENTRE-1" }, "hospital-user");
  assert.deepEqual(filter, {
    hospitalId: "HOSP-1",
    centreId: "CENTRE-1",
    $or: [
      { status: "SUBMITTED", category: { $ne: "DONOR_AADHAAR" } },
      { category: "IDENTITY_DOCUMENT", createdBy: "hospital-user" }
    ]
  });
  const noUsernameFilter = applyHospitalAttachmentVisibility({}, undefined);
  assert.deepEqual(noUsernameFilter.$or, [{ status: "SUBMITTED", category: { $ne: "DONOR_AADHAAR" } }]);
});

test("attachment relatedId/category filters are exact, bounded and preserve staff privacy scope", () => {
  const filter = applyAttachmentQueryFilters(
    applyStaffAttachmentScope({}, { role: "ART_BANK_STAFF", username: "staff-17" }),
    { relatedId: " DONOR-123 ", category: " DONOR_AADHAAR " }
  );
  assert.equal(filter.relatedId, "DONOR-123");
  assert.equal(filter.category, "DONOR_AADHAAR");
  assert.deepEqual(filter.$or, [
    { category: { $nin: ["IDENTITY_DOCUMENT", "DONOR_AADHAAR"] } },
    { createdBy: "staff-17" }
  ]);

  const bounded = applyAttachmentQueryFilters({}, { relatedId: "x".repeat(200), category: "y".repeat(100) });
  assert.equal(bounded.relatedId.length, 160);
  assert.equal(bounded.category.length, 64);
});
