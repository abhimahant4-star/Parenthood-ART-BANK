const router = require("../http/router").Router();
const { requireAuth, allowRoles } = require("../middleware/auth");

const Batch = require("../models/Batch");
const Vial = require("../models/Vial");
const Donor = require("../models/Donor");
const IdSequence = require("../models/IdSequence");
const { flexibleIdPattern } = require("../utils/flexibleSearch");
const { withTransaction, RouteError, sendRouteError } = require("../services/transactionService");
const { recordOperationalEvent } = require("../services/operationalAuditService");
const { parseCollectionDate, addCalendarMonths, nextCollectionDate, isAtOrAfterDate, isQuarantineComplete, formatBatchId, makeVialIds } = require("../services/batchRules");

async function nextBatchId() {
  // One running counter for short batch IDs (BAT-101, BAT-102, ...). Older ARTB-year IDs are kept as they are.
  const name = "batch-short";
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
  if (sequence.value > 9999899) {
    throw new RouteError(409, "The batch sequence has reached its limit.", "BATCH_SEQUENCE_EXHAUSTED");
  }
  return formatBatchId(sequence.value);
}

// =====================================================
// GET ALL BATCHES
// =====================================================

router.get(
  "/",
  requireAuth,
  allowRoles("SUPER_ADMIN", "ART_BANK_ADMIN", "ART_BANK_STAFF"),
  async (req, res) => {
    try {
      const now = new Date();
      const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 100, 1), 500);
      const skip = Math.min(Math.max(Number.parseInt(req.query.skip, 10) || 0, 0), 100000);
      const status = typeof req.query.status === "string" ? req.query.status.trim().toUpperCase() : "";
      if (status && !["QUARANTINED", "RELEASED"].includes(status)) {
        return res.status(400).json({ success: false, message: "Invalid batch status filter", errorCode: "INVALID_BATCH_STATUS" });
      }
      const search = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 100) : "";
      const filter = {};
      if (status) filter.releaseStatus = status;
      if (search) {
        const pattern = flexibleIdPattern(search);
        const matchingDonors = await Donor.find({ $or: [{ unitNumber: pattern }, { uhid: pattern }, { manualDonorId: pattern }] }).select("donorId").limit(500).lean();
        filter.$or = [
          { batchId: pattern },
          { "donor.donorId": pattern },
          { "donor.unitNumber": pattern },
          { "donor.donorId": { $in: matchingDonors.map(donor => donor.donorId) } }
        ];
      }
      const [batches, total, filteredTotal, releaseEligible] = await Promise.all([
        Batch.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit),
        Batch.countDocuments({}),
        Batch.countDocuments(filter),
        Batch.countDocuments({ releaseStatus: "QUARANTINED", quarantineEnd: { $lte: now } })
      ]);

      res.json({
        success: true,
        data: batches,
        summary: { total, releaseEligible },
        pagination: { skip, limit, total: filteredTotal, hasMore: skip + batches.length < filteredTotal }
      });

    } catch (error) {
      console.error(error);

      res.status(500).json({
        success: false,
        message: "Failed to fetch batches",
        errorCode: "BATCHES_FETCH_ERROR"
      });
    }
  }
);


// =====================================================
// CREATE BATCH
// =====================================================

