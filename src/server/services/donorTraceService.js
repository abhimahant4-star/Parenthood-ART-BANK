const Batch = require("../models/Batch");
const Vial = require("../models/Vial");
const { flexibleIdPattern, containsPattern } = require("../utils/flexibleSearch");

// Adds each donor's batch IDs and vial totals so lists and exports show the full traceability chain.
async function withTraceSummary(donors) {
  const donorIds = donors.map(donor => donor.donorId);
  if (!donorIds.length) return [];
  const [batches, vials] = await Promise.all([
    Batch.aggregate([
      { $match: { "donor.donorId": { $in: donorIds } } },
      { $sort: { collectionAt: 1 } },
      { $group: { _id: "$donor.donorId", batchIds: { $push: "$batchId" } } }
    ]),
    Vial.aggregate([
      { $match: { donorId: { $in: donorIds } } },
      { $group: { _id: "$donorId", total: { $sum: 1 }, available: { $sum: { $cond: [{ $eq: ["$status", "AVAILABLE_AT_ART_BANK"] }, 1, 0] } } } }
    ])
  ]);
  const batchMap = new Map(batches.map(item => [item._id, item.batchIds]));
  const vialMap = new Map(vials.map(item => [item._id, item]));
  return donors.map(donor => ({
    ...donor,
    trace: {
      batchIds: batchMap.get(donor.donorId) || [],
      vialTotal: vialMap.get(donor.donorId)?.total || 0,
      vialAvailable: vialMap.get(donor.donorId)?.available || 0
    }
  }));
}

const BLOOD_GROUPS = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"];

// Builds the shared donor list filter from search text, marital status, blood group and status.
function donorListFilter(query) {
  const filter = {};
  const search = String(query.q || "").trim().slice(0, 100);
  if (search) {
    const idPattern = flexibleIdPattern(search);
    filter.$or = [{ donorId: idPattern }, { uhid: idPattern }, { manualDonorId: idPattern }, { unitNumber: idPattern }, { name: containsPattern(search) }];
  }
  if (["MARRIED", "UNMARRIED"].includes(query.maritalStatus)) filter.maritalStatus = query.maritalStatus;
  if (BLOOD_GROUPS.includes(query.bloodGroup)) filter.bloodGroup = query.bloodGroup;
  if (["Active", "Inactive", "Retired"].includes(query.status)) filter.status = query.status === "Active" ? { $in: ["Active", null] } : query.status;
  return filter;
}

module.exports = { withTraceSummary, donorListFilter, BLOOD_GROUPS };
