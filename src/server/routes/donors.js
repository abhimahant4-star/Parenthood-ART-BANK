const router = require("../http/router").Router();
const { requireAuth, allowRoles } = require("../middleware/auth");
const Donor = require("../models/Donor");
const Batch = require("../models/Batch");
const Vial = require("../models/Vial");
const crypto = require("crypto");
const { withTransaction, sendRouteError } = require("../services/transactionService");
const { deleteDonor } = require("../services/recordAdminService");
const Attachment = require("../models/Attachment");
const { deletePrivateFile } = require("../middleware/privateUpload");
const { recordOperationalEvent } = require("../services/operationalAuditService");

// Quick-pick heights use feet.inches notation (for example, 5.8 means 5 ft 8 in).
// Historical height strings remain valid for backward compatibility.
const STANDARD_HEIGHTS = ["5.6 ft", "5.7 ft", "5.8 ft", "5.9 ft", "5.10 ft", "5.11 ft", "6.0 ft"];
const isFeetInchesHeight = value => /^\d+\.(?:[0-9]|1[01])\s*ft$/i.test(value);

const UHID_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const makeUhid = () => Array.from({ length: 5 }, () => UHID_ALPHABET[crypto.randomInt(UHID_ALPHABET.length)]).join("");
const DONOR_STATUSES = ["Active", "Inactive", "Retired"];
const INACTIVE_STATUSES = ["Inactive", "Retired"];
const VIRAL_RESULTS = ["NON_REACTIVE", "REACTIVE", "PENDING"];
const SCREENING_RESULTS = {
  hiv: VIRAL_RESULTS, hbsag: VIRAL_RESULTS, hcv: VIRAL_RESULTS, vdrl: VIRAL_RESULTS,
  thalassemia: ["NORMAL", "CARRIER", "PENDING"], karyotype: ["NORMAL", "ABNORMAL", "PENDING"]
};
const AuditLog = require("../models/AuditLog");
const { withTraceSummary, donorListFilter } = require("../services/donorTraceService");
const { flexibleIdPattern } = require("../utils/flexibleSearch");

async function recordDonorAudit(req, action, donorId, summary, newValues) {
  await AuditLog.create({ userId: String(req.user.id), role: req.user.role, action, entity: "DONOR", entityId: donorId, summary, ip: req.ip, newValues });
}

const escapeRegex = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const ageOn = (dob, today = new Date()) => {
  let age = today.getUTCFullYear() - dob.getUTCFullYear();
  const birthdayPassed = today.getUTCMonth() > dob.getUTCMonth() || (today.getUTCMonth() === dob.getUTCMonth() && today.getUTCDate() >= dob.getUTCDate());
  return birthdayPassed ? age : age - 1;
};

// =====================================================
// GET ALL DONORS
// =====================================================

router.get("/unit-search", requireAuth, allowRoles("SUPER_ADMIN", "ART_BANK_ADMIN", "ART_BANK_STAFF"), async (req, res) => {
  const query = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 64) : "";
  if (!query) return res.json({ success: true, data: [] });
  try {
    // The collection picker matches from the start of an ID, ignoring dashes and slashes.
    const pattern = flexibleIdPattern(query, { prefix: true });
    const namePattern = new RegExp(`^${escapeRegex(query)}`, "i");
    const donors = await Donor.find({
      status: { $nin: INACTIVE_STATUSES },
      $or: [{ unitNumber: pattern }, { uhid: pattern }, { manualDonorId: pattern }, { donorId: pattern }, { name: namePattern }]
    })
      .select("donorId uhid manualDonorId unitNumber name bloodGroup lastCollectionAt")
      .sort({ donorId: 1 }).limit(20).lean();
    const latestBatches = await Batch.aggregate([
      { $match: { "donor.donorId": { $in: donors.map(donor => donor.donorId) } } },
      { $sort: { collectionAt: -1 } },
      { $group: { _id: "$donor.donorId", collectionAt: { $first: "$collectionAt" } } }
    ]);
    const latestByDonor = new Map(latestBatches.map(batch => [batch._id, batch.collectionAt]));
    return res.json({ success: true, data: donors.map(donor => ({
      donorId: donor.donorId,
      uhid: donor.uhid,
      manualDonorId: donor.manualDonorId,
      unitNumber: donor.unitNumber,
      name: donor.name,
      bloodGroup: donor.bloodGroup,
      lastCollectionAt: [donor.lastCollectionAt, latestByDonor.get(donor.donorId)].filter(Boolean).sort((a, b) => new Date(b) - new Date(a))[0] || null
    })) });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Failed to search donors by Unit Number", errorCode: "DONOR_UNIT_SEARCH_ERROR" });
  }
});

