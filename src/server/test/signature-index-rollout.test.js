const { test } = require("node:test");
const assert = require("node:assert/strict");
const { inspectSignatureIndexes } = require("../services/signatureIndexRolloutService");
const { validateVersion, validateInvocation, countInvalidVersions, countDuplicateVersionPairs, countMissingDeclarationReferences } = require("../../../scripts/migrate-signature-index");
const Signature = require("../models/Signature");
const { signatureVersionFilter, isVersionedSignatureStorageReady } = require("../services/signatureVersioningService");

const unique = (name, key) => ({ name, key, unique: true });

test("legacy unique declarationId index alone does not permit versioned signatures", () => {
  const state = inspectSignatureIndexes([
    unique("signatureId_1", { signatureId: 1 }),
    unique("declarationId_1", { declarationId: 1 })
  ]);
  assert.equal(state.ready, false);
  assert.equal(state.legacyDeclarationUnique.name, "declarationId_1");
  assert.equal(state.versionedDeclarationUnique, undefined);
});

test("compound index is not rollout-ready while the legacy unique index remains", () => {
  const state = inspectSignatureIndexes([
    unique("signatureId_1", { signatureId: 1 }),
    unique("declarationId_1", { declarationId: 1 }),
    unique("declarationId_1_declarationVersion_1", { declarationId: 1, declarationVersion: 1 })
  ]);
  assert.equal(state.ready, false);
});

test("final index shape requires signatureId uniqueness and only the versioned declaration uniqueness", () => {
  const state = inspectSignatureIndexes([
    unique("signatureId_1", { signatureId: 1 }),
    { name: "declarationId_1", key: { declarationId: 1 }, unique: false },
    unique("declarationId_1_declarationVersion_1", { declarationId: 1, declarationVersion: 1 })
  ]);
  assert.equal(state.ready, true);
});

test("a missing signatureId index or non-unique compound index is not accepted", () => {
  const missingSignatureId = inspectSignatureIndexes([
    unique("declarationId_1_declarationVersion_1", { declarationId: 1, declarationVersion: 1 })
  ]);
  const nonUniqueCompound = inspectSignatureIndexes([
    unique("signatureId_1", { signatureId: 1 }),
    { name: "declarationId_1_declarationVersion_1", key: { declarationId: 1, declarationVersion: 1 }, unique: false }
  ]);
  assert.equal(missingSignatureId.ready, false);
  assert.equal(nonUniqueCompound.ready, false);
  assert.ok(nonUniqueCompound.conflictingVersionedIndex);
});

test("MongoDB listIndexes entries without unique:false are treated as non-unique", () => {
  const state = inspectSignatureIndexes([
    unique("signatureId_1", { signatureId: 1 }),
    { name: "declarationId_1_declarationVersion_1", key: { declarationId: 1, declarationVersion: 1 } }
  ]);
  assert.equal(state.ready, false);
  assert.ok(state.conflictingVersionedIndex);
});

test("partial or sparse unique indexes are not mistaken for the rollout indexes", () => {
  const state = inspectSignatureIndexes([
    { ...unique("signatureId_1", { signatureId: 1 }), sparse: true },
    unique("declarationId_1", { declarationId: 1 }),
    { ...unique("declarationId_1_declarationVersion_1", { declarationId: 1, declarationVersion: 1 }), partialFilterExpression: { valid: true } }
  ]);
  assert.equal(state.ready, false);
  assert.equal(state.signatureIdUnique, undefined);
  assert.equal(state.versionedDeclarationUnique, undefined);
});

test("rollout version validator accepts only positive integers", () => {
  assert.equal(validateVersion(1), true);
  assert.equal(validateVersion(2), true);
  for (const invalid of [0, -1, 1.5, "1", null, undefined]) assert.equal(validateVersion(invalid), false);
});

