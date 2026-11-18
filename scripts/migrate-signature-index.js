"use strict";

// This operator tool is intentionally not imported by server.js. It defaults
// to read-only inspection. Applying changes requires explicit database,
// approval, backup, and paused-write acknowledgements.
const mongoose = require("mongoose");
const { inspectSignatureIndexes, VERSIONED_DECLARATION_INDEX } = require("../src/server/services/signatureIndexRolloutService");

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const argument = name => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};

function fail(message) {
  const error = new Error(message);
  error.exitCode = 2;
  error.operatorSafe = true;
  throw error;
}

function validateVersion(value) {
  return Number.isInteger(value) && value >= 1;
}

function validateInvocation({ uri, confirmation, applyMode, stage, approval, backupVerified, writesPaused }) {
  if (!uri) fail("MONGODB_URI is required; no connection was attempted");
  if (!confirmation) fail("Pass --confirm-database with the exact database name from MONGODB_URI");
  let parsed;
  try { parsed = new URL(uri); }
  catch { fail("MONGODB_URI is not a valid MongoDB URI"); }
  const requestedDatabase = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!requestedDatabase || requestedDatabase !== confirmation) fail("Database confirmation does not match MONGODB_URI");
  if (applyMode && (approval !== "YES" || backupVerified !== "YES" || writesPaused !== "YES")) {
    fail("Apply mode requires approval, verified backup, and paused signature writes acknowledgements");
  }
  if (applyMode && !["backfill", "create-compound-index", "drop-legacy-index"].includes(stage)) {
    fail("Apply mode requires --stage backfill, create-compound-index, or drop-legacy-index");
  }
  return { parsed, requestedDatabase };
}

async function countInvalidVersions(collection) {
  const [result] = await collection.aggregate([
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
  ]).toArray();
  const validCount = result?.count || 0;
  const presentCount = await collection.countDocuments({ declarationVersion: { $exists: true, $ne: null } });
  return presentCount - validCount;
}