router.get("/available-stock", requireAuth, allowRoles("SUPER_ADMIN", "ART_BANK_ADMIN", "ART_BANK_STAFF"), async (req, res) => {
  try {
    const now = new Date();
    const available = await Vial.aggregate([
      { $match: { status: "AVAILABLE_AT_ART_BANK", quarantineEnd: { $lte: now }, donorId: { $type: "string", $ne: "" } } },
      { $group: { _id: { donorId: "$donorId", bloodGroup: "$bloodGroup" }, count: { $sum: 1 } } },
      { $group: { _id: "$_id.donorId", availableVialCount: { $sum: "$count" }, bloodGroups: { $push: { bloodGroup: "$_id.bloodGroup", count: "$count" } } } }
    ]);
    const donorIds = available.map(item => item._id);
    const donors = await Donor.find({ donorId: { $in: donorIds }, status: { $nin: INACTIVE_STATUSES } })
      .select("donorId uhid manualDonorId name bloodGroup height complexion eyeColour hairColour build")
      .sort({ name: 1, donorId: 1 }).lean();
    const stockByDonor = new Map(available.map(item => [item._id, item]));
    res.json({ success: true, data: donors.map(donor => ({
      ...donor,
      availableVialCount: stockByDonor.get(donor.donorId)?.availableVialCount || 0,
      bloodGroups: stockByDonor.get(donor.donorId)?.bloodGroups || []
    })) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: "Failed to fetch donors with released stock", errorCode: "AVAILABLE_DONORS_FETCH_ERROR" });
  }
});

router.get(
  "/",
  requireAuth,
  allowRoles("SUPER_ADMIN", "ART_BANK_ADMIN", "ART_BANK_STAFF"),
  async (req, res) => {
    try {
      const filter = donorListFilter(req.query);
      const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 100, 1), 500);
      const skip = Math.min(Math.max(Number.parseInt(req.query.skip, 10) || 0, 0), 100000);
      const [donors, total] = await Promise.all([Donor.find(filter)
        .select("-aadhaarHash")
        .sort({ createdAt: -1, _id: -1 })
        .skip(skip).limit(limit).lean(), Donor.countDocuments(filter)]);

      res.json({
        success: true,
        data: await withTraceSummary(donors),
        pagination: { skip, limit, total, hasMore: skip + donors.length < total }
      });
    } catch (error) {
      console.error(error);

      res.status(500).json({
        success: false,
        message: "Failed to fetch donors",
        errorCode: "DONORS_FETCH_ERROR"
      });
    }
  }
);


// =====================================================
// Return standard options plus existing values so historical donor heights
// remain selectable without rewriting old records.
router.get("/height-options", requireAuth, allowRoles("SUPER_ADMIN", "ART_BANK_ADMIN", "ART_BANK_STAFF"), async (req, res) => {
  try {
    const historicalValues = await Donor.distinct("height", { height: { $type: "string", $ne: "" } });
    const values = [...new Set([...STANDARD_HEIGHTS, ...historicalValues.map(String)])];
    values.sort((left, right) => {
      const a = Number(left), b = Number(right);
      return Number.isFinite(a) && Number.isFinite(b) ? a - b : String(left).localeCompare(String(right));
    });
    return res.json({ success: true, data: values });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Failed to fetch existing height values", errorCode: "DONOR_HEIGHT_OPTIONS_ERROR" });
  }
});

