const mongoose = require("mongoose");
const DeclarationVersion = require("../models/DeclarationVersion");
const { validateProposedChanges } = require("./declarationCorrectionService");

const EDITABLE_FIELDS = new Set(["date", "statement"]);

function deepClone(value, seen = new WeakMap()) {
  if (value == null || typeof value !== "object") return value;
  if (value instanceof Date) return new Date(value.getTime());
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value._bsontype === "ObjectId" && typeof value.toHexString === "function") {
    return new mongoose.Types.ObjectId(value.toHexString());
  }
  if (typeof value.toObject === "function") {
    return deepClone(value.toObject({ depopulate: true, getters: false, virtuals: false }), seen);
  }
  if (seen.has(value)) return seen.get(value);
  if (Array.isArray(value)) {
    const copy = [];
    seen.set(value, copy);
    for (const item of value) copy.push(deepClone(item, seen));
    return copy;
  }
  if (value instanceof Map) {
    const copy = new Map();
    seen.set(value, copy);
    for (const [key, item] of value) copy.set(deepClone(key, seen), deepClone(item, seen));
    return copy;
  }
  if (value instanceof Set) {
    const copy = new Set();
    seen.set(value, copy);
    for (const item of value) copy.add(deepClone(item, seen));
    return copy;
  }
  const copy = Object.create(Object.getPrototypeOf(value) === null ? null : Object.prototype);
  seen.set(value, copy);
  for (const key of Object.keys(value)) copy[key] = deepClone(value[key], seen);
  return copy;
}

function effectiveVersion(value, field) {
  const version = value?.[field];
  if (version == null) return 1;
  if (!Number.isInteger(version) || version < 1) throw new TypeError(`${field} must be a positive integer`);
  return version;
}

function getEffectiveDeclarationVersion(declaration) {
  return effectiveVersion(declaration, "currentVersion");
}

function getEffectiveSignatureVersion(signature) {
  return effectiveVersion(signature, "declarationVersion");
}

function isSignatureCurrentForDeclaration(signature, declaration) {
  const signatureVersion = getEffectiveSignatureVersion(signature);
  const currentVersion = getEffectiveDeclarationVersion(declaration);
  return signatureVersion === currentVersion && signature?.valid !== false;
}

function makeSnapshot(declaration, version, metadata = {}) {
  const source = typeof declaration?.toObject === "function"
    ? declaration.toObject({ depopulate: true, getters: false, virtuals: false })
    : declaration;
  if (!source || typeof source !== "object") throw new TypeError("A declaration object is required");
  if (!metadata.createdBy) throw new TypeError("createdBy is required");
  return {
    declarationId: deepClone(source.declarationId),
    version,
    declarationType: deepClone(source.declarationType),
    confirmations: deepClone(source.confirmations),
    declarationData: deepClone(source.declarationData || {}),
    coupleId: deepClone(source.coupleId),
    hospitalId: deepClone(source.hospitalId),
    centreId: deepClone(source.centreId),
    vialIds: deepClone(source.vialIds || []),
    signerId: deepClone(source.signerId),
    signerSnapshot: deepClone(source.signerSnapshot),
    correctionRequestId: metadata.correctionRequestId,
    createdBy: metadata.createdBy,
    createdAt: metadata.createdAt ? new Date(metadata.createdAt) : new Date()
  };
}

function buildInitialVersionSnapshot(declaration, metadata) {
  return makeSnapshot(declaration, 1, metadata);
}

function buildNextVersionSnapshot(declaration, proposedChanges, metadata) {
  const independentChanges = deepClone(proposedChanges);
  const validatedChanges = validateProposedChanges(independentChanges);
  const prior = makeSnapshot(declaration, getEffectiveDeclarationVersion(declaration), metadata);
  const seen = new Set();
  for (const change of validatedChanges) {
    if (!change || !EDITABLE_FIELDS.has(change.field)) throw new TypeError("Only date and statement may be changed");
    if (seen.has(change.field)) throw new TypeError("proposedChanges cannot contain duplicate fields");
    seen.add(change.field);
    prior.declarationData[change.field] = deepClone(change.value);
  }
  prior.version += 1;
  prior.correctionRequestId = metadata.correctionRequestId;
  prior.createdBy = metadata.createdBy;
  prior.createdAt = metadata.createdAt ? new Date(metadata.createdAt) : new Date();
  return prior;
}

// The only persistence helper exposed for snapshots is insert-only. All
// correction approval writes should pass their transaction session here.
async function persistDeclarationVersion(snapshot, options = {}) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) throw new TypeError("A declaration version snapshot is required");
  const copy = deepClone(snapshot);
  if (options.session !== undefined) {
    if (!options.session) throw new TypeError("session must be a valid Mongoose session when supplied");
    const created = await DeclarationVersion.create([copy], { session: options.session });
    return created[0];
  }
  return DeclarationVersion.create(copy);
}

module.exports = {
  deepClone,
  getEffectiveDeclarationVersion,
  getEffectiveSignatureVersion,
  isSignatureCurrentForDeclaration,
  buildInitialVersionSnapshot,
  buildNextVersionSnapshot,
  persistDeclarationVersion
};
