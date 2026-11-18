const router = require("../http/router").Router();
const User = require("../models/User");
const { requireAuth, allowRoles } = require("../middleware/auth");

router.get("/", requireAuth, allowRoles("SUPER_ADMIN", "ART_BANK_ADMIN", "ART_BANK_STAFF", "HOSPITAL_USER"), async (req, res) => {
  try {
    let hospitalId = req.query.hospitalId;
    if (req.user.role === "HOSPITAL_USER") {
      if (!req.user.hospitalId || !req.user.centreId) return res.status(403).json({ success: false, message: "Hospital account has no assigned hospital/centre", errorCode: "HOSPITAL_SCOPE_MISSING" });
      return res.json({ success: true, data: [{ centreId: req.user.centreId, name: req.user.centreId }] });
    }
    if (!hospitalId) return res.status(400).json({ success: false, message: "hospitalId is required", errorCode: "HOSPITAL_ID_REQUIRED" });
    const centres = await User.distinct("centreId", { role: "HOSPITAL_USER", active: true, hospitalId, centreId: { $type: "string", $ne: "" } });
    res.json({ success: true, data: centres.sort().map(centreId => ({ centreId, name: centreId })) });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to load centre scopes", errorCode: "CENTRES_FETCH_ERROR" });
  }
});

module.exports = router;