// Duplicate review uses the same name/date-of-birth/blood-group tuple as the
// registration UI, but queries the full donor collection instead of a loaded page.
router.get("/possible-duplicates", requireAuth, allowRoles("SUPER_ADMIN", "ART_BANK_ADMIN", "ART_BANK_STAFF"), async (req, res) => {
  const name = typeof req.query.name === "string" ? req.query.name.trim() : "";
  const dobValue = typeof req.query.dob === "string" ? req.query.dob : "";
  const bloodGroup = typeof req.query.bloodGroup === "string" ? req.query.bloodGroup.trim() : "";
  const dobStart = /^\d{4}-\d{2}-\d{2}$/.test(dobValue) ? new Date(`${dobValue}T00:00:00.000Z`) : null;
  if (!name || !bloodGroup || !dobStart || Number.isNaN(dobStart.getTime()) || dobStart.toISOString().slice(0, 10) !== dobValue) {
    return res.status(400).json({ success: false, message: "Name, valid date of birth and blood group are required", errorCode: "INVALID_DUPLICATE_LOOKUP" });
  }
  const dobEnd = new Date(dobStart);
  dobEnd.setUTCDate(dobEnd.getUTCDate() + 1);
  const filter = {
    name: new RegExp(`^${escapeRegex(name)}$`, "i"),
    dob: { $gte: dobStart, $lt: dobEnd },
    bloodGroup: new RegExp(`^${escapeRegex(bloodGroup)}$`, "i")
  };
  try {
    const [donors, matches] = await Promise.all([
      Donor.find(filter).select("donorId uhid name dob bloodGroup").sort({ createdAt: -1, _id: -1 }).limit(20).lean(),
      Donor.countDocuments(filter)
    ]);
    return res.json({ success: true, data: { matches, donors, truncated: matches > donors.length } });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Failed to check possible duplicate donors", errorCode: "DONOR_DUPLICATE_CHECK_ERROR" });
  }
});

// GET DONOR BY ID
// =====================================================

router.get(
  "/:donorId",
  requireAuth,
  allowRoles("SUPER_ADMIN", "ART_BANK_ADMIN", "ART_BANK_STAFF"),
  async (req, res) => {
    try {
      const donor = await Donor.findOne({
        donorId: req.params.donorId
      }).select("-aadhaarHash");

      if (!donor) {
        return res.status(404).json({
          success: false,
          message: "Donor not found",
          errorCode: "DONOR_NOT_FOUND"
        });
      }

      res.json({
        success: true,
        data: donor
      });

    } catch (error) {
      console.error(error);

      res.status(500).json({
        success: false,
        message: "Failed to fetch donor",
        errorCode: "DONOR_FETCH_ERROR"
      });
    }
  }
);


// =====================================================
// CREATE DONOR
// =====================================================

// UHID lookup is additive; the existing donorId lookup remains unchanged.
router.get("/uhid/:uhid", requireAuth, allowRoles("SUPER_ADMIN", "ART_BANK_ADMIN", "ART_BANK_STAFF"), async (req, res) => {
  try {
    const donors = await Donor.find({ uhid: String(req.params.uhid).toUpperCase() }).select("-aadhaarHash").sort({ createdAt: -1 }).limit(100);
    return res.json({ success: true, data: donors });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Failed to fetch donors by UHID", errorCode: "DONORS_FETCH_ERROR" });
  }
});