test("rollout integrity counters use read-only aggregate/count operations", async () => {
  const pipelines = [];
  const collection = {
    aggregate(pipeline) {
      pipelines.push(pipeline);
      const count = pipeline.some(stage => stage.$group) ? 2 : pipeline.some(stage => stage.$lookup) ? 3 : 4;
      return { toArray: async () => [{ count }] };
    },
    countDocuments: async filter => {
      assert.deepEqual(filter, { declarationVersion: { $exists: true, $ne: null } });
      return 6;
    }
  };
  assert.equal(await countInvalidVersions(collection), 2);
  assert.equal(await countDuplicateVersionPairs(collection), 2);
  assert.equal(await countMissingDeclarationReferences(collection), 3);
  assert.equal(pipelines.length, 3);
  assert.ok(pipelines.some(pipeline => pipeline.some(stage => stage.$lookup?.from === "declarations")));
});

test("rollout invocation refuses missing or mismatched target database before connecting", () => {
  assert.throws(() => validateInvocation({ confirmation: "parenthood_phase1_test" }), /MONGODB_URI is required; no connection was attempted/);
  assert.throws(() => validateInvocation({ uri: "mongodb://mongo-test:27017/parenthood_phase1_test", confirmation: "another_database" }), /Database confirmation does not match MONGODB_URI/);
});

test("rollout apply mode refuses to connect without separate approval acknowledgements", () => {
  assert.throws(() => validateInvocation({
    uri: "mongodb://mongo-test:27017/parenthood_phase1_test",
    confirmation: "parenthood_phase1_test",
    applyMode: true,
    approval: "YES", backupVerified: "YES", writesPaused: "YES"
  }), /requires --stage backfill, create-compound-index, or drop-legacy-index/);
  assert.throws(() => validateInvocation({
    uri: "mongodb://mongo-test:27017/parenthood_phase1_test",
    confirmation: "parenthood_phase1_test",
    applyMode: true,
    stage: "backfill"
  }), /requires approval, verified backup, and paused signature writes acknowledgements/);
  assert.deepEqual(validateInvocation({
    uri: "mongodb://mongo-test:27017/parenthood_phase1_test",
    confirmation: "parenthood_phase1_test",
    applyMode: false
  }).requestedDatabase, "parenthood_phase1_test");
});

test("signature filters match legacy signatures only as version one", () => {
  assert.deepEqual(signatureVersionFilter(1), {
    $or: [{ declarationVersion: 1 }, { declarationVersion: { $exists: false } }, { declarationVersion: null }]
  });
  assert.deepEqual(signatureVersionFilter(2), { declarationVersion: 2 });
  assert.throws(() => signatureVersionFilter(0), /positive integer/);
});

test("versioned signature operations require final indexes and complete valid metadata", async () => {
  const originals = {
    indexes: Signature.collection.indexes,
    countDocuments: Signature.countDocuments,
    aggregate: Signature.aggregate
  };
  let indexes = [
    unique("signatureId_1", { signatureId: 1 }),
    { name: "declarationId_1", key: { declarationId: 1 } },
    unique("declarationId_1_declarationVersion_1", { declarationId: 1, declarationVersion: 1 })
  ];
  let legacyCount = 0;
  Signature.collection.indexes = async () => indexes;
  Signature.countDocuments = async filter => filter.$or ? legacyCount : 2;
  Signature.aggregate = async () => [{ count: 2 }];
  try {
    assert.equal(await isVersionedSignatureStorageReady(), true);
    indexes = [unique("signatureId_1", { signatureId: 1 }), unique("declarationId_1", { declarationId: 1 })];
    assert.equal(await isVersionedSignatureStorageReady(), false);
    indexes = [
      unique("signatureId_1", { signatureId: 1 }),
      { name: "declarationId_1", key: { declarationId: 1 } },
      unique("declarationId_1_declarationVersion_1", { declarationId: 1, declarationVersion: 1 })
    ];
    legacyCount = 1;
    assert.equal(await isVersionedSignatureStorageReady(), false);
  } finally {
    Signature.collection.indexes = originals.indexes;
    Signature.countDocuments = originals.countDocuments;
    Signature.aggregate = originals.aggregate;
  }
});
