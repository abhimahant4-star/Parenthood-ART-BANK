const IDENTITY_RESTRICTED_ROLES = new Set(["ART_BANK_ADMIN", "ART_BANK_STAFF"]);

function maskAadhaar(value) {
  if (typeof value !== "string" || !/^\d{1,12}$/.test(value)) return value;
  return value.length > 4
    ? `${value.slice(0, 2)}${"•".repeat(value.length - 4)}${value.slice(-2)}`
    : "•".repeat(value.length);
}

function sanitizeIdentity(person) {
  if (!person) return person;
  const result = { ...person };
  delete result.idNumberHash;
  if (result.idType === "Aadhaar") result.idNumber = maskAadhaar(result.idNumber);
  return result;
}

function minimizeCoupleIdentity(couple, role) {
  if (!couple) return couple;
  const result = typeof couple.toObject === "function" ? couple.toObject() : { ...couple };
  if (IDENTITY_RESTRICTED_ROLES.has(role)) {
    delete result.husband;
    delete result.wife;
  } else {
    result.husband = sanitizeIdentity(result.husband);
    result.wife = sanitizeIdentity(result.wife);
  }
  return result;
}

module.exports = { maskAadhaar, minimizeCoupleIdentity };