router.post(
  "/",
  requireAuth,
  allowRoles("SUPER_ADMIN", "ART_BANK_ADMIN", "ART_BANK_STAFF"),
  async (req, res) => {
    try {
      const {
        donorId,
        batchDate,
        collectionAt,
        vialCount,
        quarantineEnd,
        bloodGroup,
        stockClassification,
        testing,
        repeatTest,
        notes
      } = req.body;

      const selectedBatchDate = batchDate ? new Date(batchDate) : new Date();
      const selectedStockClassification = stockClassification || "NORMAL_STOCK";
      if (!donorId || !collectionAt || !["KARYOTYPE_TESTED", "NORMAL_STOCK"].includes(selectedStockClassification) || !Number.isInteger(Number(vialCount)) || Number(vialCount) < 1 || Number(vialCount) > 5) {
        return res.status(400).json({ success: false, message: "A donor, collection date, and vial count from 1 to 5 are required", errorCode: "INVALID_BATCH" });
      }
      const collectionDate = parseCollectionDate(collectionAt);
      const today = new Date();
      const todayUtc = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
      if (Number.isNaN(selectedBatchDate.getTime()) || selectedBatchDate > new Date() || !collectionDate || collectionDate > todayUtc) {
        return res.status(400).json({ success: false, message: "Enter a valid collection date that is today or earlier", errorCode: "INVALID_BATCH_DATES" });
      }
      const start = new Date(collectionDate);
      const minimumQuarantineEnd = addCalendarMonths(start, 6);
      const selectedQuarantineEnd = quarantineEnd === undefined || quarantineEnd === ""
        ? minimumQuarantineEnd
        : parseCollectionDate(quarantineEnd);
      if (!selectedQuarantineEnd || selectedQuarantineEnd < minimumQuarantineEnd) {
        return res.status(400).json({ success: false, message: "Quarantine end date cannot be earlier than six months after collection", errorCode: "INVALID_QUARANTINE_END" });
      }
      const end = selectedQuarantineEnd;

      const batchId = await nextBatchId();
      const vialCreatedAt = new Date();
      const { batch, created } = await withTransaction(async session => {
        const donorRecord = await Donor.findOne({ $or: [{ donorId }, { uhid: String(donorId).toUpperCase() }] })
          .select("donorId unitNumber bloodGroup lastCollectionAt status").session(session).lean();
        if (!donorRecord) throw new RouteError(404, "Donor not found", "DONOR_NOT_FOUND");
        if (["Inactive", "Retired"].includes(donorRecord.status)) throw new RouteError(400, `${donorRecord.status} donors cannot be used for a new collection`, "DONOR_INACTIVE");
        const linkedDonorId = donorRecord.donorId;
        const latestBatch = await Batch.findOne({ "donor.donorId": linkedDonorId }).sort({ collectionAt: -1 }).select("collectionAt").session(session).lean();
        const priorCollection = [donorRecord.lastCollectionAt, latestBatch?.collectionAt].filter(Boolean).sort((a, b) => new Date(b) - new Date(a))[0];
        if (priorCollection) {
          const nextAllowed = nextCollectionDate(priorCollection);
          if (!isAtOrAfterDate(collectionDate, nextAllowed)) {
            throw new RouteError(400, `This donor's next collection can be recorded on or after ${nextAllowed.toISOString().slice(0, 10)}`, "DONOR_COLLECTION_INTERVAL", { nextAllowedDate: nextAllowed.toISOString().slice(0, 10) });
          }
        }
        const lastCollectionFilter = donorRecord.lastCollectionAt
          ? { lastCollectionAt: donorRecord.lastCollectionAt }
          : { $or: [{ lastCollectionAt: { $exists: false } }, { lastCollectionAt: null }] };
        const claimedCollectionSlot = await Donor.updateOne({ _id: donorRecord._id, ...lastCollectionFilter }, { $set: { lastCollectionAt: collectionDate } }, { session });
        if (claimedCollectionSlot.matchedCount !== 1) throw new RouteError(409, "Another collection was just recorded for this donor. Reload and check the six-month interval.", "DONOR_COLLECTION_CONFLICT");
        const linkedBloodGroup = String(donorRecord.bloodGroup || "").trim().toUpperCase();
        if (!linkedBloodGroup) throw new RouteError(400, "The selected donor does not have a blood group on record", "DONOR_BLOOD_GROUP_MISSING");
        const stableVialIds = makeVialIds(batchId, vialCount, linkedBloodGroup);

        const [createdBatch] = await Batch.create([{
          batchId,
          donor: { donorId: linkedDonorId, unitNumber: donorRecord.unitNumber },
          batchDate: selectedBatchDate,
          stockClassification: selectedStockClassification,
          collectionAt: collectionDate,
          vialCount: Number(vialCount),
          bloodGroup: linkedBloodGroup,
          testing: testing || {},
          repeatTest: repeatTest || {},
          notes: notes || "",
          documentsVerified: false,
          quarantineStart: start,
          quarantineEnd: end,
          releaseStatus: "QUARANTINED"
        }], { session });

        const vials = stableVialIds.map(vialId => ({
          vialId,
          donorId: linkedDonorId,
          batchId,
          bloodGroup: linkedBloodGroup,
          stockClassification: selectedStockClassification,
          quarantineEnd: end,
          currentLocation: "ART Bank",
          status: "QUARANTINED",
          statusHistory: [{ status: "QUARANTINED", at: vialCreatedAt }]
        }));
        const createdVials = await Vial.insertMany(vials, { session });
        await recordOperationalEvent({
          actorId: String(req.user.id), role: req.user.role, event: "BATCH_CREATED", entityId: batchId,
          metadata: { status: "QUARANTINED", count: createdVials.length }, ip: req.ip, session
        });
        return { batch: createdBatch, created: createdVials };
      });

      res.status(201).json({
        success: true,
        message: "Batch and individual vials created",
        data: {
          batch,
          vials: created
        }
      });

    } catch (error) {
      sendRouteError(res, error, { message: "Failed to create batch", errorCode: "BATCH_CREATE_ERROR" });
    }
  }
);


