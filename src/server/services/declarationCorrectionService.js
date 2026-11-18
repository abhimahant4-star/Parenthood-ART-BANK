const ALLOWED_REQUEST_FIELDS = new Set(["baseVersion", "reason", "proposedChanges"]);
const ALLOWED_CHANGE_FIELDS = new Set(["date", "statement"]);

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertOnlyKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter(key => !allowed.has(key));
  if (unknown.length) throw new TypeError(`${label} contains unsupported fields`);
}

function validateDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new TypeError("date must use YYYY-MM-DD format");
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new TypeError("date is invalid");
  return value;
}

function validateProposedChanges(changes) {
  if (!Array.isArray(changes) || changes.length === 0) throw new TypeError("At least one proposed change is required");
  const seen = new Set();
  return changes.map(change => {
    if (!isPlainObject(change)) throw new TypeError("Each proposed change must be an object");
    assertOnlyKeys(change, new Set(["field", "value"]), "proposed change");
    if (!ALLOWED_CHANGE_FIELDS.has(change.field)) throw new TypeError("Only date and statement may be changed");
    if (seen.has(change.field)) throw new TypeError("proposedChanges cannot contain duplicate fields");
    seen.add(change.field);
    if (change.field === "date") return { field: "date", value: validateDate(change.value) };
    if (typeof change.value !== "string" || !change.value.trim()) throw new TypeError("statement must be a non-empty string");
    // The existing application has no statement length limit; do not add one here.
    return { field: "statement", value: change.value };
  });
}

function validateCorrectionRequest(input) {
  if (!isPlainObject(input)) throw new TypeError("Correction request must be an object");
  assertOnlyKeys(input, ALLOWED_REQUEST_FIELDS, "Correction request");
  if (!Number.isInteger(input.baseVersion) || input.baseVersion < 1) throw new TypeError("baseVersion must be a positive integer");
  if (typeof input.reason !== "string" || !input.reason.trim()) throw new TypeError("reason is required");
  return {
    baseVersion: input.baseVersion,
    reason: input.reason.trim(),
    proposedChanges: validateProposedChanges(input.proposedChanges)
  };
}

function validateReviewReason(reason) {
  if (typeof reason !== "string" || !reason.trim()) throw new TypeError("review reason is required");
  return reason.trim();
}

module.exports = { validateCorrectionRequest, validateProposedChanges, validateReviewReason };
