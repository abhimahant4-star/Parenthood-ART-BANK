const SENSITIVE_ATTACHMENT_CATEGORIES = Object.freeze(["IDENTITY_DOCUMENT", "DONOR_AADHAAR"]);

function applyStaffAttachmentScope(filter, user) {
  if (user?.role !== "ART_BANK_STAFF") return filter;

  const visibleCategories = { category: { $nin: SENSITIVE_ATTACHMENT_CATEGORIES } };
  const clauses = [visibleCategories];
  if (typeof user.username === "string" && user.username) clauses.push({ createdBy: user.username });
  filter.$or = clauses;
  return filter;
}

function applyHospitalAttachmentVisibility(filter, username) {
  const visible = [{ status: "SUBMITTED", category: { $ne: "DONOR_AADHAAR" } }];
  if (typeof username === "string" && username) {
    visible.push({ category: "IDENTITY_DOCUMENT", createdBy: username });
  }
  filter.$or = visible;
  return filter;
}

function applyAttachmentQueryFilters(filter, query = {}) {
  if (typeof query.relatedId === "string" && query.relatedId.trim()) {
    filter.relatedId = query.relatedId.trim().slice(0, 160);
  }
  if (typeof query.category === "string" && query.category.trim()) {
    filter.category = query.category.trim().slice(0, 64);
  }
  return filter;
}

module.exports = { SENSITIVE_ATTACHMENT_CATEGORIES, applyStaffAttachmentScope, applyHospitalAttachmentVisibility, applyAttachmentQueryFilters };
