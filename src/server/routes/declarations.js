const router = require("../http/router").Router();
const { requireAuth, allowRoles } = require("../middleware/auth");
const Declaration = require("../models/Declaration");
const Couple = require("../models/Couple");
const IdSequence = require("../models/IdSequence");
const Vial = require("../models/Vial");
const AuthorizedSigner = require("../models/AuthorizedSigner");
const Signature = require("../models/Signature");
const { getEffectiveDeclarationVersion, isSignatureCurrentForDeclaration } = require("../services/declarationVersionService");
const { formatDeclarationId } = require("../services/declarationIdService");
const { withTransaction, RouteError, sendRouteError } = require("../services/transactionService");
const { recordOperationalEvent } = require("../services/operationalAuditService");
const { publicErrorMessage } = require("../services/errorResponseService");
const Donor = require("../models/Donor");
const asyncHandler = require("../middleware/asyncHandler");

async function nextDeclarationId() {
  const year = new Date().getUTCFullYear();
  const name = `declaration-${year}`;
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
  return formatDeclarationId(year, sequence.value);
}

router.get("/", requireAuth, allowRoles("SUPER_ADMIN", "ART_BANK_ADMIN", "ART_BANK_STAFF", "HOSPITAL_USER"), asyncHandler(async (req, res) => {
  if (req.user.role === "HOSPITAL_USER" && (!req.user.hospitalId || !req.user.centreId)) return res.status(403).json({ success: false, message: "Hospital account has no assigned hospital/centre", errorCode: "HOSPITAL_SCOPE_MISSING" });
  const filter = req.user.role === "HOSPITAL_USER" ? { hospitalId: req.user.hospitalId, centreId: req.user.centreId, status: { $in: ["SUBMITTED", "APPROVED", "CORRECTION_REQUIRED"] } } : {};
  const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 100, 1), 500);
  const skip = Math.min(Math.max(Number.parseInt(req.query.skip, 10) || 0, 0), 100000);
  const [records, total, statusCounts, unsignedCount] = await Promise.all([
    Declaration.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(),
    Declaration.countDocuments(filter),
    Declaration.aggregate([
      { $match: filter },
      { $group: { _id: "$status", count: { $sum: 1 } } },
      { $sort: { _id: 1 } }
    ]),
    Declaration.aggregate([
      { $match: { ...filter, status: "SUBMITTED" } },
      { $lookup: {
        from: Signature.collection.name,
        localField: "declarationId",
        foreignField: "declarationId",
        as: "signatures"
      } },
      { $addFields: { _effectiveVersion: { $ifNull: ["$currentVersion", 1] } } },
      { $addFields: {
        _currentSignatures: {
          $filter: {
            input: "$signatures",
            as: "signature",
            cond: { $and: [
              { $eq: [{ $ifNull: ["$$signature.declarationVersion", 1] }, "$_effectiveVersion"] },
              { $ne: ["$$signature.valid", false] }
            ] }
          }
        }
      } },
      { $match: { $expr: { $eq: [{ $size: "$_currentSignatures" }, 0] } } },
      { $count: "count" }
    ])
  ]);
  const signatures = await Signature.find({ declarationId: { $in: records.map(record => record.declarationId) } }).select("declarationId declarationVersion valid").lean();
  const signaturesByDeclaration = new Map();
  for (const signature of signatures) {
    const declaration = records.find(record => record.declarationId === signature.declarationId);
    if (!declaration || !isSignatureCurrentForDeclaration(signature, declaration)) continue;
    const current = signaturesByDeclaration.get(signature.declarationId);
    if (!current || new Date(signature.signedAt || 0) > new Date(current.signedAt || 0)) signaturesByDeclaration.set(signature.declarationId, signature);
  }
  res.json({ success: true, data: records.map(record => {
    const currentVersion = getEffectiveDeclarationVersion(record);
    const signature = signaturesByDeclaration.get(record.declarationId);
    return { ...record, currentVersion, signed: Boolean(signature && isSignatureCurrentForDeclaration(signature, record)) };
  }), summary: {
    byStatus: statusCounts.map(({ _id, count }) => ({ status: _id, count })),
    unsignedSubmitted: unsignedCount[0]?.count || 0
  }, pagination: { skip, limit, total, hasMore: skip + records.length < total } });
}));