router.post(
  "/",
  requireAuth,
  allowRoles("SUPER_ADMIN", "ART_BANK_ADMIN", "ART_BANK_STAFF"),
  async (req, res) => {
    try {
      const dob = new Date(req.body.dob);
      if (!req.body.dob || Number.isNaN(dob.getTime()) || dob > new Date()) {
        return res.status(400).json({ success: false, message: "Date of birth must be a valid date in the past", errorCode: "INVALID_DOB" });
      }
      if (ageOn(dob) < 21 || ageOn(dob) > 55) {
        return res.status(400).json({ success: false, message: "Donor age must be between 21 and 55 years", errorCode: "DONOR_AGE_INELIGIBLE" });
      }
      const { aadhaar, name, manualDonorId, unitNumber, maritalStatus, bloodGroup, status, height, complexion, eyeColour, hairColour, build } = req.body;
      if (!String(name || "").trim() || !String(manualDonorId || "").trim() || !["MARRIED", "UNMARRIED"].includes(maritalStatus) || !String(bloodGroup || "").trim()) {
        return res.status(400).json({ success: false, message: "Name, manual donor ID, marital status and blood group are required", errorCode: "REQUIRED_DONOR_FIELDS" });
      }
      if (status !== undefined && status !== "" && !DONOR_STATUSES.includes(status)) {
        return res.status(400).json({ success: false, message: "Donor status must be Active, Inactive or Retired", errorCode: "INVALID_DONOR_STATUS" });
      }
      if (!/^\d{12}$/.test(String(aadhaar || ""))) {
        return res.status(400).json({ success: false, message: "Aadhaar must contain exactly 12 digits", errorCode: "INVALID_AADHAAR" });
      }
      const allowedTraits = { complexion: ["Fair", "Wheatish"], eyeColour: ["Black", "Brown"], hairColour: ["Black", "Brown"], build: ["Slim", "Moderate"] };
      for (const [field, allowed] of Object.entries(allowedTraits)) {
        const value = req.body[field];
        if (value !== undefined && value !== null && value !== "" && (typeof value !== "string" || !allowed.includes(value))) {
          return res.status(400).json({ success: false, message: `Invalid ${field} value`, errorCode: "INVALID_DONOR_TRAIT" });
        }
      }
      if (height !== undefined && height !== null && height !== "") {
        const existingHeights = await Donor.distinct("height", { height: { $type: "string", $ne: "" } });
        const normalizedHeight = String(height).trim();
        if (!isFeetInchesHeight(normalizedHeight) && !existingHeights.includes(normalizedHeight)) {
          return res.status(400).json({ success: false, message: "Height must use feet.inches notation (for example, 5.8 ft) or match an existing historical donor value", errorCode: "INVALID_HEIGHT" });
        }
      }
      const normalizedManualId = String(manualDonorId).trim();
      const normalizedUnitNumber = String(unitNumber || "").trim().toUpperCase();
      if (normalizedManualId.length > 50) {
        return res.status(400).json({ success: false, message: "Manual donor ID must be 50 characters or fewer", errorCode: "INVALID_MANUAL_DONOR_ID" });
      }
      if (normalizedUnitNumber.length > 30) {
        return res.status(400).json({ success: false, message: "Unit Number must be 30 characters or fewer", errorCode: "INVALID_UNIT_NUMBER" });
      }
      if (await Donor.exists({ manualDonorId: normalizedManualId })) {
        return res.status(409).json({ success: false, message: "Manual donor ID already exists", errorCode: "MANUAL_DONOR_ID_EXISTS" });
      }
      if (normalizedUnitNumber && await Donor.exists({ unitNumber: normalizedUnitNumber })) {
        return res.status(409).json({ success: false, message: "Unit Number already exists", errorCode: "UNIT_NUMBER_EXISTS" });
      }

      let donor;
      let donorId = `DON-${crypto.randomUUID()}`;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const uhid = makeUhid();
        try {
          donor = await withTransaction(async session => {
            const [created] = await Donor.create([{
              donorId, uhid, manualDonorId: normalizedManualId, ...(normalizedUnitNumber ? { unitNumber: normalizedUnitNumber } : {}),
              name: String(name).trim(), aadhaarHash: crypto.createHash("sha256").update(String(aadhaar)).digest("hex"),
              aadhaarMasked: `${String(aadhaar).slice(0, 2)}••••••••${String(aadhaar).slice(-2)}`,
              dob, maritalStatus, bloodGroup: String(bloodGroup).trim(), status: status || "Active",
              height: typeof height === "string" ? height.trim() : height, complexion, eyeColour, hairColour, build
            }], { session });
            await recordOperationalEvent({
              actorId: String(req.user.id), role: req.user.role, event: "DONOR_CREATED", entityId: donorId,
              metadata: { status: created.status }, ip: req.ip, session
            });
            return created;
          });
          break;
        } catch (error) {
          if (error?.code === 11000 && error?.keyPattern?.donorId) donorId = `DON-${crypto.randomUUID()}`;
          if (error?.code !== 11000 || attempt === 4) throw error;
        }
      }

      res.status(201).json({
        success: true,
        message: "Donor created",
        data: { ...donor.toObject(), aadhaarHash: undefined }
      });

    } catch (error) {
      if (error?.code === 11000 && error?.keyPattern?.manualDonorId) {
        return res.status(409).json({ success: false, message: "Manual donor ID already exists", errorCode: "MANUAL_DONOR_ID_EXISTS" });
      }
      if (error?.code === 11000 && error?.keyPattern?.unitNumber) {
        return res.status(409).json({ success: false, message: "Unit Number already exists", errorCode: "UNIT_NUMBER_EXISTS" });
      }
      console.error(error);

      res.status(500).json({ success: false, message: "Failed to create donor", errorCode: "DONOR_CREATE_ERROR" });
    }
  }
);

