const router = require("../http/router").Router();
const path = require("path");
const crypto = require("crypto");
const { requireAuth, allowRoles } = require("../middleware/auth");
const { upload, storePrivateFile, readPrivateFile, deletePrivateFile, validateFileContent } = require("../middleware/privateUpload");
const { scanBuffer } = require("../services/malwareScanner");
const Attachment = require("../models/Attachment");
const Couple = require("../models/Couple");
const User = require("../models/User");
const Batch = require("../models/Batch");
const Donor = require("../models/Donor");
const Vial = require("../models/Vial");
const { withTransaction, RouteError } = require("../services/transactionService");
const { recordOperationalEvent } = require("../services/operationalAuditService");
const { applyStaffAttachmentScope, applyHospitalAttachmentVisibility, applyAttachmentQueryFilters } = require("../services/attachmentPrivacyService");

const BANK_ROLES = ["SUPER_ADMIN", "ART_BANK_ADMIN", "ART_BANK_STAFF"];
const ALL_ROLES = [...BANK_ROLES, "HOSPITAL_USER"];
const publicFile = file => ({ fileId: file.fileId, originalName: file.originalName, label: file.label, mimeType: file.mimeType, size: file.size });
const publicPackage = record => ({ ...record.toObject(), files: record.files.map(publicFile) });

async function hospitalAttachmentFilter(user) {
  if (!user.hospitalId || !user.centreId) return null;
  const assigned = { hospitalId: user.hospitalId, centreId: user.centreId };
  applyHospitalAttachmentVisibility(assigned, user.username);
  const donorIds = await Vial.distinct("donorId", {
    hospitalId: user.hospitalId, centreId: user.centreId,
    status: { $in: ["DISPATCHED", "UNUSED_AT_HOSPITAL", "MAPPED_USED"] }
  });
  return { $or: [
    assigned,
    { category: "DONOR_DOCUMENT", relatedId: { $in: donorIds }, status: "SUBMITTED" }
  ] };
}

router.get("/", requireAuth, allowRoles(...ALL_ROLES), async (req, res) => {
  try {
    const filter = applyStaffAttachmentScope({}, req.user);
    if (req.user.role === "HOSPITAL_USER") {
      const hospitalFilter = await hospitalAttachmentFilter(req.user);
      if (!hospitalFilter) return res.status(403).json({ success: false, message: "Hospital account has no assigned hospital/centre", errorCode: "HOSPITAL_SCOPE_MISSING" });
      Object.assign(filter, hospitalFilter);
    }
    applyAttachmentQueryFilters(filter, req.query);
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 100, 1), 500);
    const skip = Math.min(Math.max(Number.parseInt(req.query.skip, 10) || 0, 0), 100000);
    const [records, total] = await Promise.all([Attachment.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit), Attachment.countDocuments(filter)]);
    res.json({ success: true, data: records.map(publicPackage), pagination: { skip, limit, total, hasMore: skip + records.length < total } });
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to fetch attachments", errorCode: "ATTACHMENTS_FETCH_ERROR" });
  }
});