// POST /api/declarations
router.post(
  "/",
  requireAuth,
  allowRoles("SUPER_ADMIN", "ART_BANK_ADMIN", "ART_BANK_STAFF"),
  async (req, res) => {
    try {
      const {
        coupleId,
        declarationType,
        confirmations,
        declarationData
      } = req.body;

      if (!coupleId || !declarationType || !confirmations) {
        return res.status(400).json({
          success: false,
          message: "coupleId, declarationType and confirmations are required",
          errorCode: "DECLARATION_DATA_REQUIRED"
        });
      }

      const confirmationValues = Object.values(confirmations);

      if (
        confirmationValues.length === 0 ||
        confirmationValues.some((value) => value !== true)
      ) {
        return res.status(400).json({
          success: false,
          message: "All declaration confirmations are required",
          errorCode: "CONFIRMATIONS_REQUIRED"
        });
      }

      const declarationId = await nextDeclarationId();
      const declaration = await withTransaction(async session => {
        const couple = await Couple.findOne({ coupleId }).session(session);
        if (!couple) throw new RouteError(404, "Couple not found", "COUPLE_NOT_FOUND");
        const signerId = declarationData?.signerId;
        const signer = signerId ? await AuthorizedSigner.findOne({ signerId, status: "ACTIVE" }).session(session).lean() : null;
        if (!signer) throw new RouteError(400, "Select an active authorised signatory", "ACTIVE_SIGNER_REQUIRED");
        const mappedVialIds = couple.mappedVialIds || [];
        const mappedVials = await Vial.find({ vialId: { $in: mappedVialIds } }).select("vialId donorId hospitalId centreId status").session(session).lean();
        if (!mappedVialIds.length || mappedVials.length !== mappedVialIds.length || mappedVials.some(v => v.hospitalId !== couple.hospitalId || v.centreId !== couple.centreId || v.status !== "MAPPED_USED") || new Set(mappedVials.map(v => v.donorId)).size !== 1) {
          throw new RouteError(400, "A declaration requires one or more mapped vials from the same donor", "DECLARATION_VIALS_INVALID");
        }
        const linkedDonor = await Donor.findOne({ donorId: mappedVials[0].donorId })
          .select("donorId uhid manualDonorId name aadhaarMasked bloodGroup height complexion eyeColour hairColour build")
          .session(session).lean();
        if (!linkedDonor) throw new RouteError(400, "The mapped vial donor record could not be found", "DECLARATION_DONOR_NOT_FOUND");
        const donorNumber = linkedDonor.manualDonorId || linkedDonor.uhid || linkedDonor.donorId;
        const [created] = await Declaration.create([{
          declarationId,
          coupleId,
          hospitalId: couple.hospitalId,
          centreId: couple.centreId,
          declarationType,
          confirmations,
          declarationData: {
            ...(declarationData || {}),
            donor: linkedDonor.donorId,
            donorNumber,
            donorUhid: linkedDonor.uhid || "",
            donorName: linkedDonor.name,
            bloodGroup: linkedDonor.bloodGroup || "",
            height: linkedDonor.height || "",
            complexion: linkedDonor.complexion || "",
            eyeColour: linkedDonor.eyeColour || "",
            hairColour: linkedDonor.hairColour || "",
            build: linkedDonor.build || "",
            aadhaarMasked: linkedDonor.aadhaarMasked || declarationData?.aadhaarMasked || ""
          },
          status: "DRAFT",
          vialIds: mappedVialIds,
          signerId,
          signerSnapshot: { signerId: signer.signerId, name: signer.name, designation: signer.designation, version: signer.version, imageOriginalName: signer.imageOriginalName }
        }], { session });
        await recordOperationalEvent({ actorId: String(req.user.id), role: req.user.role, event: "DECLARATION_CREATED", entityId: declarationId, metadata: { status: "DRAFT", hospitalId: couple.hospitalId, centreId: couple.centreId }, ip: req.ip, session });
        return created;
      });

      return res.status(201).json({
        success: true,
        message: "Declaration created successfully",
        data: declaration
      });
    } catch (e) {
      if (e instanceof RouteError) return sendRouteError(res, e, { message: "Failed to create declaration", errorCode: "DECLARATION_CREATE_ERROR" });
      console.error(e);
      return res.status(500).json({ success: false, message: publicErrorMessage(e, "Failed to create declaration"), errorCode: "DECLARATION_CREATE_ERROR" });
    }
  }
);


