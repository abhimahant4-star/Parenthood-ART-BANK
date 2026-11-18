const { after, before, test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");
const jwt = require("jsonwebtoken");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET ||= crypto.randomBytes(32).toString("hex");
// This in-process test key is ephemeral and never written to environment files.
process.env.UPLOAD_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");

const mongoose = require("mongoose");
const app = require("./support/app");
const { routerServer } = app;
const User = require("../models/User");
const Declaration = require("../models/Declaration");
const DeclarationVersion = require("../models/DeclarationVersion");
const DeclarationCorrectionRequest = require("../models/DeclarationCorrectionRequest");
const Signature = require("../models/Signature");
const AuditLog = require("../models/AuditLog");
const signatureVersioningService = require("../services/signatureVersioningService");
const signatureRoute = require("../routes/signatures");

const runId = crypto.randomUUID();
const hospitalId = `TEST-HOSPITAL-C2-${runId}`;
const centreId = `TEST-CENTRE-C2-${runId}`;
const otherCentreId = `TEST-CENTRE-C2-OTHER-${runId}`;
const tracked = { users: [], declarations: [], requestIds: [], signatureIds: [], versionedSignatureIds: [] };
let hospitalToken;
let adminToken;
let wrongScopeToken;
let baseUrl;
let server;
let versionedBaseUrl;
let versionedServer;
let VersionedSignature;

function assertTestDatabaseUri() {
  assert.ok(process.env.MONGODB_URI, "MONGODB_URI must be supplied by the isolated test runner");
  const parsed = new URL(process.env.MONGODB_URI);
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  assert.equal(databaseName, "parenthood_phase1_test", "Refusing to connect unless database is exactly parenthood_phase1_test");
  assert.ok(["127.0.0.1", "localhost"].includes(parsed.hostname), "Refusing to connect unless MongoDB is a local test instance");
}

function makeToken(user, sessionId) {
  return jwt.sign({ id: String(user._id), username: user.username, role: user.role, hospitalId: user.hospitalId, centreId: user.centreId, chainId: user.chainId, sessionVersion: user.sessionVersion, sessionId }, process.env.JWT_SECRET, { expiresIn: "1h" });
}

async function request(path, token, method = "GET", body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

async function requestVersionedSignature(path, token, method = "GET", body) {
  const response = await fetch(`${versionedBaseUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

async function withInjectedFailure(target, method, replacement, callback) {
  const original = target[method];
  target[method] = replacement(original);
  try { return await callback(); }
  finally { target[method] = original; }
}

async function createDeclaration({ centre = centreId, currentVersion, statement = "Original declaration statement", status = "SUBMITTED", declarationData = {} } = {}) {
  const declarationId = `TEST-DECL-C2-${runId}-${crypto.randomUUID()}`;
  const declaration = await Declaration.create({
    declarationId, coupleId: `TEST-COUPLE-C2-${runId}`, hospitalId, centreId: centre,
    declarationType: "ART_BANK", confirmations: { reviewed: true },
    declarationData: { date: "2030-01-01", statement, ...declarationData }, status,
    ...(currentVersion == null ? {} : { currentVersion })
  });
  tracked.declarations.push(declarationId);
  return declaration;
}

const proposal = (baseVersion = 1) => ({
  baseVersion,
  reason: "Correction required after record review",
  proposedChanges: [{ field: "statement", value: "Corrected declaration statement" }]
});

before(async () => {
  assertTestDatabaseUri();
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
  assert.equal(mongoose.connection.name, "parenthood_phase1_test");
  const hospitalUser = await User.create({ username: `phase1b-c2-hospital-${runId}`, passwordHash: "test-only", role: "HOSPITAL_USER", hospitalId, centreId, sessionVersion: 1, active: true });
  const wrongScopeUser = await User.create({ username: `phase1b-c2-other-${runId}`, passwordHash: "test-only", role: "HOSPITAL_USER", hospitalId, centreId: otherCentreId, sessionVersion: 1, active: true });
  const admin = await User.create({ username: `phase1b-c2-admin-${runId}`, passwordHash: "test-only", role: "ART_BANK_ADMIN", sessionVersion: 1, active: true });
  tracked.users.push(hospitalUser._id, wrongScopeUser._id, admin._id);
  hospitalToken = makeToken(hospitalUser, `hospital-${runId}`);
  wrongScopeToken = makeToken(wrongScopeUser, `wrong-${runId}`);
  adminToken = makeToken(admin, `admin-${runId}`);
  server = http.createServer(app);
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  VersionedSignature = mongoose.models.Phase1BVersionedSignatureTest || mongoose.model(
    "Phase1BVersionedSignatureTest", Signature.schema.clone(), "phase1b_versioned_signature_route_tests"
  );
  await VersionedSignature.init();
  const versionedRouter = signatureRoute.createSignatureRouter({
    SignatureModel: VersionedSignature,
    isStorageReady: signatureVersioningService.createSignatureVersioningService(VersionedSignature).isVersionedSignatureStorageReady
  });
  versionedServer = routerServer("/api/signatures", versionedRouter);
  await new Promise((resolve, reject) => { versionedServer.once("error", reject); versionedServer.listen(0, "127.0.0.1", resolve); });
  versionedBaseUrl = `http://127.0.0.1:${versionedServer.address().port}`;
});

after(async () => {
  try {
    if (mongoose.connection.readyState === 1 && tracked.declarations.length) {
      const ids = tracked.declarations;
      if (VersionedSignature && tracked.versionedSignatureIds.length) await VersionedSignature.deleteMany({ signatureId: { $in: tracked.versionedSignatureIds } });
      await DeclarationCorrectionRequest.deleteMany({ declarationId: { $in: ids } });
      await Signature.deleteMany({ declarationId: { $in: ids } });
      await DeclarationVersion.collection.deleteMany({ declarationId: { $in: ids } });
      await AuditLog.collection.deleteMany({ $or: [
        { entityId: { $in: [...ids, ...tracked.requestIds] } },
        { "newValues.declarationId": { $in: ids } }
      ] });
      await Declaration.deleteMany({ declarationId: { $in: ids } });
    }
    if (mongoose.connection.readyState === 1 && tracked.users.length) await User.deleteMany({ _id: { $in: tracked.users } });
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    if (versionedServer) await new Promise(resolve => versionedServer.close(resolve));
    await mongoose.disconnect();
  }
});

test("hospital submits scoped correction without changing submitted declaration and audit omits values", async () => {
  const declaration = await createDeclaration();
  const response = await request(`/api/declarations/${declaration.declarationId}/correction-requests`, hospitalToken, "POST", proposal());
  if (response.status === 201 && response.body?.data?.requestId) tracked.requestIds.push(response.body.data.requestId);
  assert.equal(response.status, 201);
  assert.equal(response.body.data.status, "PENDING_REVIEW");
  const updated = await Declaration.findOne({ declarationId: declaration.declarationId }).lean();
  assert.equal(updated.status, "SUBMITTED");
  assert.equal(updated.declarationData.statement, "Original declaration statement");
  assert.equal(updated.pendingCorrectionRequestId, response.body.data.requestId);
  const audit = await AuditLog.findOne({ entityId: response.body.data.requestId }).lean();
  assert.equal(audit.action, "DECLARATION_CORRECTION_SUBMITTED");
  assert.equal(JSON.stringify(audit).includes("Corrected declaration statement"), false);
  assert.equal(JSON.stringify(audit).includes("Correction required after record review"), false);
});

test("hospital cannot submit outside its assigned centre and validation allows only date and statement", async () => {
  const declaration = await createDeclaration({ centre: otherCentreId });
  const outOfScope = await request(`/api/declarations/${declaration.declarationId}/correction-requests`, hospitalToken, "POST", proposal());
  assert.equal(outOfScope.status, 404);
  assert.equal(outOfScope.body.errorCode, "DECLARATION_NOT_FOUND");
  const own = await createDeclaration();
  const invalid = await request(`/api/declarations/${own.declarationId}/correction-requests`, hospitalToken, "POST", {
    ...proposal(), proposedChanges: [{ field: "hospitalId", value: "OTHER" }]
  });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.errorCode, "INVALID_CORRECTION_REQUEST");
});

test("hospital cannot read declaration, version, signature, or correction history outside its assigned centre", async () => {
  const declaration = await createDeclaration({ centre: otherCentreId });
  const requestId = `TEST-DCR-SCOPE-${runId}-${crypto.randomUUID()}`;
  tracked.requestIds.push(requestId);
  await DeclarationCorrectionRequest.create({
    requestId,
    declarationId: declaration.declarationId,
    hospitalId,
    centreId: otherCentreId,
    baseVersion: 1,
    proposedChanges: [{ field: "statement", value: "Scoped test correction" }],
    reason: "Scoped test request",
    status: "REVISION_REQUIRED",
    requestedBy: "other-centre-test",
    reviewReason: "Revise the submitted details"
  });

  const encodedId = encodeURIComponent(declaration.declarationId);
  const [details, versions, perDeclarationRequests, signature] = await Promise.all([
    request(`/api/declarations/${encodedId}`, hospitalToken),
    request(`/api/declarations/${encodedId}/versions`, hospitalToken),
    request(`/api/declarations/${encodedId}/correction-requests`, hospitalToken),
    request(`/api/signatures/${encodedId}`, hospitalToken)
  ]);
  assert.equal(details.status, 404);
  assert.equal(details.body.errorCode, "DECLARATION_NOT_FOUND");
  assert.equal(versions.status, 404);
  assert.equal(versions.body.errorCode, "DECLARATION_NOT_FOUND");
  assert.equal(perDeclarationRequests.status, 404);
  assert.equal(perDeclarationRequests.body.errorCode, "DECLARATION_NOT_FOUND");
  assert.equal(signature.status, 404);
  assert.equal(signature.body.errorCode, "SIGNATURE_NOT_FOUND");

  const requestList = await request("/api/correction-requests", hospitalToken);
  assert.equal(requestList.status, 200);
  assert.equal(requestList.body.data.records.some(record => record.requestId === requestId), false);
});

test("one pending correction can be claimed and stale base versions are rejected", async () => {
  const declaration = await createDeclaration();
  const first = await request(`/api/declarations/${declaration.declarationId}/correction-requests`, hospitalToken, "POST", proposal());
  if (first.status === 201 && first.body?.data?.requestId) tracked.requestIds.push(first.body.data.requestId);
  assert.equal(first.status, 201);
  const duplicate = await request(`/api/declarations/${declaration.declarationId}/correction-requests`, hospitalToken, "POST", proposal());
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.errorCode, "CORRECTION_REQUEST_CONFLICT");
  const stale = await request(`/api/declarations/${declaration.declarationId}/correction-requests`, hospitalToken, "POST", proposal(2));
  assert.equal(stale.status, 409);
  assert.equal(stale.body.errorCode, "STALE_DECLARATION_VERSION");
});

