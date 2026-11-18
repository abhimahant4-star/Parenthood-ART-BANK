const router = require("../http/router").Router();
const path = require("path");
const crypto = require("crypto");
const { requireAuth, allowRoles } = require("../middleware/auth");
const { upload, storePrivateFile, readPrivateFile, deletePrivateFile, validateFileContent } = require("../middleware/privateUpload");
const { scanBuffer } = require("../services/malwareScanner");
const AuthorizedSigner = require("../models/AuthorizedSigner");
const Declaration = require("../models/Declaration");
const asyncHandler = require("../middleware/asyncHandler");
const { withTransaction } = require("../services/transactionService");
const { recordOperationalEvent } = require("../services/operationalAuditService");

const BANK = ["SUPER_ADMIN", "ART_BANK_ADMIN", "ART_BANK_STAFF"];
const view = signer => ({ signerId: signer.signerId, name: signer.name, designation: signer.designation, status: signer.status, version: signer.version, imageOriginalName: signer.imageOriginalName });

function signerUpload(req, res, next) {
  upload.single("signatureImage")(req, res, error => {
    if (!error) return next();
    if (error.code === "LIMIT_FILE_SIZE") return res.status(413).json({ success: false, message: "Signature image must be no larger than 10 MB", errorCode: "UPLOAD_FILE_TOO_LARGE" });
    return res.status(400).json({ success: false, message: "Signer upload was rejected", errorCode: "INVALID_UPLOAD" });
  });
}

router.get("/", requireAuth, allowRoles(...BANK), asyncHandler(async (req, res) => {
  const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 100, 1), 500);
  const skip = Math.min(Math.max(Number.parseInt(req.query.skip, 10) || 0, 0), 100000);
  const [signers, total] = await Promise.all([AuthorizedSigner.find().sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(), AuthorizedSigner.countDocuments()]);
  res.json({ success: true, data: signers.map(view), pagination: { skip, limit, total, hasMore: skip + signers.length < total } });
}));

router.post("/", requireAuth, allowRoles("SUPER_ADMIN"), signerUpload, async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, message: "A PNG or JPG signature image is required", errorCode: "SIGNER_IMAGE_REQUIRED" });
  if (!["image/png", "image/jpeg"].includes(req.file.mimetype)) {
    return res.status(400).json({ success: false, message: "Signature must be PNG or JPG", errorCode: "INVALID_SIGNER_IMAGE" });
  }
  let storageName;
  const name = String(req.body.name || "").trim(), designation = String(req.body.designation || "").trim();
  if (!name || !designation) {
    return res.status(400).json({ success: false, message: "Name and designation are required", errorCode: "SIGNER_DATA_REQUIRED" });
  }
  try {
    validateFileContent(req.file);
    await scanBuffer(req.file.buffer);
    storageName = await storePrivateFile(req.file.buffer);
    const safeOriginalName = path.basename(String(req.file.originalname || "").replace(/\\/g, "/"));
    const signerId = `SIGNER-${crypto.randomUUID()}`;
    const signer = await withTransaction(async session => {
      const [created] = await AuthorizedSigner.create([{ signerId, name, designation, imageStorageName: storageName, imageMimeType: req.file.mimetype, imageOriginalName: safeOriginalName, imageVersions: [{ version: 1, storageName, mimeType: req.file.mimetype, originalName: safeOriginalName }], createdBy: req.user.username, updatedBy: req.user.username }], { session });
      await recordOperationalEvent({ actorId: String(req.user.id), role: req.user.role, event: "SIGNER_CREATED", entityId: signerId, metadata: { version: created.version }, ip: req.ip, session });
      return created;
    });
    res.status(201).json({ success: true, data: view(signer) });
  } catch (error) {
    if (storageName) await deletePrivateFile(storageName).catch(() => {});
    res.status(500).json({ success: false, message: "Failed to create authorised signer", errorCode: "SIGNER_CREATE_ERROR" });
  }
});