// GET /api/declarations/:declarationId
router.get(
  "/:declarationId",
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
      const query = { declarationId: req.params.declarationId };
      if (req.user.role === "HOSPITAL_USER") Object.assign(query, { hospitalId: req.user.hospitalId, centreId: req.user.centreId, status: { $in: ["SUBMITTED", "APPROVED", "CORRECTION_REQUIRED"] } });
      const declaration = await Declaration.findOne(query);

      if (!declaration) {
        return res.status(404).json({
          success: false,
          message: "Declaration not found",
          errorCode: "DECLARATION_NOT_FOUND"
        });
      }

      return res.json({
        success: true,
        data: { ...declaration.toObject(), currentVersion: getEffectiveDeclarationVersion(declaration) }
      });
    } catch (e) {
      console.error(e);

      return res.status(500).json({
        success: false,
        message: publicErrorMessage(e, "Failed to fetch declaration"),
        errorCode: "DECLARATION_GET_ERROR"
      });
    }
  }
);

router.patch("/:declarationId/draft-report-details", requireAuth, allowRoles("SUPER_ADMIN", "ART_BANK_ADMIN", "ART_BANK_STAFF"), asyncHandler(async (req, res) => {
  const body = req.body;
  const allowedFields = new Set(["patientAge", "sampleDate"]);
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => !allowedFields.has(key)) ||
      !Number.isInteger(body.patientAge) || body.patientAge < 0 || body.patientAge > 120 ||
      typeof body.sampleDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(body.sampleDate) ||
      Number.isNaN(Date.parse(`${body.sampleDate}T00:00:00.000Z`)) ||
      new Date(`${body.sampleDate}T00:00:00.000Z`).toISOString().slice(0, 10) !== body.sampleDate) {
    throw new RouteError(400, "A valid patient age and sample date are required", "INVALID_DRAFT_REPORT_DETAILS");
  }
  const declaration = await withTransaction(async session => {
    const updated = await Declaration.findOneAndUpdate(
      { declarationId: req.params.declarationId, status: "DRAFT" },
      { $set: { "declarationData.patientAge": body.patientAge, "declarationData.sampleDate": body.sampleDate } },
      { new: true, runValidators: true, session }
    );
    if (!updated) {
      const current = await Declaration.findOne({ declarationId: req.params.declarationId }).select("status").session(session).lean();
      if (!current) throw new RouteError(404, "Declaration not found", "DECLARATION_NOT_FOUND");
      throw new RouteError(409, "Only draft declarations can have report details updated", "INVALID_DECLARATION_STATUS");
    }
    await recordOperationalEvent({
      actorId: String(req.user.id), role: req.user.role, event: "DECLARATION_DRAFT_DETAILS_UPDATED",
      entityId: updated.declarationId, metadata: { count: 2, status: updated.status },
      ip: req.ip, session
    });
    return updated;
  });
  res.json({ success: true, message: "Declaration report details updated", data: declaration });
}));

// PUT /api/declarations/:declarationId
// Legacy direct correction writes are disabled. Use the separate, reviewed
// correction-request workflow so submitted declaration data is never replaced
// by a hospital request.
router.put(
  "/:declarationId",
  requireAuth,
  allowRoles("HOSPITAL_USER"),
  async (req, res) => {
    if (!req.user.hospitalId || !req.user.centreId) return res.status(403).json({ success: false, message: "Hospital account has no assigned hospital/centre", errorCode: "HOSPITAL_SCOPE_MISSING" });
    try {
      const declaration = await Declaration.findOne({ declarationId: req.params.declarationId, hospitalId: req.user.hospitalId, centreId: req.user.centreId }).select("declarationId").lean();
      if (!declaration) return res.status(404).json({ success: false, message: "Declaration not found", errorCode: "DECLARATION_NOT_FOUND" });
      return res.status(409).json({ success: false, message: "Direct declaration edits are disabled; submit a reviewed correction request", errorCode: "CORRECTION_REQUEST_REQUIRED" });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ success: false, message: "Failed to check declaration", errorCode: "DECLARATION_UPDATE_ERROR" });
    }
  }
);


// POST /api/declarations/:declarationId/correction
router.post(
  "/:declarationId/correction",
  requireAuth,
  allowRoles("SUPER_ADMIN", "ART_BANK_ADMIN"),
  async (req, res) => {
    const declaration = await Declaration.findOne({ declarationId: req.params.declarationId });
    if (!declaration) return res.status(404).json({ success: false, message: "Declaration not found", errorCode: "DECLARATION_NOT_FOUND" });
    return res.status(409).json({ success: false, message: "Hospitals must submit a correction request for review", errorCode: "CORRECTION_REQUEST_REQUIRED" });
  }
);