test("concurrent correction submissions produce only one pending request", async () => {
  const declaration = await createDeclaration();
  const results = await Promise.all([
    request(`/api/declarations/${declaration.declarationId}/correction-requests`, hospitalToken, "POST", proposal()),
    request(`/api/declarations/${declaration.declarationId}/correction-requests`, hospitalToken, "POST", { ...proposal(), reason: "A second simultaneous request" })
  ]);
  for (const result of results) if (result.status === 201 && result.body?.data?.requestId) tracked.requestIds.push(result.body.data.requestId);
  assert.equal(results.filter(result => result.status === 201).length, 1);
  assert.equal(results.filter(result => result.status === 409).length, 1);
  assert.equal(await DeclarationCorrectionRequest.countDocuments({ declarationId: declaration.declarationId, status: "PENDING_REVIEW" }), 1);
});

test("only bank reviewer can reject; request is preserved and resubmission creates a linked request", async () => {
  const declaration = await createDeclaration();
  const submitted = await request(`/api/declarations/${declaration.declarationId}/correction-requests`, hospitalToken, "POST", proposal());
  if (submitted.status === 201 && submitted.body?.data?.requestId) tracked.requestIds.push(submitted.body.data.requestId);
  assert.equal(submitted.status, 201);
  const forbidden = await request(`/api/correction-requests/${submitted.body.data.requestId}/reject`, hospitalToken, "POST", { reason: "No" });
  assert.equal(forbidden.status, 403);
  const rejected = await request(`/api/correction-requests/${submitted.body.data.requestId}/reject`, adminToken, "POST", { reason: "Please revise the date evidence" });
  assert.equal(rejected.status, 200);
  assert.equal(rejected.body.data.status, "REVISION_REQUIRED");
  const oldRequest = await DeclarationCorrectionRequest.findOne({ requestId: submitted.body.data.requestId }).lean();
  assert.equal(oldRequest.status, "REVISION_REQUIRED");
  const resubmitted = await request(`/api/declarations/${declaration.declarationId}/correction-requests/${oldRequest.requestId}/resubmit`, hospitalToken, "POST", proposal());
  if (resubmitted.status === 201 && resubmitted.body?.data?.requestId) tracked.requestIds.push(resubmitted.body.data.requestId);
  assert.equal(resubmitted.status, 201);
  assert.equal(resubmitted.body.data.revisionOfRequestId, oldRequest.requestId);
});