async function countDuplicateVersionPairs(collection) {
  const [result] = await collection.aggregate([
    { $group: { _id: { declarationId: "$declarationId", version: { $ifNull: ["$declarationVersion", 1] } }, count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
    { $count: "count" }
  ]).toArray();
  return result?.count || 0;
}

async function countMissingDeclarationReferences(collection) {
  const [orphaned] = await collection.aggregate([
    { $lookup: { from: "declarations", localField: "declarationId", foreignField: "declarationId", as: "_declarationLookup" } },
    { $match: { $expr: { $eq: [{ $size: "$_declarationLookup" }, 0] } } },
    { $count: "count" }
  ]).toArray();
  return orphaned?.count || 0;
}

async function readState(collection) {
  const indexes = await collection.listIndexes().toArray();
  const indexState = inspectSignatureIndexes(indexes);
  const legacyMetadataCount = await collection.countDocuments({
    $or: [{ declarationVersion: { $exists: false } }, { declarationVersion: null }]
  });
  const invalidVersionCount = await countInvalidVersions(collection);
  const duplicateVersionPairCount = await countDuplicateVersionPairs(collection);
  const missingDeclarationReferenceCount = await countMissingDeclarationReferences(collection);
  return { indexes, indexState, legacyMetadataCount, invalidVersionCount, duplicateVersionPairCount, missingDeclarationReferenceCount };
}

function printState(state, databaseName) {
  console.log(`Signature index preflight for database: ${databaseName}`);
  console.log(`Legacy signatures needing version 1 metadata: ${state.legacyMetadataCount}`);
  console.log(`Malformed explicit version values: ${state.invalidVersionCount}`);
  console.log(`Duplicate declaration/version pairs: ${state.duplicateVersionPairCount}`);
  console.log(`Missing or unresolved declaration references: ${state.missingDeclarationReferenceCount}`);
  console.log(`signatureId unique index: ${state.indexState.signatureIdUnique?.name || "MISSING"}`);
  console.log(`legacy declarationId unique index: ${state.indexState.legacyDeclarationUnique?.name || "absent"}`);
  console.log(`versioned compound unique index: ${state.indexState.versionedDeclarationUnique?.name || "absent"}`);
}

async function assertWritableReplicaSet(connection) {
  const hello = await connection.db.admin().command({ hello: 1 });
  if (!hello.setName || hello.isWritablePrimary !== true) fail("Apply mode requires a writable primary in a replica set");
}

async function run() {
  const uri = process.env.MONGODB_URI;
  const confirmation = argument("--confirm-database");
  const stage = argument("--stage");
  const { requestedDatabase } = validateInvocation({
    uri, confirmation, applyMode: apply, stage,
    approval: process.env.SIGNATURE_INDEX_CHANGE_APPROVED,
    backupVerified: process.env.SIGNATURE_INDEX_BACKUP_VERIFIED,
    writesPaused: process.env.SIGNATURE_WRITES_PAUSED
  });

  await mongoose.connect(uri, { autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 10000 });
  try {
    if (mongoose.connection.name !== requestedDatabase) fail("Connected database does not match the confirmed database");
    if (apply) await assertWritableReplicaSet(mongoose.connection);
    const collection = mongoose.connection.db.collection("signatures");
    let state;
    try { state = await readState(collection); }
    catch (error) {
      if (error.codeName === "NamespaceNotFound" || error.code === 26) fail("Signature collection does not exist; refusing to create it");
      throw error;
    }
    printState(state, mongoose.connection.name);

    if (!state.indexState.signatureIdUnique) fail("signatureId unique index is missing; stop for manual review");
    if (state.invalidVersionCount || state.duplicateVersionPairCount || state.missingDeclarationReferenceCount) fail("Malformed versions, duplicate version pairs, or unresolved declaration references require a separate reviewed repair");
    if (state.indexState.conflictingVersionedIndex) fail("A non-unique compound index conflicts with the required rollout shape");

    if (!apply) {
      console.log("Read-only mode: no records or indexes were changed. Pass --apply only during an approved maintenance window.");
      return;
    }

    if (stage === "backfill") {
      if (state.legacyMetadataCount) {
        const result = await collection.updateMany(
          { $or: [{ declarationVersion: { $exists: false } }, { declarationVersion: null }] },
          { $set: { declarationVersion: 1 } }
        );
        console.log(`Backfilled legacy version metadata on ${result.modifiedCount} signature records.`);
      }
      state = await readState(collection);
      if (state.legacyMetadataCount || state.invalidVersionCount || state.duplicateVersionPairCount || state.missingDeclarationReferenceCount) {
        fail("Post-backfill verification failed; no index was changed");
      }
      printState(state, mongoose.connection.name);
      console.log("Backfill stage completed. Review this output before separately authorizing compound-index creation.");
      return;
    }

    if (stage === "create-compound-index") {
      if (state.legacyMetadataCount) fail("Backfill metadata first and review its verification output");
      if (!state.indexState.versionedDeclarationUnique) {
        await collection.createIndex(VERSIONED_DECLARATION_INDEX, { unique: true, name: "declarationId_1_declarationVersion_1" });
      }
      state = await readState(collection);
      if (!state.indexState.signatureIdUnique || !state.indexState.versionedDeclarationUnique || state.legacyMetadataCount || state.invalidVersionCount || state.duplicateVersionPairCount || state.missingDeclarationReferenceCount) {
        fail("Compound index stage verification failed; the legacy index was not removed");
      }
      printState(state, mongoose.connection.name);
      console.log("Compound index verified; legacy declarationId index remains in place. Review before separately authorizing its removal.");
      return;
    }

    if (stage === "drop-legacy-index") {
      if (state.legacyMetadataCount || !state.indexState.versionedDeclarationUnique) fail("Verify backfill and compound index before removing the legacy index");
      if (state.indexState.legacyDeclarationUnique) {
        const expectedName = argument("--drop-legacy-index");
        if (!expectedName) fail("Pass --drop-legacy-index with the exact legacy index name shown by preflight");
        if (state.indexState.legacyDeclarationUnique.name !== expectedName) fail("Legacy index name changed during rollout; refusing to remove it");
        await collection.dropIndex(expectedName);
      }
      state = await readState(collection);
      if (!state.indexState.ready || state.legacyMetadataCount || state.invalidVersionCount || state.duplicateVersionPairCount || state.missingDeclarationReferenceCount) {
        fail("Final signature index or metadata verification failed");
      }
      printState(state, mongoose.connection.name);
      console.log("Signature version index rollout completed and verified.");
      return;
    }
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  run().catch(error => {
    if (error.operatorSafe) console.error(error.message);
    else console.error("Signature index rollout failed; error code:", error.codeName || error.code || "UNCLASSIFIED");
    process.exitCode = error.exitCode || 1;
  });
}

module.exports = { validateVersion, validateInvocation, countInvalidVersions, countDuplicateVersionPairs, countMissingDeclarationReferences, run };
