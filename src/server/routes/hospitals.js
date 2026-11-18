const router = require("../http/router").Router();
const User = require("../models/User");
const { requireAuth, allowRoles } = require("../middleware/auth");
const { getLinkedHospitalScopes } = require("../services/linkedHospitalScopeService");

router.get("/", requireAuth, allowRoles("SUPER_ADMIN", "ART_BANK_ADMIN", "ART_BANK_STAFF", "HOSPITAL_USER", "CHAIN_CEO"), async (req, res) => {
  try {
    const filter = { role: "HOSPITAL_USER", active: true, hospitalId: { $type: "string", $ne: "" }, centreId: { $type: "string", $ne: "" } };
    if (req.user.role === "HOSPITAL_USER") {
      if (!req.user.hospitalId || !req.user.centreId) return res.status(403).json({ success: false, message: "Hospital account has no assigned hospital/centre", errorCode: "HOSPITAL_SCOPE_MISSING" });
      filter.hospitalId = req.user.hospitalId;
      filter.centreId = req.user.centreId;
    } else if (req.user.role === "CHAIN_CEO") {
      filter.linkedCeoId = String(req.user.id);
    }
    const users = await User.find(filter).select("hospitalId hospitalName centreId centreName").lean();
    const hospitals = new Map();
    for (const user of users) {
      if (!hospitals.has(user.hospitalId)) hospitals.set(user.hospitalId, { name: user.hospitalName || user.hospitalId, centres: new Map() });
      const hospital = hospitals.get(user.hospitalId);
      if (!hospital.centres.has(user.centreId)) hospital.centres.set(user.centreId, user.centreName || user.centreId);
    }
    res.json({ success: true, data: [...hospitals].map(([hospitalId, hospital]) => ({ hospitalId, name: hospitalId, hospitalName: hospital.name, centres: [...hospital.centres].map(([centreId, centreName]) => ({ centreId, name: centreId, centreName })) })) });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to load hospital scopes", errorCode: "HOSPITALS_FETCH_ERROR" });
  }
});

module.exports = router;