test("approval creates next immutable snapshot, leaves declaration submitted, and writes audit transactionally", async () => {
  const declaration = await createDeclaration();
  const submitted = await request(`/api/declarations/${declaration.declarationId}/correction-requests`, hospitalToken, "POST", proposal());
  if (submitted.status === 201 && submitted.body?.data?.requestId) tracked.requestIds.push(submitted.body.data.requestId);
  assert.equal(submitted.status, 201);
  const approved = await request(`/api/correction-requests/${submitted.body.data.requestId}/approve`, adminToken, "POST", {});
  assert.equal(approved.status, 200);
  assert.equal(approved.body.data.resultingVersion, 2);
  assert.equal(approved.body.data.declarationStatus, "SUBMITTED");
  const updated = await Declaration.findOne({ declarationId: declaration.declarationId }).lean();
  assert.equal(updated.currentVersion, 2);
  assert.equal(updated.status, "SUBMITTED");
  assert.equal(updated.declarationData.statement, "Corrected declaration statement");
  assert.equal(updated.pendingCorrectionRequestId, undefined);
  assert.equal(await DeclarationVersion.countDocuments({ declarationId: declaration.declarationId }), 2);
  assert.equal(await AuditLog.countDocuments({ entityId: submitted.body.data.requestId, action: "DECLARATION_CORRECTION_APPROVED" }), 1);
});

