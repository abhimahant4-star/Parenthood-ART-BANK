const router = require("../http/router").Router();
const { requireAuth, allowRoles } = require("../middleware/auth");
const Order = require("../models/Order");
const { minimizeHospitalOrder, minimizeCeoOrder } = require("../services/hospitalDataPrivacy");
const { getLinkedHospitalScopes, withLinkedHospitalScope } = require("../services/linkedHospitalScopeService");

router.get("/", requireAuth, allowRoles("SUPER_ADMIN", "ART_BANK_ADMIN", "ART_BANK_STAFF", "HOSPITAL_USER", "CHAIN_CEO"), async (req, res) => {
  try {
    const filter = {};
    if (req.user.role === "HOSPITAL_USER") {
      if (!req.user.hospitalId || !req.user.centreId) return res.status(403).json({ success: false, message: "Hospital account has no assigned hospital/centre", errorCode: "HOSPITAL_SCOPE_MISSING" });
      filter.hospitalId = req.user.hospitalId;
      filter.centreId = req.user.centreId;
    } else if (req.user.role === "CHAIN_CEO") {
      Object.assign(filter, withLinkedHospitalScope({}, await getLinkedHospitalScopes(req.user.id)));
    }
    const dispatchFilter = { ...filter, status: { $in: ["DISPATCHED", "RECEIVED"] } };
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 100, 1), 500);
    const skip = Math.min(Math.max(Number.parseInt(req.query.skip, 10) || 0, 0), 100000);
    const [dispatches, total] = await Promise.all([Order.find(dispatchFilter).sort({ dispatchedAt: -1, _id: -1 }).skip(skip).limit(limit).lean(), Order.countDocuments(dispatchFilter)]);
    res.json({
      success: true,
      data: req.user.role === "HOSPITAL_USER" ? dispatches.map(minimizeHospitalOrder) : req.user.role === "CHAIN_CEO" ? dispatches.map(minimizeCeoOrder) : dispatches,
      pagination: { skip, limit, total, hasMore: skip + dispatches.length < total }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to fetch dispatches", errorCode: "DISPATCHES_FETCH_ERROR" });
  }
});

module.exports = router;
