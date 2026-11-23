"use strict";

// Super Admin edit and delete rules for donors, batches and vials.
// A record can be deleted only while nothing downstream depends on it, so the
// donor → batch → vial → hospital → couple → declaration chain is never broken.
const Donor = require("../models/Donor");
const Batch = require("../models/Batch");
const Vial = require("../models/Vial");
const Order = require("../models/Order");
const Couple = require("../models/Couple");
const Declaration = require("../models/Declaration");
const AuditLog = require("../models/AuditLog");
const { RouteError } = require("./transactionService");
const { addCalendarMonths } = require("./batchRules");

const STATUSES_THAT_LEFT_THE_BANK = ["DISPATCHED", "UNUSED_AT_HOSPITAL", "RETURNED_BEFORE_MAPPING", "MAPPED_USED"];
const STOCK_CLASSIFICATIONS = ["KARYOTYPE_TESTED", "NORMAL_STOCK"];

// Returns a plain-language reason the vials cannot be deleted, or null when they can.
async function vialDeletionBlocker(vials, session) {
  const moved = vials.find(vial => STATUSES_THAT_LEFT_THE_BANK.includes(vial.status) || vial.hospitalId);
  if (moved) return `Vial ${moved.vialId} has been sent to a hospital, so it is part of the traceability record and cannot be deleted.`;
  const vialIds = vials.map(vial => vial.vialId);
  if (!vialIds.length) return null;
  // Transaction reads run one at a time.
  const order = await Order.findOne({ vialIds: { $in: vialIds } }).select("orderId").session(session).lean();
  const couple = await Couple.findOne({ mappedVialIds: { $in: vialIds } }).select("coupleId").session(session).lean();
  const declaration = await Declaration.findOne({ vialIds: { $in: vialIds } }).select("declarationId").session(session).lean();
  if (order) return `These vials are part of hospital order ${order.orderId}, so they cannot be deleted.`;
  if (couple) return `These vials are mapped to couple case ${couple.coupleId}, so they cannot be deleted.`;
  if (declaration) return `These vials appear on declaration ${declaration.declarationId}, so they cannot be deleted.`;
  return null;
}

async function audit(req, session, action, entity, entityId, summary, newValues) {
  await AuditLog.create([{ userId: String(req.user.id), role: req.user.role, action, entity, entityId, summary, ip: req.ip, ...(newValues ? { newValues } : {}) }], { session });
}

// Keeps the donor's six-month collection rule correct after a batch is removed or re-dated.
async function refreshDonorLastCollection(donorId, session) {
  const latest = await Batch.findOne({ "donor.donorId": donorId }).sort({ collectionAt: -1 }).select("collectionAt").session(session).lean();
  await Donor.updateOne({ donorId }, latest ? { $set: { lastCollectionAt: latest.collectionAt } } : { $unset: { lastCollectionAt: 1 } }, { session });
}

async function deleteVial(req, vialId, session) {
  const vial = await Vial.findOne({ vialId }).session(session).lean();
  if (!vial) throw new RouteError(404, "Vial not found", "VIAL_NOT_FOUND");
  const blocker = await vialDeletionBlocker([vial], session);
  if (blocker) throw new RouteError(409, blocker, "VIAL_IN_USE");
  const siblings = await Vial.countDocuments({ batchId: vial.batchId }).session(session);
  if (siblings <= 1) throw new RouteError(409, `This is the only vial in batch ${vial.batchId}. Delete the batch instead.`, "LAST_VIAL_IN_BATCH");
  await Vial.deleteOne({ _id: vial._id }, { session });
  await Batch.updateOne({ batchId: vial.batchId }, { $inc: { vialCount: -1 } }, { session });
  await audit(req, session, "VIAL_DELETED", "VIAL", vial.vialId, "Vial deleted by Super Admin", { batchId: vial.batchId, status: vial.status });
  return { vialId: vial.vialId, batchId: vial.batchId };
}

async function deleteBatch(req, batchId, session) {
  const batch = await Batch.findOne({ batchId }).session(session).lean();
  if (!batch) throw new RouteError(404, "Batch not found", "BATCH_NOT_FOUND");
  const vials = await Vial.find({ batchId }).session(session).lean();
  const blocker = await vialDeletionBlocker(vials, session);
  if (blocker) throw new RouteError(409, blocker, "BATCH_IN_USE");
  await Vial.deleteMany({ batchId }, { session });
  await Batch.deleteOne({ _id: batch._id }, { session });
  if (batch.donor?.donorId) await refreshDonorLastCollection(batch.donor.donorId, session);
  await audit(req, session, "BATCH_DELETED", "BATCH", batch.batchId, "Batch and its vials deleted by Super Admin", { count: vials.length });
  return { batchId: batch.batchId, vialsDeleted: vials.length };
}

