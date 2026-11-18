const router = require("../http/router").Router();
const crypto = require("crypto");
const { requireAuth, allowRoles } = require("../middleware/auth");
const Declaration = require("../models/Declaration");
const DeclarationCorrectionRequest = require("../models/DeclarationCorrectionRequest");
const DeclarationVersion = require("../models/DeclarationVersion");
const Signature = require("../models/Signature");
const { validateCorrectionRequest, validateReviewReason } = require("../services/declarationCorrectionService");
const { getEffectiveDeclarationVersion, buildInitialVersionSnapshot, buildNextVersionSnapshot, persistDeclarationVersion } = require("../services/declarationVersionService");
const { recordDeclarationCorrectionEvent } = require("../services/auditService");
const { withTransaction, RouteError, sendRouteError } = require("../services/transactionService");
const signatureVersioningService = require("../services/signatureVersioningService");
const { signatureVersionFilter } = signatureVersioningService;

const HOSPITAL_SCOPE_MISSING = () => new RouteError(403, "Hospital account has no assigned hospital/centre", "HOSPITAL_SCOPE_MISSING");
const requestId = () => `DCR-${crypto.randomUUID()}`;

function scopedFilter(req, field, id) {
  const filter = { [field]: id };
  if (req.user.role === "HOSPITAL_USER") {
    if (!req.user.hospitalId || !req.user.centreId) throw HOSPITAL_SCOPE_MISSING();
    filter.hospitalId = req.user.hospitalId;
    filter.centreId = req.user.centreId;
  }
  return filter;
}

function versionFilter(version) {
  return version === 1
    ? { $or: [{ currentVersion: 1 }, { currentVersion: { $exists: false } }, { currentVersion: null }] }
    : { currentVersion: version };
}

function effectivePointerFilter() {
  return { pendingCorrectionRequestId: null };
}

function requireValidBody(body, validator) {
  try { return validator(body); }
  catch (error) { throw new RouteError(400, error.message, "INVALID_CORRECTION_REQUEST"); }
}

async function audit(req, event, declarationId, id, baseVersion, resultingVersion, session) {
  await recordDeclarationCorrectionEvent({
    actorId: String(req.user.id), role: req.user.role, event, declarationId,
    requestId: id, baseVersion, resultingVersion, ip: req.ip, session
  });
}

router.post("/declarations/:declarationId/correction-requests", requireAuth, allowRoles("HOSPITAL_USER"), async (req, res) => {
  let payload;
  try { payload = requireValidBody(req.body, validateCorrectionRequest); }
  catch (error) { return sendRouteError(res, error, { message: "Invalid correction request", errorCode: "INVALID_CORRECTION_REQUEST" }); }
  const id = requestId();
  const requestedAt = new Date();
  try {
    const result = await withTransaction(async session => {
      const filter = scopedFilter(req, "declarationId", req.params.declarationId);
      const declaration = await Declaration.findOne(filter).session(session);
      if (!declaration) throw new RouteError(404, "Declaration not found", "DECLARATION_NOT_FOUND");
      if (declaration.status !== "SUBMITTED" && declaration.status !== "CORRECTION_REQUIRED") throw new RouteError(400, "Only submitted declarations can receive correction requests", "INVALID_DECLARATION_STATUS");
      const currentVersion = getEffectiveDeclarationVersion(declaration);
      if (payload.baseVersion !== currentVersion) throw new RouteError(409, "Declaration version changed; reload before requesting a correction", "STALE_DECLARATION_VERSION");

      const claimFilter = { _id: declaration._id, hospitalId: req.user.hospitalId, centreId: req.user.centreId, status: { $in: ["SUBMITTED", "CORRECTION_REQUIRED"] }, ...effectivePointerFilter(), ...versionFilter(currentVersion) };
      const claimed = await Declaration.findOneAndUpdate(claimFilter, { $set: { status: "SUBMITTED", pendingCorrectionRequestId: id } }, { new: true, session, runValidators: true });
      if (!claimed) throw new RouteError(409, "A correction is already pending or the declaration changed", "CORRECTION_REQUEST_CONFLICT");

      const created = await DeclarationCorrectionRequest.create([{
        requestId: id, declarationId: declaration.declarationId, hospitalId: declaration.hospitalId,
        centreId: declaration.centreId, baseVersion: currentVersion, proposedChanges: payload.proposedChanges,
        reason: payload.reason, status: "PENDING_REVIEW", requestedBy: req.user.username, requestedAt
      }], { session });
      await audit(req, "DECLARATION_CORRECTION_SUBMITTED", declaration.declarationId, id, currentVersion, undefined, session);
      return created[0];
    });
    return res.status(201).json({ success: true, message: "Correction request submitted", data: result });
  } catch (error) {
    return sendRouteError(res, error, { message: "Failed to submit correction request", errorCode: "CORRECTION_REQUEST_CREATE_ERROR" });
  }
});

