const router = require("../http/router").Router();
const { requireAuth, allowRoles } = require("../middleware/auth");
const Vial = require("../models/Vial");
const { getLinkedHospitalScopes, withLinkedHospitalScope } = require("../services/linkedHospitalScopeService");

router.get("/", requireAuth, allowRoles("SUPER_ADMIN", "ART_BANK_ADMIN", "ART_BANK_STAFF", "HOSPITAL_USER", "CHAIN_CEO"), async (req, res) => {
  try {
    let match = {};
    if (req.user.role === "HOSPITAL_USER") {
      if (!req.user.hospitalId || !req.user.centreId) return res.status(403).json({ success: false, message: "Hospital account has no assigned hospital/centre", errorCode: "HOSPITAL_SCOPE_MISSING" });
      match.hospitalId = req.user.hospitalId;
      match.centreId = req.user.centreId;
    } else if (req.user.role === "CHAIN_CEO") {
      match = withLinkedHospitalScope(match, await getLinkedHospitalScopes(req.user.id));
    }
    const groups = await Vial.aggregate([
      { $match: match },
      { $group: { _id: "$status", count: { $sum: 1 } } },
      { $sort: { _id: 1 } }
    ]);
    const total = groups.reduce((sum, item) => sum + item.count, 0);
    return res.json({ success: true, data: { total, byStatus: groups.map(item => ({ status: item._id, count: item.count })) } });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Failed to fetch stock summary", errorCode: "STOCK_FETCH_ERROR" });
  }
});

module.exports = router;
