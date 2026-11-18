const router = require("../http/router").Router();
const { requireAuth, allowRoles } = require("../middleware/auth");

const Couple = require("../models/Couple");
const IdSequence = require("../models/IdSequence");
const crypto = require("crypto");
const { maskAadhaar, minimizeCoupleIdentity } = require("../services/privacyService");
const { formatCoupleId } = require("../services/coupleIdService");
const { withTransaction } = require("../services/transactionService");
const { recordOperationalEvent } = require("../services/operationalAuditService");

async function nextCoupleId() {
  const year = new Date().getUTCFullYear();
  const name = `couple-${year}`;
  await IdSequence.init();
  let sequence;
  try {
    sequence = await IdSequence.findOneAndUpdate(
      { name },
      { $inc: { value: 1 } },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    ).lean();
  } catch (error) {
    if (error?.code !== 11000) throw error;
    sequence = await IdSequence.findOneAndUpdate({ name }, { $inc: { value: 1 } }, { new: true }).lean();
    if (!sequence) throw error;
  }
  return formatCoupleId(year, sequence.value);
}

// GET ALL COUPLES
router.get(
  "/",
  requireAuth,
  allowRoles(
    "SUPER_ADMIN",
    "ART_BANK_ADMIN",
    "ART_BANK_STAFF",
    "HOSPITAL_USER"
  ),
  async (req, res) => {
    try {
      if (req.user.role === "CHAIN_CEO") {
        return res.status(403).json({ success: false, message: "Couple identity records are not available to chain users", errorCode: "FORBIDDEN" });
      }
      const filter = req.user.role === "HOSPITAL_USER"
        ? { hospitalId: req.user.hospitalId, centreId: req.user.centreId }
        : {};
      if (req.user.role === "HOSPITAL_USER" && (!req.user.hospitalId || !req.user.centreId)) return res.status(403).json({ success: false, message: "Hospital account has no assigned hospital/centre", errorCode: "HOSPITAL_SCOPE_MISSING" });
      const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 100, 1), 500);
      const skip = Math.min(Math.max(Number.parseInt(req.query.skip, 10) || 0, 0), 100000);
      const [couples, total] = await Promise.all([Couple.find(filter)
        .sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit), Couple.countDocuments(filter)]);

      res.json({
        success: true,
        data: couples.map(couple => minimizeCoupleIdentity(couple, req.user.role)),
        message: "Couples fetched successfully",
        pagination: { skip, limit, total, hasMore: skip + couples.length < total }
      });

    } catch (error) {
      console.error(error);

      res.status(500).json({
        success: false,
        message: "Failed to fetch couples",
        errorCode: "COUPLES_FETCH_ERROR"
      });
    }
  }
);

// CREATE COUPLE - HOSPITAL/CENTRE USER
router.post(
  "/",
  requireAuth,
  allowRoles("HOSPITAL_USER"),
  async (req, res) => {
    try {
      const {
        hospitalId,
        centreId,
        husband,
        wife
      } = req.body;

      if (!hospitalId || !centreId) {
        return res.status(400).json({
          success: false,
          message: "hospitalId and centreId are required",
          errorCode: "INVALID_COUPLE"
        });
      }

      // Hospital user can only create couples
      // for their own hospital/centre.
      if (
        !req.user.hospitalId || !req.user.centreId ||
        req.user.hospitalId !== hospitalId ||
        req.user.centreId !== centreId
      ) {
        return res.status(403).json({
          success: false,
          message: "You can only register couples for your own hospital and centre",
          errorCode: "HOSPITAL_SCOPE_DENIED"
        });
      }

      if (!husband || typeof husband.name !== "string" || !husband.name.trim()) {
        return res.status(400).json({
          success: false,
          message: "Husband name is required",
          errorCode: "HUSBAND_REQUIRED"
        });
      }

      if (!wife || typeof wife.name !== "string" || !wife.name.trim()) {
        return res.status(400).json({
          success: false,
          message: "Wife name is required",
          errorCode: "WIFE_REQUIRED"
        });
      }

      const identity = person => ({
        name: person.name.trim(),
        idType: typeof person.idType === "string" ? person.idType.trim() : "",
        idNumber: typeof person.idNumber === "string" ? person.idNumber.trim() : ""
      });
      const partners = { husband: identity(husband), wife: identity(wife) };
      for (const person of Object.values(partners)) {
        if (person.idNumber && !person.idType) {
          return res.status(400).json({
            success: false,
            message: "Select an identity document type for each entered number",
            errorCode: "IDENTITY_TYPE_REQUIRED"
          });
        }
        if (person.idType === "Aadhaar" && person.idNumber && !/^\d{1,12}$/.test(person.idNumber)) {
          return res.status(400).json({
            success: false,
            message: "Aadhaar numbers must contain 1 to 12 digits",
            errorCode: "INVALID_AADHAAR"
          });
        }
      }
      if (!Object.values(partners).some(person => person.idType === "Aadhaar" && person.idNumber)) {
        return res.status(400).json({
          success: false,
          message: "At least one partner's Aadhaar number is required",
          errorCode: "AADHAAR_REQUIRED"
        });
      }

      const coupleId = await nextCoupleId();
      const storedIdentity = person => {
        if (person.idType !== "Aadhaar" || !person.idNumber) return person;
        return {
          ...person,
          idNumber: maskAadhaar(person.idNumber),
          idNumberHash: crypto.createHash("sha256").update(person.idNumber).digest("hex")
        };
      };
      const couple = await withTransaction(async session => {
        const [created] = await Couple.create([{
          coupleId,
          hospitalId,
          centreId,
          husband: {
            ...storedIdentity(partners.husband),
            patientId: husband.patientId || null
          },
          wife: {
            ...storedIdentity(partners.wife),
            patientId: wife.patientId || null
          },
          status: "REGISTERED",
          mappedVialIds: []
        }], { session });
        await recordOperationalEvent({
          actorId: String(req.user.id), role: req.user.role, event: "COUPLE_CREATED", entityId: coupleId,
          metadata: { hospitalId, centreId, status: "REGISTERED" }, ip: req.ip, session
        });
        return created;
      });

      res.status(201).json({
        success: true,
        message: "Couple registered successfully",
        data: minimizeCoupleIdentity(couple, req.user.role)
      });

    } catch (error) {
      console.error(error);

      res.status(500).json({
        success: false,
        message: "Failed to register couple",
        errorCode: "COUPLE_CREATE_ERROR"
      });
    }
  }
);

// GET COUPLE BY ID
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

      res.json({
        success: true,
        data: minimizeCoupleIdentity(couple, req.user.role)
      });

    } catch (error) {
      console.error(error);

      res.status(500).json({
        success: false,
        message: "Failed to fetch couple",
        errorCode: "COUPLE_FETCH_ERROR"
      });
    }
  }
);

module.exports = router;