router.get("/declarations/:declarationId/correction-requests", requireAuth, allowRoles("SUPER_ADMIN", "ART_BANK_ADMIN", "HOSPITAL_USER"), async (req, res) => {
  try {
    const declarationFilter = scopedFilter(req, "declarationId", req.params.declarationId);
    const declaration = await Declaration.findOne(declarationFilter).select("declarationId hospitalId centreId").lean();
    if (!declaration) return res.status(404).json({ success: false, message: "Declaration not found", errorCode: "DECLARATION_NOT_FOUND" });
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 50, 1), 100);
    const skip = Math.min(Math.max(Number.parseInt(req.query.skip, 10) || 0, 0), 100000);
    const filter = { declarationId: declaration.declarationId };
    if (req.user.role === "HOSPITAL_USER") Object.assign(filter, { hospitalId: req.user.hospitalId, centreId: req.user.centreId });
    const requests = await DeclarationCorrectionRequest.find(filter).sort({ requestedAt: -1 }).skip(skip).limit(limit).lean();
    const total = await DeclarationCorrectionRequest.countDocuments(filter);
    return res.json({ success: true, data: { records: requests, pagination: { skip, limit, total } } });
  } catch (error) {
    if (error instanceof RouteError) return sendRouteError(res, error, { message: "Failed to fetch correction requests", errorCode: "CORRECTION_REQUEST_FETCH_ERROR" });
    console.error(error);
    return res.status(500).json({ success: false, message: "Failed to fetch correction requests", errorCode: "CORRECTION_REQUEST_FETCH_ERROR" });
  }
});

router.get("/declarations/:declarationId/versions", requireAuth, allowRoles("SUPER_ADMIN", "ART_BANK_ADMIN", "ART_BANK_STAFF", "HOSPITAL_USER"), async (req, res) => {
  try {
    const filter = scopedFilter(req, "declarationId", req.params.declarationId);
    if (req.user.role === "HOSPITAL_USER") filter.status = { $in: ["SUBMITTED", "APPROVED", "CORRECTION_REQUIRED"] };
    const declaration = await Declaration.findOne(filter).lean();
    if (!declaration) return res.status(404).json({ success: false, message: "Declaration not found", errorCode: "DECLARATION_NOT_FOUND" });
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 100, 1), 100);
    const skip = Math.min(Math.max(Number.parseInt(req.query.skip, 10) || 0, 0), 100000);
    const versions = await DeclarationVersion.find({ declarationId: declaration.declarationId }).sort({ version: 1 }).skip(skip).limit(limit).lean();
    const total = await DeclarationVersion.countDocuments({ declarationId: declaration.declarationId });
    if (!versions.length && skip === 0 && total === 0 && getEffectiveDeclarationVersion(declaration) === 1) {
      return res.json({ success: true, data: [{
        declarationId: declaration.declarationId, version: 1, declarationType: declaration.declarationType,
        confirmations: declaration.confirmations, declarationData: declaration.declarationData || {},
        coupleId: declaration.coupleId, hospitalId: declaration.hospitalId, centreId: declaration.centreId,
        vialIds: declaration.vialIds || [], signerId: declaration.signerId, signerSnapshot: declaration.signerSnapshot,
        createdBy: null, createdAt: declaration.createdAt, legacy: true
      }], pagination: { skip: 0, limit, total: 1, hasMore: false } });
    }
    return res.json({ success: true, data: versions, pagination: { skip, limit, total, hasMore: skip + versions.length < total } });
  } catch (error) {
    if (error instanceof RouteError) return sendRouteError(res, error, { message: "Failed to fetch declaration versions", errorCode: "DECLARATION_VERSION_FETCH_ERROR" });
    console.error(error);
    return res.status(500).json({ success: false, message: "Failed to fetch declaration versions", errorCode: "DECLARATION_VERSION_FETCH_ERROR" });
  }
});