test("declaration version history paginates while preserving its array response contract", async () => {
  const declaration = await createDeclaration();
  await DeclarationVersion.create([1, 2, 3].map(version => ({
    declarationId: declaration.declarationId,
    version,
    declarationType: declaration.declarationType,
    confirmations: declaration.confirmations,
    declarationData: { date: `2030-01-0${version}`, statement: `Version ${version}` },
    coupleId: declaration.coupleId,
    hospitalId,
    centreId,
    vialIds: [],
    createdBy: `test-reviewer-${runId}`
  })));

  const firstPage = await request(`/api/declarations/${declaration.declarationId}/versions?limit=2&skip=0`, hospitalToken);
  assert.equal(firstPage.status, 200);
  assert.ok(Array.isArray(firstPage.body.data));
  assert.deepEqual(firstPage.body.data.map(version => version.version), [1, 2]);
  assert.deepEqual(firstPage.body.pagination, { skip: 0, limit: 2, total: 3, hasMore: true });

  const secondPage = await request(`/api/declarations/${declaration.declarationId}/versions?limit=2&skip=2`, hospitalToken);
  assert.equal(secondPage.status, 200);
  assert.ok(Array.isArray(secondPage.body.data));
  assert.deepEqual(secondPage.body.data.map(version => version.version), [3]);
  assert.deepEqual(secondPage.body.pagination, { skip: 2, limit: 2, total: 3, hasMore: false });
});

