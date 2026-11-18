const crypto = require("crypto");
const { requireAuth, allowRoles } = require("../middleware/auth");
const Signature = require("../models/Signature");
const Declaration = require("../models/Declaration");
const { encryptSensitiveString } = require("../middleware/privateUpload");
const { withTransaction, RouteError, sendRouteError } = require("../services/transactionService");
const { getEffectiveDeclarationVersion, isSignatureCurrentForDeclaration } = require("../services/declarationVersionService");
const { recordDeclarationCorrectionEvent } = require("../services/auditService");
const { signatureVersionFilter, isVersionedSignatureStorageReady: defaultStorageReady } = require("../services/signatureVersioningService");

function versionFilter(version) {
  return version === 1
    ? { $or: [{ currentVersion: 1 }, { currentVersion: { $exists: false } }, { currentVersion: null }] }
    : { currentVersion: version };
}

function scopedDeclarationFilter(req, declarationId) {
  const filter = { declarationId };
  if (req.user.role === "HOSPITAL_USER") {
    if (!req.user.hospitalId || !req.user.centreId) throw new RouteError(403, "Hospital account has no assigned hospital/centre", "HOSPITAL_SCOPE_MISSING");
    filter.hospitalId = req.user.hospitalId;
    filter.centreId = req.user.centreId;
  }
  return filter;
}