router.get("/correction-requests", requireAuth, allowRoles("SUPER_ADMIN", "ART_BANK_ADMIN", "HOSPITAL_USER"), async (req, res) => {
  try {
    const filter = {};
    if (req.query.status) {
      if (!["PENDING_REVIEW", "REVISION_REQUIRED", "APPROVED"].includes(req.query.status)) return res.status(400).json({ success: false, message: "Invalid correction request status", errorCode: "INVALID_CORRECTION_STATUS" });
      filter.status = req.query.status;
    }
    if (req.user.role === "HOSPITAL_USER") {
      if (!req.user.hospitalId || !req.user.centreId) throw HOSPITAL_SCOPE_MISSING();
      filter.hospitalId = req.user.hospitalId;
      filter.centreId = req.user.centreId;
    }
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 50, 1), 100);
    const skip = Math.min(Math.max(Number.parseInt(req.query.skip, 10) || 0, 0), 100000);
    const requests = await DeclarationCorrectionRequest.find(filter).sort({ requestedAt: -1 }).skip(skip).limit(limit).lean();
    const total = await DeclarationCorrectionRequest.countDocuments(filter);
    return res.json({ success: true, data: { records: requests, pagination: { skip, limit, total } } });
  } catch (error) {
    if (error instanceof RouteError) return sendRouteError(res, error, { message: "Failed to fetch correction requests", errorCode: "CORRECTION_REQUEST_FETCH_ERROR" });
    console.error(error);
    return res.status(500).json({ success: false, message: "Failed to fetch correction requests", errorCode: "CORRECTION_REQUEST_FETCH_ERROR" });
  }
});

router.post("/declarations/:declarationId/correction-requests/:requestId/resubmit", requireAuth, allowRoles("HOSPITAL_USER"), async (req, res) => {
  let payload;
  try { payload = requireValidBody(req.body, validateCorrectionRequest); }
  catch (error) { return sendRouteError(res, error, { message: "Invalid correction request", errorCode: "INVALID_CORRECTION_REQUEST" }); }
  const id = requestId();
  const requestedAt = new Date();
  try {
    const created = await withTransaction(async session => {
      const oldFilter = { ...scopedFilter(req, "declarationId", req.params.declarationId), requestId: req.params.requestId, status: "REVISION_REQUIRED" };
      const prior = await DeclarationCorrectionRequest.findOne(oldFilter).session(session);
      if (!prior) throw new RouteError(404, "Revision-required request not found", "CORRECTION_REQUEST_NOT_FOUND");
      const declarationFilter = { ...scopedFilter(req, "declarationId", req.params.declarationId), status: "SUBMITTED" };
      const declaration = await Declaration.findOne(declarationFilter).session(session);
      if (!declaration) throw new RouteError(404, "Declaration not found", "DECLARATION_NOT_FOUND");
      const currentVersion = getEffectiveDeclarationVersion(declaration);
      if (payload.baseVersion !== currentVersion || prior.baseVersion !== currentVersion) throw new RouteError(409, "Declaration version changed; reload before resubmitting", "STALE_DECLARATION_VERSION");
      const claimed = await Declaration.findOneAndUpdate({ _id: declaration._id, hospitalId: req.user.hospitalId, centreId: req.user.centreId, status: "SUBMITTED", ...effectivePointerFilter(), ...versionFilter(currentVersion) }, { $set: { pendingCorrectionRequestId: id } }, { new: true, session, runValidators: true });
      if (!claimed) throw new RouteError(409, "A correction is already pending or the declaration changed", "CORRECTION_REQUEST_CONFLICT");
      const result = await DeclarationCorrectionRequest.create([{
        requestId: id, declarationId: declaration.declarationId, hospitalId: declaration.hospitalId,
        centreId: declaration.centreId, baseVersion: currentVersion, proposedChanges: payload.proposedChanges,
        reason: payload.reason, status: "PENDING_REVIEW", requestedBy: req.user.username, requestedAt,
        revisionOfRequestId: prior.requestId
      }], { session });
      await audit(req, "DECLARATION_CORRECTION_RESUBMITTED", declaration.declarationId, id, currentVersion, undefined, session);
      return result[0];
    });
    return res.status(201).json({ success: true, message: "Correction revision submitted", data: created });
  } catch (error) {
    return sendRouteError(res, error, { message: "Failed to resubmit correction request", errorCode: "CORRECTION_REQUEST_RESUBMIT_ERROR" });
  }
});