test("audit failure rolls back correction request creation and pending declaration claim", async () => {
  const declaration = await createDeclaration();
  await withInjectedFailure(AuditLog, "create", original => async function (...args) {
    await original.apply(this, args);
    throw new Error("injected correction audit failure");
  }, async () => {
    const response = await request(`/api/declarations/${declaration.declarationId}/correction-requests`, hospitalToken, "POST", proposal());
    assert.equal(response.status, 500);
    assert.equal(response.body.errorCode, "CORRECTION_REQUEST_CREATE_ERROR");
  });
  const afterState = await Declaration.findOne({ declarationId: declaration.declarationId }).lean();
  assert.equal(afterState.pendingCorrectionRequestId, undefined);
  assert.equal(await DeclarationCorrectionRequest.countDocuments({ declarationId: declaration.declarationId }), 0);
  assert.equal(await AuditLog.countDocuments({ entity: "DeclarationCorrectionRequest", "newValues.declarationId": declaration.declarationId }), 0);
});

test("approval failure after snapshot insertion rolls back version, request and declaration", async () => {
  const declaration = await createDeclaration();
  const submitted = await request(`/api/declarations/${declaration.declarationId}/correction-requests`, hospitalToken, "POST", proposal());
  if (submitted.status === 201 && submitted.body?.data?.requestId) tracked.requestIds.push(submitted.body.data.requestId);
  assert.equal(submitted.status, 201);
  let insertCount = 0;
  await withInjectedFailure(DeclarationVersion, "create", original => async function (...args) {
    const result = await original.apply(this, args);
    insertCount += 1;
    if (insertCount === 2) throw new Error("injected version persistence failure");
    return result;
  }, async () => {
    const response = await request(`/api/correction-requests/${submitted.body.data.requestId}/approve`, adminToken, "POST", {});
    assert.equal(response.status, 500);
    assert.equal(response.body.errorCode, "CORRECTION_REQUEST_APPROVE_ERROR");
  });
  const afterState = await Declaration.findOne({ declarationId: declaration.declarationId }).lean();
  assert.equal(afterState.status, "SUBMITTED");
  assert.equal(afterState.currentVersion, undefined);
  assert.equal(afterState.declarationData.statement, "Original declaration statement");
  assert.equal(afterState.pendingCorrectionRequestId, submitted.body.data.requestId);
  assert.equal((await DeclarationCorrectionRequest.findOne({ requestId: submitted.body.data.requestId })).status, "PENDING_REVIEW");
  assert.equal(await DeclarationVersion.countDocuments({ declarationId: declaration.declarationId }), 0);
});

test("approval of a previously signed declaration fails closed under the declarationId unique signature index", async () => {
  const declaration = await createDeclaration();
  const submitted = await request(`/api/declarations/${declaration.declarationId}/correction-requests`, hospitalToken, "POST", proposal());
  if (submitted.status === 201 && submitted.body?.data?.requestId) tracked.requestIds.push(submitted.body.data.requestId);
  assert.equal(submitted.status, 201);
  const signatureId = `TEST-SIGN-C2-${runId}-${crypto.randomUUID()}`;
  tracked.signatureIds.push(signatureId);
  await Signature.create({ signatureId, declarationId: declaration.declarationId, coupleId: declaration.coupleId, hospitalId, centreId, signedBy: "hospital-test", signatureData: "test-only-encrypted-value" });
  const before = await Declaration.findOne({ declarationId: declaration.declarationId }).lean();
  const response = await request(`/api/correction-requests/${submitted.body.data.requestId}/approve`, adminToken, "POST", {});
  assert.equal(response.status, 409);
  assert.equal(response.body.errorCode, "SIGNATURE_VERSIONING_REQUIRED");
  const afterState = await Declaration.findOne({ declarationId: declaration.declarationId }).lean();
  assert.equal(afterState.currentVersion, before.currentVersion);
  assert.equal(afterState.declarationData.statement, before.declarationData.statement);
  assert.equal(afterState.pendingCorrectionRequestId, submitted.body.data.requestId);
  assert.equal(await DeclarationVersion.countDocuments({ declarationId: declaration.declarationId }), 0);
});