router.post("/", requireAuth, allowRoles(...ALL_ROLES), (req, res, next) => {
  upload.array("files", 5)(req, res, async error => {
    if (!error) return next();
    if (error.code === "LIMIT_FILE_SIZE") return res.status(413).json({ success: false, message: "Each uploaded file must be no larger than 10 MB", errorCode: "UPLOAD_FILE_TOO_LARGE" });
    if (error.code === "LIMIT_FILE_COUNT") return res.status(400).json({ success: false, message: "An attachment package can contain at most 5 files", errorCode: "UPLOAD_FILE_COUNT_EXCEEDED" });
    return res.status(400).json({ success: false, message: error.message || "Upload rejected", errorCode: "INVALID_UPLOAD" });
  });
}, async (req, res) => {
  const storedFiles = [];
  try {
    let metadata;
    try { metadata = JSON.parse(req.body.metadata || "{}"); }
    catch { return res.status(400).json({ success: false, message: "Attachment metadata must be valid JSON", errorCode: "INVALID_ATTACHMENT_METADATA" }); }
    let { hospitalId, centreId, relatedId = "", category, label, fileLabels = [] } = metadata;
    if (!category || !label || !req.files?.length || (category !== "DONOR_DOCUMENT" && (!hospitalId || !centreId))) {
      return res.status(400).json({ success: false, message: "Hospital, centre, category, package label and at least one file are required", errorCode: "ATTACHMENT_DATA_REQUIRED" });
    }
    if (req.files.reduce((total, file) => total + file.size, 0) > 50 * 1024 * 1024) {
      return res.status(413).json({ success: false, message: "A package cannot exceed 50 MB in total", errorCode: "ATTACHMENT_PACKAGE_TOO_LARGE" });
    }
    if (category === "BATCH_DOCUMENT" && !relatedId) return res.status(400).json({ success: false, message: "Batch ID is required for batch documents", errorCode: "BATCH_ID_REQUIRED" });
    if (category === "DONOR_DOCUMENT") {
      if (!BANK_ROLES.includes(req.user.role)) return res.status(403).json({ success: false, message: "Only ART Bank roles may upload donor documents", errorCode: "ATTACHMENT_TYPE_DENIED" });
      if (!relatedId || !await Donor.exists({ donorId: relatedId })) return res.status(404).json({ success: false, message: "Donor not found", errorCode: "DONOR_NOT_FOUND" });
      hospitalId = "ART_BANK";
      centreId = "ART_BANK";
    }
    if (req.user.role === "HOSPITAL_USER") {
      if (!req.user.hospitalId || !req.user.centreId || hospitalId !== req.user.hospitalId || centreId !== req.user.centreId) {
        return res.status(403).json({ success: false, message: "You may upload only for your assigned hospital and centre", errorCode: "HOSPITAL_SCOPE_DENIED" });
      }
      if (category === "BATCH_DOCUMENT" && !BANK_ROLES.includes(req.user.role)) return res.status(403).json({ success: false, message: "Only ART Bank staff may upload batch documents", errorCode: "ATTACHMENT_TYPE_DENIED" });
      const assignedScope = category === "BATCH_DOCUMENT" ? true : await User.exists({ role: "HOSPITAL_USER", active: true, hospitalId, centreId });
      if (!assignedScope) return res.status(400).json({ success: false, message: "No active hospital user is assigned to the selected hospital and centre", errorCode: "HOSPITAL_SCOPE_NOT_FOUND" });
      if (category !== "IDENTITY_DOCUMENT" || !relatedId) return res.status(403).json({ success: false, message: "Hospital users may upload identity documents only for their own couple cases", errorCode: "ATTACHMENT_TYPE_DENIED" });
      const couple = await Couple.findOne({ coupleId: relatedId, hospitalId, centreId }).select("coupleId").lean();
      if (!couple) return res.status(404).json({ success: false, message: "Couple case not found in this hospital/centre", errorCode: "COUPLE_NOT_FOUND" });
    }
    if (!BANK_ROLES.includes(req.user.role) && req.user.role !== "HOSPITAL_USER") return res.status(403).json({ success: false, message: "Permission denied", errorCode: "FORBIDDEN" });

    const labels = Array.isArray(fileLabels) ? fileLabels : [];
    for (const file of req.files) {
      validateFileContent(file);
      await scanBuffer(file.buffer);
      storedFiles.push(await storePrivateFile(file.buffer));
    }
    const attachmentId = `ATT-${crypto.randomUUID()}`;
    const files = req.files.map((file, index) => ({ fileId: crypto.randomUUID(), originalName: path.basename(String(file.originalname || "").replace(/\\/g, "/")), label: String(labels[index] || "").slice(0, 120), storageName: storedFiles[index], mimeType: file.mimetype, size: file.size }));
    const record = await withTransaction(async session => {
      if (category === "BATCH_DOCUMENT" && !await Batch.findOne({ batchId: relatedId }).select("_id").session(session).lean()) {
        throw new RouteError(404, "Batch not found", "BATCH_NOT_FOUND");
      }
      const [created] = await Attachment.create([{
        attachmentId, hospitalId, centreId, relatedId,
        category, label, status: category === "DONOR_DOCUMENT" ? "SUBMITTED" : "DRAFT",
        ...(category === "DONOR_DOCUMENT" ? { submittedBy: req.user.username, submittedAt: new Date() } : {}),
        createdBy: req.user.username, files
      }], { session });
      if (category === "BATCH_DOCUMENT") {
        const linked = await Batch.updateOne({ batchId: relatedId }, { $set: { documentsVerified: true }, $push: { attachments: created._id } }, { session });
        if (linked.matchedCount !== 1) throw new RouteError(404, "Batch not found", "BATCH_NOT_FOUND");
      }
      await recordOperationalEvent({ actorId: String(req.user.id), role: req.user.role, event: "ATTACHMENT_UPLOADED", entityId: attachmentId, metadata: { attachmentId, hospitalId, centreId, category, relatedId, count: files.length }, ip: req.ip, session });
      return created;
    });
    res.status(201).json({ success: true, data: publicPackage(record) });
  } catch (error) {
    await Promise.all(storedFiles.map(file => deletePrivateFile(file).catch(() => {})));
    if (error instanceof RouteError) return res.status(error.status).json({ success: false, message: error.message, errorCode: error.errorCode });
    if (error.code === "FILE_CONTENT_MISMATCH") return res.status(400).json({ success: false, message: "File contents do not match the declared file type", errorCode: "INVALID_FILE_CONTENT" });
    if (error.code === "MALWARE_DETECTED") return res.status(422).json({ success: false, message: "The uploaded file was rejected by malware scanning", errorCode: "MALWARE_DETECTED" });
    if (error.code === "SCANNER_UNAVAILABLE") return res.status(503).json({ success: false, message: "File scanning is temporarily unavailable; try again later", errorCode: "FILE_SCANNER_UNAVAILABLE" });
    console.error("Attachment upload failed", { errorName: error?.name || "Error", errorCode: error?.code || "ATTACHMENT_UPLOAD_ERROR" });
    res.status(500).json({ success: false, message: "Failed to save uploaded files", errorCode: "ATTACHMENT_UPLOAD_ERROR" });
  }
});