// =====================================================
// RELEASE BATCH FROM QUARANTINE
// =====================================================

router.post(
  "/:batchId/release",
  requireAuth,
  allowRoles("SUPER_ADMIN", "ART_BANK_ADMIN"),
  async (req, res) => {
    try {
      const { batchId } = req.params;
      const { releaseReason } = req.body;
      const releaseAt = new Date();

      const batch = await withTransaction(async session => {
        const current = await Batch.findOne({ batchId }).session(session);
        if (!current) throw new RouteError(404, "Batch not found", "BATCH_NOT_FOUND");
        if (current.releaseStatus !== "QUARANTINED") throw new RouteError(400, "Batch is not in quarantine", "INVALID_RELEASE_STATUS");
        const minimumQuarantineEnd = addCalendarMonths(new Date(current.collectionAt), 6);
        const requiredQuarantineEnd = current.quarantineEnd && current.quarantineEnd > minimumQuarantineEnd ? current.quarantineEnd : minimumQuarantineEnd;
        if (!isQuarantineComplete(requiredQuarantineEnd, releaseAt)) throw new RouteError(400, "The six-month quarantine period has not ended", "QUARANTINE_ACTIVE");

        const released = await Batch.findOneAndUpdate(
          { _id: current._id, releaseStatus: "QUARANTINED" },
          { $set: { releaseStatus: "RELEASED", approvedBy: req.user.username, notes: releaseReason || current.notes } },
          { new: true, session }
        );
        if (!released) throw new RouteError(400, "Batch is not in quarantine", "INVALID_RELEASE_STATUS");

        const vialUpdate = await Vial.updateMany(
          { batchId, status: "QUARANTINED" },
          {
            $set: { status: "AVAILABLE_AT_ART_BANK" },
            $push: { statusHistory: { status: "AVAILABLE_AT_ART_BANK", at: releaseAt, user: req.user.username } }
          },
          { session }
        );
        if (vialUpdate.modifiedCount !== Number(current.vialCount)) {
          throw new Error("Batch vial count does not match the quarantined vial count");
        }
        await recordOperationalEvent({
          actorId: String(req.user.id), role: req.user.role, event: "BATCH_RELEASED", entityId: batchId,
          metadata: { previousStatus: "QUARANTINED", status: "RELEASED", count: vialUpdate.modifiedCount }, ip: req.ip, session
        });
        return released;
      });

      res.json({
        success: true,
        message: "Batch released successfully",
        data: {
          batch
        }
      });

    } catch (error) {
      sendRouteError(res, error, { message: "Failed to release batch", errorCode: "BATCH_RELEASE_ERROR" });
    }
  }
);


module.exports = router;