test("approved signed correction preserves and invalidates the prior signature when rollout capability is verified", async () => {
  const declaration = await createDeclaration();
  const submitted = await request(`/api/declarations/${declaration.declarationId}/correction-requests`, hospitalToken, "POST", proposal());
  if (submitted.status === 201 && submitted.body?.data?.requestId) tracked.requestIds.push(submitted.body.data.requestId);
  assert.equal(submitted.status, 201);
  const signatureId = `TEST-SIGN-C2-${runId}-${crypto.randomUUID()}`;
  tracked.signatureIds.push(signatureId);
  const originalSignatureData = "test-only-encrypted-historical-signature";
  await Signature.create({ signatureId, declarationId: declaration.declarationId, coupleId: declaration.coupleId, hospitalId, centreId, signedBy: "hospital-test", signatureData: originalSignatureData });

  const originalCapabilityCheck = signatureVersioningService.isVersionedSignatureStorageReady;
  signatureVersioningService.isVersionedSignatureStorageReady = async () => true;
  let approved;
  try {
    approved = await request(`/api/correction-requests/${submitted.body.data.requestId}/approve`, adminToken, "POST", {});
  } finally {
    signatureVersioningService.isVersionedSignatureStorageReady = originalCapabilityCheck;
  }

  assert.equal(approved.status, 200);
  const historical = await Signature.findOne({ signatureId }).lean();
  assert.equal(historical.signatureId, signatureId);
  assert.equal(historical.signatureData, originalSignatureData);
  assert.equal(historical.declarationVersion, undefined);
  assert.equal(historical.valid, false);
  assert.equal(historical.invalidatedByCorrectionRequestId, submitted.body.data.requestId);
  assert.ok(historical.invalidatedAt instanceof Date);
  const current = await request(`/api/signatures/${declaration.declarationId}`, hospitalToken);
  assert.equal(current.status, 404);
  assert.equal(current.body.errorCode, "SIGNATURE_NOT_FOUND");
  const history = await request(`/api/signatures/${declaration.declarationId}/history`, hospitalToken);
  assert.equal(history.status, 200);
  assert.equal(history.body.data.signatures[0].declarationVersion, 1);
  assert.equal(history.body.data.signatures[0].current, false);
  assert.equal(Object.hasOwn(history.body.data.signatures[0], "signatureData"), false);
  assert.equal(await AuditLog.countDocuments({ entityId: submitted.body.data.requestId, action: "DECLARATION_SIGNATURE_INVALIDATED" }), 1);
});

test("signing declaration version two fails closed while the legacy unique index remains", async () => {
  const declaration = await createDeclaration({ currentVersion: 2 });
  const response = await request("/api/signatures", hospitalToken, "POST", {
    declarationId: declaration.declarationId,
    signatureMethod: "DIGITAL",
    signatureData: "data:image/png;base64,AAAA"
  });
  assert.equal(response.status, 409);
  assert.equal(response.body.errorCode, "SIGNATURE_VERSIONING_REQUIRED");
  assert.equal(await Signature.countDocuments({ declarationId: declaration.declarationId }), 0);
});

test("versioned signature API preserves version one, signs version two, and serializes competing requests", async () => {
  const declaration = await createDeclaration({ currentVersion: 2 });
  const historicalSignatureId = `TEST-SIGN-VERSIONED-${runId}-${crypto.randomUUID()}`;
  tracked.versionedSignatureIds.push(historicalSignatureId);
  await VersionedSignature.create({
    signatureId: historicalSignatureId, declarationId: declaration.declarationId,
    declarationVersion: 1, coupleId: declaration.coupleId, hospitalId, centreId,
    signedBy: "hospital-test", signatureData: "test-only-version-one-signature", valid: true
  });

  const unavailable = await requestVersionedSignature(`/api/signatures/${declaration.declarationId}`, hospitalToken);
  assert.equal(unavailable.status, 404);
  const payload = { declarationId: declaration.declarationId, signatureMethod: "DIGITAL", signatureData: "data:image/png;base64,AAAA" };
  const attempts = await Promise.all([
    requestVersionedSignature("/api/signatures", hospitalToken, "POST", payload),
    requestVersionedSignature("/api/signatures", hospitalToken, "POST", payload)
  ]);
  for (const attempt of attempts) {
    if (attempt.status === 201 && attempt.body?.data?.signatureId) tracked.versionedSignatureIds.push(attempt.body.data.signatureId);
  }
  assert.equal(attempts.filter(attempt => attempt.status === 201).length, 1, JSON.stringify(attempts.map(attempt => attempt.body)));
  assert.equal(attempts.filter(attempt => attempt.status === 409).length, 1, JSON.stringify(attempts.map(attempt => attempt.body)));

  const signatures = await VersionedSignature.find({ declarationId: declaration.declarationId }).sort({ declarationVersion: 1 }).lean();
  assert.equal(signatures.length, 2);
  assert.deepEqual(signatures.map(signature => signature.declarationVersion), [1, 2]);
  assert.equal(signatures[0].valid, true);
  const current = await requestVersionedSignature(`/api/signatures/${declaration.declarationId}`, hospitalToken);
  assert.equal(current.status, 200);
  assert.equal(current.body.data.declarationVersion, 2);
  assert.equal(current.body.data.current, true);
  assert.equal(Object.hasOwn(current.body.data, "signatureData"), false);
  const history = await requestVersionedSignature(`/api/signatures/${declaration.declarationId}/history`, hospitalToken);
  assert.equal(history.status, 200);
  assert.deepEqual(history.body.data.signatures.map(signature => signature.current), [false, true]);
  assert.ok(history.body.data.signatures.every(signature => !Object.hasOwn(signature, "signatureData")));
});