router.patch("/:attachmentId/visibility", requireAuth, allowRoles(...BANK_ROLES), async (req, res) => {
  try {
    if (!["SUBMITTED", "DRAFT"].includes(req.body.status)) return res.status(400).json({ success: false, message: "Visibility status must be SUBMITTED or DRAFT", errorCode: "INVALID_ATTACHMENT_STATUS" });
    const attachment = await withTransaction(async session => {
      const current = await Attachment.findOne(applyStaffAttachmentScope({ attachmentId: req.params.attachmentId }, req.user)).session(session);
      if (!current) throw new RouteError(404, "Attachment package not found", "ATTACHMENT_NOT_FOUND");
      if (current.category === "DONOR_DOCUMENT") throw new RouteError(409, "Donor documents remain submitted and cannot be hidden", "DONOR_DOCUMENT_VISIBILITY_LOCKED");
      current.status = req.body.status;
      current.submittedBy = req.body.status === "SUBMITTED" ? req.user.username : undefined;
      current.submittedAt = req.body.status === "SUBMITTED" ? new Date() : undefined;
      await current.save({ session });
      await recordOperationalEvent({ actorId: String(req.user.id), role: req.user.role, event: req.body.status === "SUBMITTED" ? "ATTACHMENT_SUBMITTED" : "ATTACHMENT_UNSUBMITTED", entityId: current.attachmentId, metadata: { attachmentId: current.attachmentId, status: current.status, hospitalId: current.hospitalId, centreId: current.centreId }, ip: req.ip, session });
      return current;
    });
    res.json({ success: true, data: publicPackage(attachment) });
  } catch (error) {
    if (error instanceof RouteError) return res.status(error.status).json({ success: false, message: error.message, errorCode: error.errorCode });
    res.status(500).json({ success: false, message: "Failed to update attachment visibility", errorCode: "ATTACHMENT_VISIBILITY_ERROR" });
  }
});

router.get("/:attachmentId/files/:fileId", requireAuth, allowRoles(...ALL_ROLES), async (req, res) => {
  try {
    const filter = applyStaffAttachmentScope({ attachmentId: req.params.attachmentId }, req.user);
    if (req.user.role === "HOSPITAL_USER") {
      const hospitalFilter = await hospitalAttachmentFilter(req.user);
      if (!hospitalFilter) return res.status(404).json({ success: false, message: "Attachment file not found", errorCode: "ATTACHMENT_NOT_FOUND" });
      Object.assign(filter, hospitalFilter);
    }
    const attachment = await Attachment.findOne(filter);
    if (!attachment) return res.status(404).json({ success: false, message: "Attachment package not found", errorCode: "ATTACHMENT_NOT_FOUND" });
    const file = attachment.files.find(item => item.fileId === req.params.fileId);
    if (!file) return res.status(404).json({ success: false, message: "Attachment file not found", errorCode: "ATTACHMENT_FILE_NOT_FOUND" });
    await recordOperationalEvent({ actorId: String(req.user.id), role: req.user.role, event: "ATTACHMENT_DOWNLOADED", entityId: attachment.attachmentId, metadata: { attachmentId: attachment.attachmentId, hospitalId: attachment.hospitalId, centreId: attachment.centreId }, ip: req.ip });
    res.setHeader("Content-Type", file.mimeType);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Disposition", `attachment; filename="${path.basename(file.originalName).replace(/[\"\r\n]/g, "_")}"`);
    res.send(await readPrivateFile(file.storageName));
  } catch (error) {
    if (error.code === "ENOENT") return res.status(404).json({ success: false, message: "Attachment file is missing from private storage", errorCode: "ATTACHMENT_FILE_MISSING" });
    res.status(500).json({ success: false, message: "Failed to retrieve attachment", errorCode: "ATTACHMENT_DOWNLOAD_ERROR" });
  }
});

module.exports = router;