// Super Admin: edit a donor's details. Blood group can change only before any batch exists,
// because batch and vial IDs start with it. A new Aadhaar number is hashed and masked like at registration.
router.put("/:donorId", requireAuth, allowRoles("SUPER_ADMIN"), async (req, res) => {
  try {
    const body = req.body || {};
    const donor = await Donor.findOne({ donorId: req.params.donorId });
    if (!donor) return res.status(404).json({ success: false, message: "Donor not found", errorCode: "DONOR_NOT_FOUND" });
    const fail = (message, errorCode) => res.status(400).json({ success: false, message, errorCode });

    if (body.name !== undefined) {
      if (typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 160) return fail("Enter the donor's full legal name", "REQUIRED_DONOR_FIELDS");
      donor.name = body.name.trim();
    }
    if (body.manualDonorId !== undefined) {
      const manualDonorId = String(body.manualDonorId || "").trim();
      if (!manualDonorId || manualDonorId.length > 50) return fail("Manual donor ID is required and must be 50 characters or fewer", "INVALID_MANUAL_DONOR_ID");
      if (manualDonorId !== donor.manualDonorId && await Donor.exists({ manualDonorId, _id: { $ne: donor._id } })) {
        return res.status(409).json({ success: false, message: "Manual donor ID already exists", errorCode: "MANUAL_DONOR_ID_EXISTS" });
      }
      donor.manualDonorId = manualDonorId;
    }
    if (body.maritalStatus !== undefined) {
      if (!["MARRIED", "UNMARRIED"].includes(body.maritalStatus)) return fail("Marital status must be Married or Unmarried", "INVALID_MARITAL_STATUS");
      donor.maritalStatus = body.maritalStatus;
    }
    if (body.dob !== undefined) {
      const dob = new Date(body.dob);
      if (!body.dob || Number.isNaN(dob.getTime()) || dob > new Date()) return fail("Date of birth must be a valid date in the past", "INVALID_DOB");
      if (ageOn(dob) < 21 || ageOn(dob) > 55) return fail("Donor age must be between 21 and 55 years", "DONOR_AGE_INELIGIBLE");
      donor.dob = dob;
    }
    if (body.bloodGroup !== undefined) {
      const bloodGroup = String(body.bloodGroup || "").trim().toUpperCase();
      if (!/^(AB|A|B|O)[+-]$/.test(bloodGroup)) return fail("Choose a valid blood group", "INVALID_BLOOD_GROUP");
      if (bloodGroup !== String(donor.bloodGroup || "").toUpperCase() && (await Batch.exists({ "donor.donorId": donor.donorId }) || await Vial.exists({ donorId: donor.donorId }))) {
        return res.status(409).json({ success: false, message: "Blood group cannot be changed after collections exist, because batch and vial IDs include it", errorCode: "BLOOD_GROUP_LOCKED" });
      }
      donor.bloodGroup = bloodGroup;
    }
    if (body.status !== undefined) {
      if (!DONOR_STATUSES.includes(body.status)) return fail("Donor status must be Active, Inactive or Retired", "INVALID_DONOR_STATUS");
      donor.status = body.status;
    }
    const allowedTraits = { complexion: ["Fair", "Wheatish"], eyeColour: ["Black", "Brown"], hairColour: ["Black", "Brown"], build: ["Slim", "Moderate"] };
    for (const [field, allowed] of Object.entries(allowedTraits)) {
      if (body[field] === undefined) continue;
      if (body[field] !== "" && body[field] !== null && !allowed.includes(body[field])) return fail(`Invalid ${field} value`, "INVALID_DONOR_TRAIT");
      donor[field] = body[field] || undefined;
    }
    if (body.height !== undefined) {
      const height = String(body.height || "").trim();
      if (height && !isFeetInchesHeight(height) && height !== donor.height) return fail("Height must use feet.inches notation (for example, 5.8 ft)", "INVALID_HEIGHT");
      donor.height = height || undefined;
    }
    if (body.aadhaar !== undefined && body.aadhaar !== "") {
      if (!/^\d{12}$/.test(String(body.aadhaar))) return fail("Aadhaar must contain exactly 12 digits", "INVALID_AADHAAR");
      donor.aadhaarHash = crypto.createHash("sha256").update(String(body.aadhaar)).digest("hex");
      donor.aadhaarMasked = `${String(body.aadhaar).slice(0, 2)}••••••••${String(body.aadhaar).slice(-2)}`;
    }

    await donor.save();
    await recordDonorAudit(req, "DONOR_UPDATED", donor.donorId, "Donor updated by Super Admin");
    const saved = donor.toObject();
    delete saved.aadhaarHash;
    return res.json({ success: true, message: "Donor updated", data: saved });
  } catch (error) {
    if (error?.code === 11000) return res.status(409).json({ success: false, message: "Manual donor ID already exists", errorCode: "MANUAL_DONOR_ID_EXISTS" });
    console.error(error);
    return res.status(500).json({ success: false, message: "Failed to update donor", errorCode: "DONOR_UPDATE_ERROR" });
  }
});