function createSignatureRouter(options = {}) {
  const router = require("../http/router").Router();
  const SignatureModel = options.SignatureModel || Signature;
  const DeclarationModel = options.DeclarationModel || Declaration;
  const storageReady = options.isStorageReady || defaultStorageReady;
  const recordSignatureAudit = options.recordAudit || recordDeclarationCorrectionEvent;

router.post("/", requireAuth, allowRoles("HOSPITAL_USER"), async (req, res) => {
  const { declarationId, signatureMethod, signatureData } = req.body || {};
  if (!declarationId || !signatureData) return res.status(400).json({ success: false, message: "declarationId and signatureData are required", errorCode: "SIGNATURE_DATA_REQUIRED" });
  if (typeof signatureData !== "string" || signatureData.length > 500000 || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(signatureData)) {
    return res.status(400).json({ success: false, message: "Signature must be a valid PNG drawing under 500 KB", errorCode: "INVALID_SIGNATURE_DATA" });
  }
  if (!req.user.hospitalId || !req.user.centreId) return res.status(403).json({ success: false, message: "Hospital account has no assigned hospital/centre", errorCode: "HOSPITAL_SCOPE_MISSING" });

  const stableSignatureId = `SIGN-${crypto.randomUUID()}`;
  const signedAt = new Date();
  const encryptedSignature = encryptSensitiveString(signatureData);
  const signatureStorageReady = await storageReady();
  try {
    const signature = await withTransaction(async session => {
      const declaration = await DeclarationModel.findOne(scopedDeclarationFilter(req, declarationId)).session(session);
      if (!declaration) throw new RouteError(404, "Declaration not found", "DECLARATION_NOT_FOUND");
      if (declaration.status !== "SUBMITTED") throw new RouteError(400, "Only submitted declarations can be signed", "DECLARATION_NOT_SUBMITTED");
      const declarationVersion = getEffectiveDeclarationVersion(declaration);
      if (declarationVersion > 1 && !signatureStorageReady) {
        throw new RouteError(409, "Versioned signatures are unavailable until the signature index rollout is complete", "SIGNATURE_VERSIONING_REQUIRED");
      }
      const existing = await SignatureModel.findOne({ $and: [{ declarationId }, signatureVersionFilter(declarationVersion)] }).select("_id").session(session).lean();
      if (existing) throw new RouteError(409, "Declaration is already signed for the current version", "SIGNATURE_ALREADY_EXISTS");

      const claimed = await DeclarationModel.findOneAndUpdate({
        _id: declaration._id, declarationId, hospitalId: req.user.hospitalId, centreId: req.user.centreId,
        status: "SUBMITTED", ...versionFilter(declarationVersion)
      }, { $set: { lastSignedVersion: declarationVersion } }, { new: true, session, runValidators: true });
      if (!claimed) throw new RouteError(409, "Declaration changed while signing; reload and try again", "STALE_DECLARATION_VERSION");

      const docs = await SignatureModel.create([{
        signatureId: stableSignatureId, declarationId, declarationVersion,
        coupleId: declaration.coupleId, hospitalId: declaration.hospitalId, centreId: declaration.centreId,
        signedBy: req.user.username, signatureMethod: signatureMethod || "DIGITAL",
        signatureData: encryptedSignature, signedAt, valid: true
      }], { session });
      await recordSignatureAudit({
        actorId: String(req.user.id), role: req.user.role, event: "DECLARATION_SIGNATURE_CREATED",
        declarationId, baseVersion: declarationVersion, ip: req.ip, session
      });
      return docs[0];
    });
    return res.status(201).json({
      success: true, message: "Declaration signed successfully",
      data: { signatureId: signature.signatureId, declarationId: signature.declarationId, declarationVersion: signature.declarationVersion, signedBy: signature.signedBy, signedAt: signature.signedAt }
    });
  } catch (error) {
    if (error?.code === 11000) return res.status(409).json({ success: false, message: "Declaration is already signed", errorCode: "SIGNATURE_ALREADY_EXISTS" });
    return sendRouteError(res, error, { message: "Failed to create signature", errorCode: "SIGNATURE_CREATE_ERROR" });
  }
});

router.get("/:declarationId/history", requireAuth, allowRoles("SUPER_ADMIN", "ART_BANK_ADMIN", "ART_BANK_STAFF", "HOSPITAL_USER"), async (req, res) => {
  try {
    const scope = req.user.role === "HOSPITAL_USER"
      ? { hospitalId: req.user.hospitalId, centreId: req.user.centreId }
      : {};
    if (req.user.role === "HOSPITAL_USER" && (!scope.hospitalId || !scope.centreId)) throw new RouteError(403, "Hospital account has no assigned hospital/centre", "HOSPITAL_SCOPE_MISSING");
    const declaration = await DeclarationModel.findOne({ declarationId: req.params.declarationId, ...scope }).select("declarationId currentVersion hospitalId centreId").lean();
    if (!declaration) return res.status(404).json({ success: false, message: "Signature not found", errorCode: "SIGNATURE_NOT_FOUND" });
    const signatures = await SignatureModel.find({ declarationId: declaration.declarationId, ...scope }).select("-signatureData").sort({ declarationVersion: 1, signedAt: 1 }).lean();
    const currentVersion = getEffectiveDeclarationVersion(declaration);
    return res.json({ success: true, data: { declarationId: declaration.declarationId, currentVersion, signatures: signatures.map(signature => ({ ...signature, declarationVersion: signature.declarationVersion == null ? 1 : signature.declarationVersion, current: isSignatureCurrentForDeclaration(signature, declaration) })) } });
  } catch (error) {
    if (error instanceof RouteError) return sendRouteError(res, error, { message: "Failed to fetch signature history", errorCode: "SIGNATURE_FETCH_ERROR" });
    console.error(error);
    return res.status(500).json({ success: false, message: "Failed to fetch signature history", errorCode: "SIGNATURE_FETCH_ERROR" });
  }
});

router.get("/:declarationId", requireAuth, allowRoles("SUPER_ADMIN", "ART_BANK_ADMIN", "ART_BANK_STAFF", "HOSPITAL_USER"), async (req, res) => {
  try {
    const scope = req.user.role === "HOSPITAL_USER"
      ? { hospitalId: req.user.hospitalId, centreId: req.user.centreId }
      : {};
    if (req.user.role === "HOSPITAL_USER" && (!scope.hospitalId || !scope.centreId)) throw new RouteError(403, "Hospital account has no assigned hospital/centre", "HOSPITAL_SCOPE_MISSING");
    const declaration = await DeclarationModel.findOne({ declarationId: req.params.declarationId, ...scope }).select("declarationId currentVersion hospitalId centreId").lean();
    if (!declaration) return res.status(404).json({ success: false, message: "Signature not found", errorCode: "SIGNATURE_NOT_FOUND" });
    const currentVersion = getEffectiveDeclarationVersion(declaration);
    const signature = await SignatureModel.findOne({
      $and: [
        { declarationId: declaration.declarationId, ...scope, valid: { $ne: false } },
        signatureVersionFilter(currentVersion)
      ]
    }).select("-signatureData").lean();
    if (!signature || !isSignatureCurrentForDeclaration(signature, declaration)) return res.status(404).json({ success: false, message: "Current signature not found", errorCode: "SIGNATURE_NOT_FOUND" });
    return res.json({ success: true, data: { ...signature, declarationVersion: signature.declarationVersion == null ? 1 : signature.declarationVersion, current: true } });
  } catch (error) {
    if (error instanceof RouteError) return sendRouteError(res, error, { message: "Failed to fetch signature", errorCode: "SIGNATURE_FETCH_ERROR" });
    console.error(error);
    return res.status(500).json({ success: false, message: "Failed to fetch signature", errorCode: "SIGNATURE_FETCH_ERROR" });
  }
});

  return router;
}

module.exports = createSignatureRouter();
module.exports.createSignatureRouter = createSignatureRouter;
