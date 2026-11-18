const User = require("../models/User");

async function getLinkedHospitalScopes(ceoUserId) {
  if (!ceoUserId) return [];
  const users = await User.find({
    role: "HOSPITAL_USER",
    active: true,
    linkedCeoId: String(ceoUserId),
    hospitalId: { $type: "string", $ne: "" },
    centreId: { $type: "string", $ne: "" }
  }).select("hospitalId hospitalName centreId centreName").lean();
  const scopes = new Map();
  for (const user of users) {
    const key = `${user.hospitalId}\u0000${user.centreId}`;
    if (!scopes.has(key)) scopes.set(key, {
      hospitalId: user.hospitalId,
      hospitalName: user.hospitalName || user.hospitalId,
      centreId: user.centreId,
      centreName: user.centreName || user.centreId
    });
  }
  return [...scopes.values()];
}

function linkedHospitalScopeQuery(scopes) {
  if (!scopes.length) return { hospitalId: { $in: [] } };
  return {
    $or: scopes.map(({ hospitalId, centreId }) => ({ hospitalId, centreId }))
  };
}

function withLinkedHospitalScope(query, scopes) {
  return { $and: [query, linkedHospitalScopeQuery(scopes)] };
}

module.exports = { getLinkedHospitalScopes, linkedHospitalScopeQuery, withLinkedHospitalScope };