test("legacy version-one signature is not returned as current for version two", async () => {
  const declaration = await createDeclaration({ currentVersion: 2 });
  const signatureId = `TEST-SIGN-C2-${runId}-${crypto.randomUUID()}`;
  tracked.signatureIds.push(signatureId);
  await Signature.create({ signatureId, declarationId: declaration.declarationId, coupleId: declaration.coupleId, hospitalId, centreId, signedBy: "hospital-test", signatureData: "test-only-encrypted-value" });
  const current = await request(`/api/signatures/${declaration.declarationId}`, hospitalToken);
  assert.equal(current.status, 404);
  assert.equal(current.body.errorCode, "SIGNATURE_NOT_FOUND");
  const history = await request(`/api/signatures/${declaration.declarationId}/history`, hospitalToken);
  assert.equal(history.status, 200);
  assert.equal(history.body.data.signatures[0].declarationVersion, 1);
  assert.equal(history.body.data.signatures[0].current, false);
  assert.equal(Object.hasOwn(history.body.data.signatures[0], "signatureData"), false);
});

test("two concurrent approvals cannot both apply the same correction", async () => {
  const declaration = await createDeclaration();
  const submitted = await request(`/api/declarations/${declaration.declarationId}/correction-requests`, hospitalToken, "POST", proposal());
  if (submitted.status === 201 && submitted.body?.data?.requestId) tracked.requestIds.push(submitted.body.data.requestId);
  assert.equal(submitted.status, 201);
  const results = await Promise.all([
    request(`/api/correction-requests/${submitted.body.data.requestId}/approve`, adminToken, "POST", {}),
    request(`/api/correction-requests/${submitted.body.data.requestId}/approve`, adminToken, "POST", {})
  ]);
  assert.equal(results.filter(result => result.status === 200).length, 1);
  assert.equal(results.filter(result => result.status === 409).length, 1);
  assert.equal((await Declaration.findOne({ declarationId: declaration.declarationId })).currentVersion, 2);
});

test("signing racing approval never makes a prior signature current for a new version", async () => {
  const declaration = await createDeclaration();
  const submitted = await request(`/api/declarations/${declaration.declarationId}/correction-requests`, hospitalToken, "POST", proposal());
  if (submitted.status === 201 && submitted.body?.data?.requestId) tracked.requestIds.push(submitted.body.data.requestId);
  assert.equal(submitted.status, 201);
  const [approval, signing] = await Promise.all([
    request(`/api/correction-requests/${submitted.body.data.requestId}/approve`, adminToken, "POST", {}),
    request("/api/signatures", hospitalToken, "POST", { declarationId: declaration.declarationId, signatureMethod: "DIGITAL", signatureData: "data:image/png;base64,AAAA" })
  ]);
  assert.equal(signing.status, 201, JSON.stringify(signing.body));
  assert.ok(approval.status === 200 || (approval.status === 409 && approval.body.errorCode === "SIGNATURE_VERSIONING_REQUIRED"), JSON.stringify(approval.body));
  const currentDeclaration = await Declaration.findOne({ declarationId: declaration.declarationId }).lean();
  const signature = await Signature.findOne({ declarationId: declaration.declarationId }).lean();
  assert.equal(signature.declarationVersion, currentDeclaration.currentVersion || 1);
  assert.equal(require("../services/declarationVersionService").isSignatureCurrentForDeclaration(signature, currentDeclaration), true);
});