// POST /api/declarations/:declarationId/submit
router.post(
  "/:declarationId/submit",
  requireAuth,
  allowRoles("SUPER_ADMIN", "ART_BANK_ADMIN", "ART_BANK_STAFF"),
  async (req, res) => {
    const submittedAt = new Date();
    try {
      const declaration = await withTransaction(async session => {
        const current = await Declaration.findOne({ declarationId: req.params.declarationId }).session(session);
        if (!current) throw new RouteError(404, "Declaration not found", "DECLARATION_NOT_FOUND");
        if (current.status !== "DRAFT") throw new RouteError(400, "Only draft declarations can be submitted", "INVALID_DECLARATION_STATUS");
        const signer = await AuthorizedSigner.findOne({ signerId: current.signerId, status: "ACTIVE" }).session(session).lean();
        if (!signer) throw new RouteError(400, "The declaration's authorised signatory is inactive or missing", "ACTIVE_SIGNER_REQUIRED");
        const updated = await Declaration.findOneAndUpdate({ _id: current._id, status: "DRAFT" }, {
          $set: {
            signerSnapshot: { signerId: signer.signerId, name: signer.name, designation: signer.designation, version: signer.version, imageOriginalName: signer.imageOriginalName },
            status: "SUBMITTED", submittedBy: req.user.username, submittedAt
          }
        }, { new: true, session, runValidators: true });
        if (!updated) throw new RouteError(409, "Declaration changed while submitting", "INVALID_DECLARATION_STATUS");
        await recordOperationalEvent({ actorId: String(req.user.id), role: req.user.role, event: "DECLARATION_SUBMITTED", entityId: updated.declarationId, metadata: { status: "SUBMITTED", hospitalId: updated.hospitalId, centreId: updated.centreId }, ip: req.ip, session });
        return updated;
      });

      return res.json({
        success: true,
        message: "Declaration submitted successfully",
        data: declaration
      });
    } catch (e) {
      if (e instanceof RouteError) return sendRouteError(res, e, { message: "Failed to submit declaration", errorCode: "DECLARATION_SUBMIT_ERROR" });
      console.error(e);
      return res.status(500).json({ success: false, message: publicErrorMessage(e, "Failed to submit declaration"), errorCode: "DECLARATION_SUBMIT_ERROR" });
    }
  }
);

router.post("/:declarationId/unsubmit", requireAuth, allowRoles("SUPER_ADMIN", "ART_BANK_ADMIN", "ART_BANK_STAFF"), asyncHandler(async (req, res) => {
  const declaration = await withTransaction(async session => {
    const existing = await Declaration.findOne({ declarationId: req.params.declarationId }).select("status pendingCorrectionRequestId lastSignedVersion").session(session).lean();
    if (!existing) throw new RouteError(404, "Declaration not found", "DECLARATION_NOT_FOUND");
    if (existing.status !== "SUBMITTED") throw new RouteError(400, "Only submitted declarations can be unsubmitted", "INVALID_DECLARATION_STATUS");
    if (existing.pendingCorrectionRequestId) throw new RouteError(409, "A correction request is pending review", "CORRECTION_REQUEST_PENDING");
    const signature = await Signature.findOne({ declarationId: req.params.declarationId }).select("_id").session(session).lean();
    if (signature) throw new RouteError(409, "A signed declaration cannot be returned to draft", "DECLARATION_ALREADY_SIGNED");
    const updated = await Declaration.findOneAndUpdate({
      declarationId: req.params.declarationId, status: "SUBMITTED", pendingCorrectionRequestId: null, lastSignedVersion: null
    }, { $set: { status: "DRAFT" }, $unset: { submittedAt: 1, submittedBy: 1 } }, { new: true, runValidators: true, session });
    if (!updated) throw new RouteError(409, "Declaration changed during unsubmit", "CORRECTION_REQUEST_CONFLICT");
    await recordOperationalEvent({ actorId: String(req.user.id), role: req.user.role, event: "DECLARATION_UNSUBMITTED", entityId: updated.declarationId, metadata: { previousStatus: "SUBMITTED", status: "DRAFT", hospitalId: updated.hospitalId, centreId: updated.centreId }, ip: req.ip, session });
    return updated;
  });
  res.json({ success: true, message: "Declaration returned to draft", data: declaration });
}));

module.exports = router;
