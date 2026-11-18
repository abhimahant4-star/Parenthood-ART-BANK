"use strict";

const Signature = require("../models/Signature");
const { inspectSignatureIndexes } = require("./signatureIndexRolloutService");

function signatureVersionFilter(version) {
  if (!Number.isInteger(version) || version < 1) throw new TypeError("Signature version must be a positive integer");
  return version === 1
    ? { $or: [{ declarationVersion: 1 }, { declarationVersion: { $exists: false } }, { declarationVersion: null }] }
    : { declarationVersion: version };
}

function createSignatureVersioningService(SignatureModel = Signature) {
  async function hasValidVersionMetadata() {
    const presentCount = await SignatureModel.countDocuments({ declarationVersion: { $exists: true, $ne: null } });
    const [validResult] = await SignatureModel.aggregate([
      { $match: { declarationVersion: { $exists: true, $ne: null } } },
      { $match: { $expr: { $cond: [
        { $isNumber: "$declarationVersion" },
        { $and: [
          { $gte: ["$declarationVersion", 1] },
          { $eq: ["$declarationVersion", { $trunc: "$declarationVersion" }] }
        ] },
        false
      ] } } },
      { $count: "count" }
    ]);
    const validCount = validResult?.count || 0;
    const legacyCount = await SignatureModel.countDocuments({
      $or: [{ declarationVersion: { $exists: false } }, { declarationVersion: null }]
    });
    return presentCount === validCount && legacyCount === 0;
  }

  async function isVersionedSignatureStorageReady() {
    try {
      const indexes = await SignatureModel.collection.indexes();
      if (!inspectSignatureIndexes(indexes).ready) return false;
      return await hasValidVersionMetadata();
    } catch {
      // Fail closed when index state or metadata cannot be verified.
      return false;
    }
  }

  return { isVersionedSignatureStorageReady, hasValidVersionMetadata };
}

const defaultService = createSignatureVersioningService(Signature);

module.exports = { signatureVersionFilter, createSignatureVersioningService, ...defaultService };