test("legacy direct declaration PUT cannot overwrite submitted content", async () => {
  const declaration = await createDeclaration();
  const response = await request(`/api/declarations/${declaration.declarationId}`, hospitalToken, "PUT", {
    confirmations: { changed: true }, declarationData: { statement: "unreviewed overwrite" }
  });
  assert.equal(response.status, 409);
  assert.equal(response.body.errorCode, "CORRECTION_REQUEST_REQUIRED");
  assert.equal((await Declaration.findOne({ declarationId: declaration.declarationId })).declarationData.statement, "Original declaration statement");
});

test("bank staff can complete only patient age and sample date on draft declarations", async () => {
  const declaration = await createDeclaration({ status: "DRAFT", declarationData: { referral: "Clinic" } });
  const updated = await request(`/api/declarations/${declaration.declarationId}/draft-report-details`, adminToken, "PATCH", { patientAge: 32, sampleDate: "2026-11-14" });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.data.declarationData.patientAge, 32);
  assert.equal(updated.body.data.declarationData.sampleDate, "2026-11-14");
  assert.equal(updated.body.data.declarationData.referral, "Clinic");
  const audit = await AuditLog.findOne({ entityId: declaration.declarationId, action: "DECLARATION_DRAFT_DETAILS_UPDATED" }).lean();
  assert.ok(audit);
  assert.deepEqual(audit.newValues, { count: 2, status: "DRAFT" });

  const invalid = await request(`/api/declarations/${declaration.declarationId}/draft-report-details`, adminToken, "PATCH", { patientAge: 121, sampleDate: "2026-02-30" });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.errorCode, "INVALID_DRAFT_REPORT_DETAILS");
  const forbidden = await request(`/api/declarations/${declaration.declarationId}/draft-report-details`, hospitalToken, "PATCH", { patientAge: 32, sampleDate: "2026-11-14" });
  assert.equal(forbidden.status, 403);

  const submitted = await createDeclaration();
  const immutable = await request(`/api/declarations/${submitted.declarationId}/draft-report-details`, adminToken, "PATCH", { patientAge: 32, sampleDate: "2026-11-14" });
  assert.equal(immutable.status, 409);
  assert.equal(immutable.body.errorCode, "INVALID_DECLARATION_STATUS");
});

test("a pending correction or existing signature prevents unsubmit", async () => {
  const pendingDeclaration = await createDeclaration();
  const submitted = await request(`/api/declarations/${pendingDeclaration.declarationId}/correction-requests`, hospitalToken, "POST", proposal());
  if (submitted.status === 201 && submitted.body?.data?.requestId) tracked.requestIds.push(submitted.body.data.requestId);
  assert.equal(submitted.status, 201);
  const pendingUnsubmit = await request(`/api/declarations/${pendingDeclaration.declarationId}/unsubmit`, adminToken, "POST", {});
  assert.equal(pendingUnsubmit.status, 409);
  assert.equal(pendingUnsubmit.body.errorCode, "CORRECTION_REQUEST_PENDING");

  const signedDeclaration = await createDeclaration();
  const signatureId = `TEST-SIGN-C2-${runId}-${crypto.randomUUID()}`;
  tracked.signatureIds.push(signatureId);
  await Signature.create({ signatureId, declarationId: signedDeclaration.declarationId, coupleId: signedDeclaration.coupleId, hospitalId, centreId, signedBy: "hospital-test", signatureData: "test-only-encrypted-value" });
  const signedUnsubmit = await request(`/api/declarations/${signedDeclaration.declarationId}/unsubmit`, adminToken, "POST", {});
  assert.equal(signedUnsubmit.status, 409);
  assert.equal(signedUnsubmit.body.errorCode, "DECLARATION_ALREADY_SIGNED");
  assert.equal((await Declaration.findOne({ declarationId: signedDeclaration.declarationId })).status, "SUBMITTED");
});