router.post("/correction-requests/:requestId/approve", requireAuth, allowRoles("SUPER_ADMIN", "ART_BANK_ADMIN"), async (req, res) => {
  try {
    // This read-only capability check stays outside the transaction. If it
    // cannot prove that the compound index and legacy backfill are complete,
    // already-signed declarations remain fail-closed below.
    const signatureStorageReady = await signatureVersioningService.isVersionedSignatureStorageReady();
    const result = await withTransaction(async session => {
      const request = await DeclarationCorrectionRequest.findOne({ requestId: req.params.requestId, status: "PENDING_REVIEW" }).session(session);
      if (!request) throw new RouteError(409, "Correction request is no longer pending review", "CORRECTION_REQUEST_NOT_PENDING");
      const declaration = await Declaration.findOne({ declarationId: request.declarationId, hospitalId: request.hospitalId, centreId: request.centreId, status: "SUBMITTED", pendingCorrectionRequestId: request.requestId }).session(session);
      if (!declaration) throw new RouteError(409, "Declaration no longer matches the pending correction request", "CORRECTION_REQUEST_CONFLICT");
      const baseVersion = getEffectiveDeclarationVersion(declaration);
      if (baseVersion !== request.baseVersion) throw new RouteError(409, "Declaration version changed; correction cannot be approved", "STALE_DECLARATION_VERSION");

      const priorSignature = await Signature.findOne({
        $and: [
          { declarationId: declaration.declarationId, valid: { $ne: false } },
          signatureVersionFilter(baseVersion)
        ]
      }).select("_id signatureId").session(session).lean();
      if (priorSignature) {
        if (!signatureStorageReady) throw new RouteError(409, "A new versioned signature cannot be stored until signature versioning is enabled", "SIGNATURE_VERSIONING_REQUIRED");
        const invalidatedAt = new Date();
        const invalidated = await Signature.findOneAndUpdate({
          _id: priorSignature._id,
          valid: { $ne: false },
          ...signatureVersionFilter(baseVersion)
        }, {
          $set: {
            valid: false,
            invalidatedAt,
            invalidatedBy: req.user.username,
            invalidatedByCorrectionRequestId: request.requestId
          }
        }, { new: true, session, runValidators: true });
        if (!invalidated) throw new RouteError(409, "The current signature changed during correction approval", "CORRECTION_REQUEST_CONFLICT");
        await audit(req, "DECLARATION_SIGNATURE_INVALIDATED", declaration.declarationId, request.requestId, baseVersion, undefined, session);
      }

      const priorSnapshot = await DeclarationVersion.findOne({ declarationId: declaration.declarationId, version: baseVersion }).session(session).lean();
      if (!priorSnapshot && baseVersion === 1) await persistDeclarationVersion(buildInitialVersionSnapshot(declaration, { createdBy: String(req.user.id) }), { session });
      else if (!priorSnapshot) throw new RouteError(409, "The current declaration version snapshot is missing", "DECLARATION_VERSION_SNAPSHOT_MISSING");
      const snapshot = buildNextVersionSnapshot(declaration, request.proposedChanges, { createdBy: String(req.user.id), correctionRequestId: request.requestId });
      const nextVersion = baseVersion + 1;
      const declarationFilter = {
        _id: declaration._id, declarationId: request.declarationId, hospitalId: request.hospitalId,
        centreId: request.centreId, status: "SUBMITTED", pendingCorrectionRequestId: request.requestId,
        ...versionFilter(baseVersion)
      };
      const updatedDeclaration = await Declaration.findOneAndUpdate(declarationFilter, {
        $set: { declarationData: snapshot.declarationData, currentVersion: nextVersion },
        $unset: { pendingCorrectionRequestId: 1 }
      }, { new: true, session, runValidators: true });
      if (!updatedDeclaration) throw new RouteError(409, "Declaration changed during approval", "CORRECTION_REQUEST_CONFLICT");
      const approved = await DeclarationCorrectionRequest.findOneAndUpdate({ _id: request._id, status: "PENDING_REVIEW", baseVersion }, {
        $set: { status: "APPROVED", reviewedBy: req.user.username, reviewedAt: new Date(), resultingVersion: nextVersion }
      }, { new: true, session, runValidators: true });
      if (!approved) throw new RouteError(409, "Correction request changed during approval", "CORRECTION_REQUEST_CONFLICT");
      await persistDeclarationVersion(snapshot, { session });
      await audit(req, "DECLARATION_CORRECTION_APPROVED", declaration.declarationId, request.requestId, baseVersion, nextVersion, session);
      return { requestId: approved.requestId, declarationId: declaration.declarationId, status: approved.status, resultingVersion: nextVersion, declarationStatus: updatedDeclaration.status };
    });
    return res.json({ success: true, message: "Correction approved and a new declaration version created", data: result });
  } catch (error) {
    return sendRouteError(res, error, { message: "Failed to approve correction request", errorCode: "CORRECTION_REQUEST_APPROVE_ERROR" });
  }
});