router.put("/:signerId", requireAuth, allowRoles("SUPER_ADMIN"), signerUpload, asyncHandler(async (req, res) => {
  if (req.file && !["image/png", "image/jpeg"].includes(req.file.mimetype)) {
    return res.status(400).json({ success: false, message: "Signature must be PNG or JPG", errorCode: "INVALID_SIGNER_IMAGE" });
  }
  let newStorageName;
  if (req.file) { validateFileContent(req.file); await scanBuffer(req.file.buffer); newStorageName = await storePrivateFile(req.file.buffer); }
  let signer;
  try {
    signer = await withTransaction(async session => {
      const current = await AuthorizedSigner.findOne({ signerId: req.params.signerId }).session(session);
      if (!current) return null;
      if (Object.hasOwn(req.body, "name")) current.name = String(req.body.name).trim();
      if (Object.hasOwn(req.body, "designation")) current.designation = String(req.body.designation).trim();
      if (!current.name || !current.designation) {
        const error = new Error("Name and designation are required");
        error.status = 400;
        error.errorCode = "SIGNER_DATA_REQUIRED";
        throw error;
      }
      current.updatedBy = req.user.username; current.version += 1;
      if (req.file) { current.imageStorageName = newStorageName; current.imageMimeType = req.file.mimetype; current.imageOriginalName = path.basename(String(req.file.originalname || "").replace(/\\/g, "/")); }
      current.imageVersions.push({ version: current.version, storageName: current.imageStorageName, mimeType: current.imageMimeType, originalName: current.imageOriginalName });
      await current.save({ session });
      await recordOperationalEvent({ actorId: String(req.user.id), role: req.user.role, event: "SIGNER_UPDATED", entityId: current.signerId, metadata: { version: current.version }, ip: req.ip, session });
      return current;
    });
  } catch (error) { if (newStorageName) await deletePrivateFile(newStorageName).catch(() => {}); throw error; }
  if (!signer) { if (newStorageName) await deletePrivateFile(newStorageName).catch(() => {}); return res.status(404).json({ success: false, message: "Authorised signer not found", errorCode: "SIGNER_NOT_FOUND" }); }
  res.json({ success: true, data: view(signer) });
}));

router.patch("/:signerId/status", requireAuth, allowRoles("SUPER_ADMIN"), asyncHandler(async (req, res) => {
  if (!["ACTIVE", "INACTIVE"].includes(req.body.status)) return res.status(400).json({ success: false, message: "Status must be ACTIVE or INACTIVE", errorCode: "INVALID_SIGNER_STATUS" });
  const signer = await withTransaction(async session => {
    const current = await AuthorizedSigner.findOne({ signerId: req.params.signerId }).session(session);
    if (!current) return null;
    const previousStatus = current.status;
    current.status = req.body.status; current.updatedBy = req.user.username; current.version += 1;
    await current.save({ session });
    await recordOperationalEvent({ actorId: String(req.user.id), role: req.user.role, event: "SIGNER_STATUS_CHANGED", entityId: current.signerId, metadata: { previousStatus, status: current.status, version: current.version }, ip: req.ip, session });
    return current;
  });
  if (!signer) return res.status(404).json({ success: false, message: "Authorised signer not found", errorCode: "SIGNER_NOT_FOUND" });
  res.json({ success: true, data: view(signer) });
}));

router.get("/:signerId/image", requireAuth, allowRoles(...BANK, "HOSPITAL_USER"), asyncHandler(async (req, res) => {
  const signer = await AuthorizedSigner.findOne({ signerId: req.params.signerId }).lean();
  if (!signer) return res.status(404).json({ success: false, message: "Authorised signer not found", errorCode: "SIGNER_NOT_FOUND" });
  if (req.user.role === "HOSPITAL_USER") {
    if (!req.user.hospitalId || !req.user.centreId || !req.query.declarationId) return res.status(404).json({ success: false, message: "Signature image not found", errorCode: "SIGNATURE_IMAGE_NOT_FOUND" });
    const declaration = await Declaration.findOne({ declarationId: req.query.declarationId, hospitalId: req.user.hospitalId, centreId: req.user.centreId, status: { $in: ["SUBMITTED", "APPROVED"] }, signerId: signer.signerId }).select("signerSnapshot").lean();
    if (!declaration) return res.status(404).json({ success: false, message: "Signature image not found", errorCode: "SIGNATURE_IMAGE_NOT_FOUND" });
  }
  const imageVersion = signer.imageVersions?.find(item => Number(item.version) === Number(req.query.version)) || signer.imageVersions?.slice(-1)[0];
  const storageName = imageVersion?.storageName || signer.imageStorageName;
  const mimeType = imageVersion?.mimeType || signer.imageMimeType;
  if (!storageName) return res.status(404).json({ success: false, message: "Signature image unavailable", errorCode: "SIGNER_IMAGE_MISSING" });
  res.setHeader("Content-Type", mimeType); res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "private, no-store");
  res.send(await readPrivateFile(storageName));
}));

module.exports = router;