// Super Admin: delete a donor who has no batches, vials or orders. Their private donor files are removed too.
router.delete("/:donorId", requireAuth, allowRoles("SUPER_ADMIN"), async (req, res) => {
  try {
    const attachmentFilter = { hospitalId: "ART_BANK", centreId: "ART_BANK", relatedId: req.params.donorId, category: { $in: ["DONOR_AADHAAR", "DONOR_DOCUMENT"] } };
    const files = [];
    const result = await withTransaction(async session => {
      const deleted = await deleteDonor(req, req.params.donorId, session);
      const attachments = await Attachment.find(attachmentFilter).session(session).lean();
      files.push(...attachments.flatMap(item => (item.files || []).map(file => file.storageName)));
      await Attachment.deleteMany(attachmentFilter, { session });
      return { ...deleted, filesDeleted: files.length };
    });
    // Files are removed only after the database change has been saved.
    for (const storageName of files) await deletePrivateFile(storageName).catch(error => console.error("Could not remove donor file", error.message));
    return res.json({ success: true, message: "Donor deleted", data: result });
  } catch (error) {
    return sendRouteError(res, error, { message: "Failed to delete donor", errorCode: "DONOR_DELETE_ERROR" });
  }
});

// Records the donor's statutory screening results (HIV, HBsAg, HCV, VDRL, thalassemia, karyotype).
router.patch("/:donorId/screening", requireAuth, allowRoles("SUPER_ADMIN", "ART_BANK_ADMIN", "ART_BANK_STAFF"), async (req, res) => {
  try {
    const screening = {};
    for (const [test, allowed] of Object.entries(SCREENING_RESULTS)) {
      const value = req.body?.[test];
      if (value === undefined || value === "") continue;
      if (!allowed.includes(value)) {
        return res.status(400).json({ success: false, message: `Invalid ${test} result`, errorCode: "INVALID_SCREENING_RESULT" });
      }
      screening[test] = value;
    }
    const testedOnValue = req.body?.testedOn;
    const testedOn = testedOnValue ? new Date(`${testedOnValue}T00:00:00.000Z`) : null;
    if (testedOnValue && (!/^\d{4}-\d{2}-\d{2}$/.test(testedOnValue) || Number.isNaN(testedOn.getTime()) || testedOn > new Date())) {
      return res.status(400).json({ success: false, message: "Test date must be a valid date that is not in the future", errorCode: "INVALID_SCREENING_DATE" });
    }
    if (!Object.keys(screening).length) {
      return res.status(400).json({ success: false, message: "Enter at least one screening result", errorCode: "SCREENING_REQUIRED" });
    }

    const donor = await Donor.findOneAndUpdate(
      { donorId: req.params.donorId },
      { $set: { screening: { ...screening, ...(testedOn ? { testedOn } : {}), updatedBy: req.user.username, updatedAt: new Date() } } },
      { new: true }
    ).select("-aadhaarHash").lean();
    if (!donor) return res.status(404).json({ success: false, message: "Donor not found", errorCode: "DONOR_NOT_FOUND" });
    await recordDonorAudit(req, "DONOR_SCREENING_UPDATED", donor.donorId, "Donor screening results recorded");
    return res.json({ success: true, message: "Screening results saved", data: donor });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Failed to save screening results", errorCode: "DONOR_SCREENING_ERROR" });
  }
});

// Changes a donor between Active, Inactive and Retired. Inactive and retired donors cannot give new collections.
router.patch("/:donorId/status", requireAuth, allowRoles("SUPER_ADMIN", "ART_BANK_ADMIN"), async (req, res) => {
  try {
    const status = req.body?.status;
    if (!DONOR_STATUSES.includes(status)) {
      return res.status(400).json({ success: false, message: "Donor status must be Active, Inactive or Retired", errorCode: "INVALID_DONOR_STATUS" });
    }
    const previous = await Donor.findOne({ donorId: req.params.donorId }).select("status").lean();
    if (!previous) return res.status(404).json({ success: false, message: "Donor not found", errorCode: "DONOR_NOT_FOUND" });
    const donor = await Donor.findOneAndUpdate({ donorId: req.params.donorId }, { $set: { status } }, { new: true }).select("-aadhaarHash").lean();
    await recordDonorAudit(req, "DONOR_STATUS_CHANGED", donor.donorId, "Donor status changed", { previousStatus: previous.status || "Active", status });
    return res.json({ success: true, message: "Donor status updated", data: donor });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Failed to update donor status", errorCode: "DONOR_STATUS_ERROR" });
  }
});

module.exports = router;