async function deleteDonor(req, donorId, session) {
  const donor = await Donor.findOne({ donorId }).session(session).lean();
  if (!donor) throw new RouteError(404, "Donor not found", "DONOR_NOT_FOUND");
  const batches = await Batch.countDocuments({ "donor.donorId": donorId }).session(session);
  const vials = await Vial.countDocuments({ donorId }).session(session);
  const orders = await Order.countDocuments({ donorId }).session(session);
  if (batches || vials) throw new RouteError(409, `This donor has ${batches} batch(es) and ${vials} vial(s). Delete those first, or mark the donor Inactive or Retired instead.`, "DONOR_HAS_COLLECTIONS");
  if (orders) throw new RouteError(409, "This donor is referenced by a hospital order, so the record cannot be deleted. Mark the donor Inactive or Retired instead.", "DONOR_IN_USE");
  await Donor.deleteOne({ _id: donor._id }, { session });
  await audit(req, session, "DONOR_DELETED", "DONOR", donor.uhid || donor.donorId, "Donor deleted by Super Admin");
  return { donorId: donor.donorId, uhid: donor.uhid };
}

async function updateVial(req, vialId, body, session) {
  const vial = await Vial.findOne({ vialId }).session(session);
  if (!vial) throw new RouteError(404, "Vial not found", "VIAL_NOT_FOUND");
  if (body.stockClassification === undefined) throw new RouteError(400, "Nothing to update", "NOTHING_TO_UPDATE");
  if (!STOCK_CLASSIFICATIONS.includes(body.stockClassification)) throw new RouteError(400, "Stock type must be Karyotype tested or Normal stock", "INVALID_STOCK_CLASSIFICATION");
  const previous = vial.stockClassification || "";
  vial.stockClassification = body.stockClassification;
  await vial.save({ session });
  await audit(req, session, "VIAL_UPDATED", "VIAL", vial.vialId, "Vial updated by Super Admin", { ...(previous ? { previousStatus: previous } : {}), status: body.stockClassification });
  return vial.toObject();
}

async function updateBatch(req, batchId, body, session) {
  const batch = await Batch.findOne({ batchId }).session(session);
  if (!batch) throw new RouteError(404, "Batch not found", "BATCH_NOT_FOUND");
  const changes = {};

  if (body.stockClassification !== undefined) {
    if (!STOCK_CLASSIFICATIONS.includes(body.stockClassification)) throw new RouteError(400, "Stock type must be Karyotype tested or Normal stock", "INVALID_STOCK_CLASSIFICATION");
    batch.stockClassification = body.stockClassification;
    // Vials still at the bank follow the batch; vials already sent keep the type they were sent with.
    await Vial.updateMany({ batchId, status: { $nin: STATUSES_THAT_LEFT_THE_BANK }, hospitalId: { $in: [null, ""] } }, { $set: { stockClassification: body.stockClassification } }, { session });
    changes.stockClassification = body.stockClassification;
  }
  if (body.notes !== undefined) {
    if (typeof body.notes !== "string" || body.notes.length > 1000) throw new RouteError(400, "Notes must be 1000 characters or fewer", "INVALID_NOTES");
    batch.notes = body.notes.trim();
    changes.notes = true;
  }
  if (body.collectionAt !== undefined) {
    if (batch.releaseStatus !== "QUARANTINED") throw new RouteError(409, "The collection date can only be changed while the batch is still in quarantine.", "BATCH_ALREADY_RELEASED");
    const value = String(body.collectionAt);
    const collectionAt = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00.000Z`) : null;
    if (!collectionAt || Number.isNaN(collectionAt.getTime()) || collectionAt.toISOString().slice(0, 10) !== value || collectionAt > new Date()) {
      throw new RouteError(400, "Enter a valid collection date that is today or earlier", "INVALID_BATCH_DATES");
    }
    const donorId = batch.donor?.donorId;
    const others = await Batch.find({ "donor.donorId": donorId, batchId: { $ne: batchId } }).select("batchId collectionAt").session(session).lean();
    const clash = others.find(other => {
      const [earlier, later] = [new Date(other.collectionAt), collectionAt].sort((a, b) => a - b);
      return later < addCalendarMonths(earlier, 6);
    });
    if (clash) throw new RouteError(409, `Collections from the same donor must be at least six months apart. Batch ${clash.batchId} was collected on ${new Date(clash.collectionAt).toISOString().slice(0, 10)}.`, "DONOR_COLLECTION_INTERVAL");
    const quarantineEnd = addCalendarMonths(collectionAt, 6);
    batch.collectionAt = collectionAt;
    batch.quarantineStart = collectionAt;
    batch.quarantineEnd = quarantineEnd;
    await Vial.updateMany({ batchId }, { $set: { quarantineEnd } }, { session });
    changes.collectionAt = value;
  }
  if (!Object.keys(changes).length) throw new RouteError(400, "Nothing to update", "NOTHING_TO_UPDATE");
  await batch.save({ session });
  if (changes.collectionAt && batch.donor?.donorId) await refreshDonorLastCollection(batch.donor.donorId, session);
  await audit(req, session, "BATCH_UPDATED", "BATCH", batch.batchId, "Batch updated by Super Admin", changes.stockClassification ? { status: changes.stockClassification } : undefined);
  return batch.toObject();
}

module.exports = { deleteVial, deleteBatch, deleteDonor, updateVial, updateBatch, vialDeletionBlocker, audit, STATUSES_THAT_LEFT_THE_BANK };
