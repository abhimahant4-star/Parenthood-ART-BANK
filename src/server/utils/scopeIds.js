function scopeId(prefix, name) {
  const normalized = String(name || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  const slug = normalized.toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!slug) return null;
  return `${prefix}-${slug}`;
}

function scopeNameKey(name) {
  return String(name || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .toUpperCase();
}

function hasHospitalScopeNameCollision(existingUsers, proposed) {
  const proposedHospitalKey = scopeNameKey(proposed.hospitalName);
  const proposedCentreKey = scopeNameKey(proposed.centreName);
  return existingUsers.some(user => {
    if (user.hospitalId === proposed.hospitalId && user.hospitalName &&
        scopeId("HOSP", user.hospitalName) === proposed.hospitalId &&
        scopeNameKey(user.hospitalName) !== proposedHospitalKey) return true;
    return user.hospitalId === proposed.hospitalId && user.centreId === proposed.centreId &&
      user.centreName && scopeId("CENTRE", user.centreName) === proposed.centreId &&
      scopeNameKey(user.centreName) !== proposedCentreKey;
  });
}

module.exports = { scopeId, scopeNameKey, hasHospitalScopeNameCollision };
