const router = require("../http/router").Router();

const { requireAuth, allowRoles } = require("../middleware/auth");
const Vial = require("../models/Vial");
const Couple = require("../models/Couple");
const { withTransaction, RouteError, sendRouteError } = require("../services/transactionService");
const { minimizeCoupleIdentity } = require("../services/privacyService");
const { recordOperationalEvent } = require("../services/operationalAuditService");
const { publicErrorMessage } = require("../services/errorResponseService");
const { minimizeHospitalVial } = require("../services/hospitalDataPrivacy");


// =====================================================
// MAP VIAL TO COUPLE
// POST /api/mappings
// =====================================================
router.post(
  "/",
  requireAuth,
  allowRoles("HOSPITAL_USER"),
  async (req, res) => {
    try {
      if (!req.user.hospitalId || !req.user.centreId) return res.status(403).json({ success: false, message: "Hospital account has no assigned hospital/centre", errorCode: "HOSPITAL_SCOPE_MISSING" });
      const { coupleId, vialId } = req.body;

      if (!coupleId || !vialId) {
        return res.status(400).json({
          success: false,
          message: "coupleId and vialId are required",
          errorCode: "MAPPING_DATA_REQUIRED"
        });
      }

      const mappedAt = new Date();
      const { couple, vial } = await withTransaction(async session => {
        const currentCouple = await Couple.findOne({
          coupleId, hospitalId: req.user.hospitalId, centreId: req.user.centreId
        }).session(session);
        if (!currentCouple) {
          // Keep the historical distinction in the response without loading
          // an out-of-scope couple record into the request workflow.
          const exists = await Couple.exists({ coupleId }).session(session);
          if (exists) throw new RouteError(404, "Couple not found", "HOSPITAL_SCOPE_DENIED");
          throw new RouteError(404, "Couple not found", "COUPLE_NOT_FOUND");
        }

        const currentVial = await Vial.findOne({
          vialId, hospitalId: req.user.hospitalId, centreId: req.user.centreId
        }).session(session);
        if (!currentVial) throw new RouteError(404, "Vial not found", "VIAL_NOT_FOUND");
        if (currentVial.status !== "UNUSED_AT_HOSPITAL") {
          throw new RouteError(400, `Vial cannot be mapped in current status: ${currentVial.status}`, "VIAL_NOT_MAPPABLE");
        }
        if (currentCouple.mappedVialIds.includes(vialId)) {
          throw new RouteError(409, "Vial is already mapped to this couple", "VIAL_ALREADY_MAPPED");
        }
        const alreadyMapped = await Couple.findOne({ mappedVialIds: vialId }).session(session);
        if (alreadyMapped) throw new RouteError(409, "Vial is already mapped to another couple", "VIAL_ALREADY_MAPPED");

        const coupleClaim = await Couple.updateOne(
          { _id: currentCouple._id, mappedVialIds: { $ne: vialId } },
          { $addToSet: { mappedVialIds: vialId }, $set: { status: "ACTIVE" } },
          { session }
        );
        if (coupleClaim.matchedCount !== 1) throw new RouteError(409, "Vial is already mapped to this couple", "VIAL_ALREADY_MAPPED");

        const vialClaim = await Vial.updateOne(
          { _id: currentVial._id, status: "UNUSED_AT_HOSPITAL", hospitalId: req.user.hospitalId, centreId: req.user.centreId },
          [{
            $set: {
              status: "MAPPED_USED",
              statusHistory: {
                $concatArrays: [
                  { $cond: [{ $isArray: "$statusHistory" }, "$statusHistory", []] },
                  [{ status: "MAPPED_USED", at: mappedAt, by: req.user.username, coupleId: currentCouple.coupleId }]
                ]
              }
            }
          }],
          { session }
        );
        if (vialClaim.matchedCount !== 1) throw new RouteError(400, `Vial cannot be mapped in current status: ${currentVial.status}`, "VIAL_NOT_MAPPABLE");

        const updatedCouple = await Couple.findById(currentCouple._id).session(session);
        const updatedVial = await Vial.findById(currentVial._id).session(session);
        await recordOperationalEvent({
          actorId: String(req.user.id), role: req.user.role, event: "VIAL_MAPPED", entityId: updatedVial.vialId,
          metadata: { status: "MAPPED_USED", coupleId: updatedCouple.coupleId, hospitalId: updatedCouple.hospitalId, centreId: updatedCouple.centreId }, ip: req.ip, session
        });
        return { couple: updatedCouple, vial: updatedVial };
      });

      return res.status(201).json({
        success: true,
        message: "Vial mapped to couple successfully",
        data: {
          coupleId: couple.coupleId,
          vialId: vial.vialId,
          coupleStatus: couple.status,
          vialStatus: vial.status
        }
      });

    } catch (e) {
      if (e instanceof RouteError) return sendRouteError(res, e, { message: "Mapping failed", errorCode: "MAPPING_ERROR" });
      console.error(e);
      return res.status(500).json({ success: false, message: publicErrorMessage(e, "Mapping failed"), errorCode: "MAPPING_ERROR" });
    }
  }
);


// =====================================================
// GET MAPPINGS FOR A COUPLE
// GET /api/mappings/:coupleId
// =====================================================
router.get(
  "/:coupleId",
  requireAuth,
  allowRoles(
    "SUPER_ADMIN",
    "ART_BANK_ADMIN",
    "ART_BANK_STAFF",
    "HOSPITAL_USER"
  ),
  async (req, res) => {
    try {
      if (req.user.role === "HOSPITAL_USER" && (!req.user.hospitalId || !req.user.centreId)) return res.status(403).json({ success: false, message: "Hospital account has no assigned hospital/centre", errorCode: "HOSPITAL_SCOPE_MISSING" });
      const coupleFilter = { coupleId: req.params.coupleId };
      if (req.user.role === "HOSPITAL_USER") Object.assign(coupleFilter, { hospitalId: req.user.hospitalId, centreId: req.user.centreId });
      const couple = await Couple.findOne(coupleFilter);

      if (!couple) {
        return res.status(404).json({
          success: false,
          message: "Couple not found",
          errorCode: "COUPLE_NOT_FOUND"
        });
      }

      const vials = await Vial.find({
        vialId: { $in: couple.mappedVialIds || [] },
        hospitalId: couple.hospitalId,
        centreId: couple.centreId
      });
      const responseVials = req.user.role === "HOSPITAL_USER"
        ? vials.map(minimizeHospitalVial)
        : vials;

      return res.json({
        success: true,
        data: {
          couple: minimizeCoupleIdentity(couple, req.user.role),
          vials: responseVials
        }
      });

    } catch (e) {
      console.error(e);

      return res.status(500).json({
        success: false,
        message: publicErrorMessage(e, "Failed to fetch mappings"),
        errorCode: "MAPPING_FETCH_ERROR"
      });
    }
  }
);


module.exports = router;