router.post("/correction-requests/:requestId/reject", requireAuth, allowRoles("SUPER_ADMIN", "ART_BANK_ADMIN"), async (req, res) => {
  let reason;
  try { reason = validateReviewReason(req.body?.reason); }
  catch (error) { return res.status(400).json({ success: false, message: error.message, errorCode: "CORRECTION_REVIEW_REASON_REQUIRED" }); }
  try {
    const result = await withTransaction(async session => {
      const request = await DeclarationCorrectionRequest.findOne({ requestId: req.params.requestId, status: "PENDING_REVIEW" }).session(session);
      if (!request) throw new RouteError(409, "Correction request is no longer pending review", "CORRECTION_REQUEST_NOT_PENDING");
      const rejected = await DeclarationCorrectionRequest.findOneAndUpdate({ _id: request._id, status: "PENDING_REVIEW", baseVersion: request.baseVersion }, {
        $set: { status: "REVISION_REQUIRED", reviewedBy: req.user.username, reviewedAt: new Date(), reviewReason: reason }
      }, { new: true, session, runValidators: true });
      if (!rejected) throw new RouteError(409, "Correction request changed during review", "CORRECTION_REQUEST_CONFLICT");
      const cleared = await Declaration.findOneAndUpdate({ declarationId: request.declarationId, hospitalId: request.hospitalId, centreId: request.centreId, status: "SUBMITTED", pendingCorrectionRequestId: request.requestId }, {
        $unset: { pendingCorrectionRequestId: 1 }
      }, { new: true, session });
      if (!cleared) throw new RouteError(409, "Declaration no longer matches the pending correction request", "CORRECTION_REQUEST_CONFLICT");
      await audit(req, "DECLARATION_CORRECTION_REJECTED", request.declarationId, request.requestId, request.baseVersion, undefined, session);
      return { requestId: rejected.requestId, declarationId: rejected.declarationId, status: rejected.status, reviewedAt: rejected.reviewedAt, reviewReason: rejected.reviewReason };
    });
    return res.json({ success: true, message: "Correction request returned for revision", data: result });
  } catch (error) {
    return sendRouteError(res, error, { message: "Failed to reject correction request", errorCode: "CORRECTION_REQUEST_REJECT_ERROR" });
  }
});

module.exports = router;
