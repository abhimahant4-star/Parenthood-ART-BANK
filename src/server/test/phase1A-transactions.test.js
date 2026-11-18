const { after, before, test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET ||= crypto.randomBytes(32).toString("hex");
process.env.UPLOAD_ENCRYPTION_KEY ||= crypto.randomBytes(32).toString("hex");

const mongoose = require("mongoose");
const app = require("./support/app");
const User = require("../models/User");
const Donor = require("../models/Donor");
const Batch = require("../models/Batch");
const Order = require("../models/Order");
const Vial = require("../models/Vial");
const Couple = require("../models/Couple");
const Patient = require("../models/Patient");
const Attachment = require("../models/Attachment");
const AuditLog = require("../models/AuditLog");
const { addCalendarMonths } = require("../services/batchRules");

const runId = crypto.randomUUID();
const tracked = { users: [], donors: [], manualDonorIds: [], batches: [], orders: [], vials: [], couples: [], patients: [], attachments: [], auditIds: [] };
const hospitalId = `TEST-HOSPITAL-${runId}`;
const centreId = `TEST-CENTRE-${runId}`;
let server;
let baseUrl;
let bankToken;
let hospitalToken;
let staffToken;
let superAdminToken;
let chainCeoToken;
let staffUsername;
let hospitalUserId;
let superAdminId;

function assertTestDatabaseUri() {
  const uri = process.env.MONGODB_URI;
  assert.ok(uri, "MONGODB_URI must be supplied by the isolated test runner");
  const parsed = new URL(uri);
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  assert.equal(databaseName, "parenthood_phase1_test", "Refusing to connect unless the database is exactly parenthood_phase1_test");
  assert.ok(["127.0.0.1", "localhost"].includes(parsed.hostname), "Refusing to connect unless MongoDB is a local test instance");
}

function tokenFor(user, sessionId) {
  return jwt.sign({
    id: String(user._id),
    username: user.username,
    role: user.role,
    hospitalId: user.hospitalId,
    centreId: user.centreId,
    chainId: user.chainId,
    sessionVersion: user.sessionVersion,
    sessionId
  }, process.env.JWT_SECRET, { expiresIn: "1h" });
}

async function request(path, token, method = "GET", body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

async function createDonor() {
  const donorId = `TEST-DONOR-${runId}-${crypto.randomUUID()}`;
  tracked.donors.push(donorId);
  return Donor.create({ donorId, unitNumber: `UNIT-${crypto.randomUUID().slice(0, 10)}`, name: "Phase 1A Test Donor", bloodGroup: "O+" });
}

async function createVial({ status = "AVAILABLE_AT_ART_BANK", hospital = null, centre = null, quarantineEnd = new Date(Date.now() - 1000), vialId = `TEST-VIAL-${runId}-${crypto.randomUUID()}`, statusHistory = [{ status, at: new Date() }] } = {}) {
  tracked.vials.push(vialId);
  return Vial.create({
    vialId,
    donorId: `TEST-DONOR-LINK-${runId}`,
    batchId: `TEST-BATCH-LINK-${runId}`,
    bloodGroup: "O+",
    status,
    hospitalId: hospital,
    centreId: centre,
    currentLocation: hospital || "ART Bank",
    quarantineEnd,
    statusHistory
  });
}

async function createOrder({ status = "PENDING", vialIds = [], items = [{ bloodGroup: "O+", quantity: 1 }], donorId } = {}) {
  const orderId = `TEST-ORDER-${runId}-${crypto.randomUUID()}`;
  tracked.orders.push(orderId);
  return Order.create({ orderId, hospitalId, centreId, requestedBy: "phase1a-test", items, purpose: "transaction test", status, vialIds, ...(donorId ? { donorId } : {}) });
}

async function createCouple() {
  const coupleId = `TEST-COUPLE-${runId}-${crypto.randomUUID()}`;
  tracked.couples.push(coupleId);
  return Couple.create({ coupleId, hospitalId, centreId, status: "REGISTERED", mappedVialIds: [] });
}

test("donor registration persists with title-case status and a matching audit event", async () => {
  const manualDonorId = `06TEST-MANUAL-${crypto.randomUUID().slice(0, 12)}`;
  tracked.manualDonorIds.push(manualDonorId);
  const aadhaar = String(crypto.randomInt(100000000000, 999999999999));
  const response = await request("/api/donors", bankToken, "POST", {
    name: "Phase 1A API Test Donor",
    manualDonorId,
    unitNumber: `UNIT-${crypto.randomUUID().slice(0, 10)}`,
    maritalStatus: "UNMARRIED",
    aadhaar,
    dob: "1990-01-01",
    bloodGroup: "O+",
    status: "Active",
    height: "5.8 ft",
    complexion: "Fair",
    eyeColour: "Brown",
    hairColour: "Black",
    build: "Moderate"
  });
  if (response.status === 201 && response.body?.data?.donorId) tracked.donors.push(response.body.data.donorId);
  assert.equal(response.status, 201);
  assert.equal(response.body.success, true);
  assert.equal(response.body.data.status, "Active");
  assert.equal(response.body.data.unitNumber.startsWith("UNIT-"), true);
  assert.equal(Object.hasOwn(response.body.data, "aadhaarHash"), false);
  const firstCharacterSearch = await request("/api/donors/unit-search?q=0", bankToken);
  assert.equal(firstCharacterSearch.status, 200);
  assert.equal(firstCharacterSearch.body.data.some(donor => donor.donorId === response.body.data.donorId), true);
  const prefixSearch = await request("/api/donors/unit-search?q=06", bankToken);
  assert.equal(prefixSearch.body.data.some(donor => donor.donorId === response.body.data.donorId), true);
  const substringSearch = await request("/api/donors/unit-search?q=6T", bankToken);
  assert.equal(substringSearch.body.data.some(donor => donor.donorId === response.body.data.donorId), false);
  const unitSearch = await request(`/api/donors/unit-search?q=${encodeURIComponent(response.body.data.unitNumber.slice(0, 8))}`, bankToken);
  assert.equal(unitSearch.status, 200);
  assert.equal(unitSearch.body.data[0].unitNumber, response.body.data.unitNumber);
  assert.equal(Object.hasOwn(unitSearch.body.data[0], "aadhaarMasked"), false);
  const unauthorizedUnitSearch = await request("/api/donors/unit-search?q=UNIT", hospitalToken);
  assert.equal(unauthorizedUnitSearch.status, 403);
  const audit = await AuditLog.findOne({ entity: "Donor", entityId: response.body.data.donorId, action: "DONOR_CREATED" }).lean();
  if (audit?._id) tracked.auditIds.push(audit._id);
  assert.deepEqual(audit?.newValues, { status: "Active" });
});

test("donor registration enforces manual ID and Unit Number length limits", async () => {
  const basePayload = {
    name: "Identifier length fixture",
    manualDonorId: "MANUAL-VALID",
    unitNumber: `UNIT-${crypto.randomUUID().slice(0, 10)}`,
    maritalStatus: "UNMARRIED",
    aadhaar: String(crypto.randomInt(100000000000, 999999999999)),
    dob: "1990-01-01",
    bloodGroup: "O+"
  };
  const longManualId = await request("/api/donors", bankToken, "POST", { ...basePayload, manualDonorId: "M".repeat(51) });
  assert.equal(longManualId.status, 400);
  assert.equal(longManualId.body.errorCode, "INVALID_MANUAL_DONOR_ID");

  const longUnitNumber = await request("/api/donors", bankToken, "POST", { ...basePayload, manualDonorId: "MANUAL-VALID-2", unitNumber: "U".repeat(31) });
  assert.equal(longUnitNumber.status, 400);
  assert.equal(longUnitNumber.body.errorCode, "INVALID_UNIT_NUMBER");

  const manualDonorId = `${"M".repeat(34)}${runId.replaceAll("-", "").slice(0, 16)}`;
  const unitNumber = `${"U".repeat(20)}${runId.replaceAll("-", "").slice(0, 10)}`;
  tracked.manualDonorIds.push(manualDonorId);
  const atLimit = await request("/api/donors", bankToken, "POST", {
    ...basePayload,
    manualDonorId,
    unitNumber,
    aadhaar: String(crypto.randomInt(100000000000, 999999999999))
  });
  assert.equal(atLimit.status, 201);
  tracked.donors.push(atLimit.body.data.donorId);
  assert.equal(atLimit.body.data.manualDonorId.length, 50);
  assert.equal(atLimit.body.data.unitNumber.length, 30);
});

test("possible donor duplicate lookup searches full records and returns minimized matches", async () => {
  const donorId = `TEST-DUPLICATE-LOOKUP-${runId}-${crypto.randomUUID()}`;
  tracked.donors.push(donorId);
  const name = `Duplicate Lookup ${runId}`;
  const dob = new Date("1990-02-11T00:00:00.000Z");
  await Donor.create({ donorId, uhid: `DUP${crypto.randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`, name, dob, bloodGroup: "O+", aadhaarHash: "must-not-be-returned", aadhaarMasked: "12••••••••34" });

  const params = new URLSearchParams({ name: name.toLowerCase(), dob: "1990-02-11", bloodGroup: "o+" });
  const response = await request(`/api/donors/possible-duplicates?${params}`, bankToken);
  assert.equal(response.status, 200);
  assert.equal(response.body.data.matches, 1);
  assert.equal(response.body.data.donors.length, 1);
  assert.equal(response.body.data.donors[0].donorId, donorId);
  assert.equal(Object.hasOwn(response.body.data.donors[0], "aadhaarHash"), false);
  assert.equal(Object.hasOwn(response.body.data.donors[0], "aadhaarMasked"), false);

  const nonMatch = await request(`/api/donors/possible-duplicates?${new URLSearchParams({ name, dob: "1990-02-11", bloodGroup: "A+" })}`, bankToken);
  assert.equal(nonMatch.status, 200);
  assert.equal(nonMatch.body.data.matches, 0);

  const invalidDate = await request(`/api/donors/possible-duplicates?${new URLSearchParams({ name, dob: "1990-02-30", bloodGroup: "O+" })}`, bankToken);
  assert.equal(invalidDate.status, 400);
  assert.equal(invalidDate.body.errorCode, "INVALID_DUPLICATE_LOOKUP");

  const hospitalDenied = await request(`/api/donors/possible-duplicates?${params}`, hospitalToken);
  assert.equal(hospitalDenied.status, 403);
  assert.equal(hospitalDenied.body.errorCode, "FORBIDDEN");
});

test("concurrent donor registrations with one manual ID return the established duplicate response", async () => {
  const manualDonorId = `TEST-MANUAL-RACE-${crypto.randomUUID().slice(0, 12)}`;
  tracked.manualDonorIds.push(manualDonorId);
  const makePayload = name => ({
    name,
    manualDonorId,
    unitNumber: `UNIT-${crypto.randomUUID().slice(0, 10)}`,
    maritalStatus: "UNMARRIED",
    aadhaar: String(crypto.randomInt(100000000000, 999999999999)),
    dob: "1990-01-01",
    bloodGroup: "O+",
    status: "Active"
  });

  const responses = await Promise.all([
    request("/api/donors", bankToken, "POST", makePayload("Concurrent Donor A")),
    request("/api/donors", bankToken, "POST", makePayload("Concurrent Donor B"))
  ]);
  const created = responses.filter(response => response.status === 201);
  const duplicates = responses.filter(response => response.status === 409);
  assert.equal(created.length, 1);
  assert.equal(duplicates.length, 1);
  assert.equal(duplicates[0].body.errorCode, "MANUAL_DONOR_ID_EXISTS");
  tracked.donors.push(created[0].body.data.donorId);
  assert.equal(await Donor.countDocuments({ manualDonorId }), 1);
  assert.equal(await AuditLog.countDocuments({ entityId: created[0].body.data.donorId, action: "DONOR_CREATED" }), 1);
});

test("donor API rejects unrestricted trait values and malformed non-historical heights", async () => {
  const invalidValues = [
    ["complexion", "Dark", "INVALID_DONOR_TRAIT"],
    ["eyeColour", "Green", "INVALID_DONOR_TRAIT"],
    ["hairColour", "Blonde", "INVALID_DONOR_TRAIT"],
    ["build", "Heavy", "INVALID_DONOR_TRAIT"],
    ["height", `invalid-height-${runId}`, "INVALID_HEIGHT"]
  ];

  for (const [field, value, errorCode] of invalidValues) {
    const manualDonorId = `TEST-INVALID-${field}-${crypto.randomUUID().slice(0, 12)}`;
    tracked.manualDonorIds.push(manualDonorId);
    const response = await request("/api/donors", bankToken, "POST", {
      name: "Invalid donor fixture",
      manualDonorId,
      unitNumber: `UNIT-${crypto.randomUUID().slice(0, 10)}`,
      maritalStatus: "UNMARRIED",
      aadhaar: String(crypto.randomInt(100000000000, 999999999999)),
      dob: "1990-01-01",
      bloodGroup: "O+",
      [field]: value
    });
    assert.equal(response.status, 400, `${field} should be rejected`);
    assert.equal(response.body.errorCode, errorCode);
    assert.equal(await Donor.exists({ manualDonorId }), null);
  }
});

test("donor registration accepts a donor without a Unit Number", async () => {
  const manualDonorId = `TEST-UNIT-OPTIONAL-${crypto.randomUUID().slice(0, 20)}`;
  tracked.manualDonorIds.push(manualDonorId);
  const response = await request("/api/donors", bankToken, "POST", {
    name: "Optional Unit Number fixture",
    manualDonorId,
    maritalStatus: "UNMARRIED",
    aadhaar: String(crypto.randomInt(100000000000, 999999999999)),
    dob: "1990-01-01",
    bloodGroup: "O+"
  });
  assert.equal(response.status, 201);
  tracked.donors.push(response.body.data.donorId);
  assert.equal(Object.hasOwn(response.body.data, "unitNumber"), false);
  assert.equal(await Donor.exists({ manualDonorId, unitNumber: { $exists: true, $ne: "" } }), null);
});

test("donor registration accepts ages 21 and 55 and rejects ages outside that range", async () => {
  const now = new Date();
  const dobForAge = age => new Date(Date.UTC(now.getUTCFullYear() - age, now.getUTCMonth(), now.getUTCDate())).toISOString().slice(0, 10);
  for (const [age, expectedStatus] of [[20, 400], [21, 201], [55, 201], [56, 400]]) {
    const manualDonorId = `TEST-AGE-${age}-${crypto.randomUUID().slice(0, 20)}`;
    tracked.manualDonorIds.push(manualDonorId);
    const response = await request("/api/donors", bankToken, "POST", {
      name: `Age boundary ${age}`,
      manualDonorId,
      maritalStatus: "UNMARRIED",
      aadhaar: String(crypto.randomInt(100000000000, 999999999999)),
      dob: dobForAge(age),
      bloodGroup: "O+"
    });
    assert.equal(response.status, expectedStatus, `age ${age}`);
    if (expectedStatus === 201) tracked.donors.push(response.body.data.donorId);
    else assert.equal(response.body.errorCode, "DONOR_AGE_INELIGIBLE");
  }
});

test("audit API projects legacy payload fields without rewriting the stored event", async () => {
  const entityId = `TEST-AUDIT-PRIVACY-${runId}-${crypto.randomUUID()}`;
  const log = await AuditLog.create({
    userId: "test-actor",
    role: "ART_BANK_STAFF",
    action: "AUDIT_PRIVACY_FIXTURE",
    entity: "AuditPrivacyFixture",
    entityId,
    summary: "fixture summary with sensitive text",
    oldValues: { aadhaar: "fixture-sensitive-value" },
    newValues: { status: "RELEASED", payload: { aadhaar: "fixture-sensitive-value" } }
  });
  tracked.auditIds.push(log._id);

  const response = await request("/api/audit?entity=AuditPrivacyFixture", superAdminToken);
  assert.equal(response.status, 200);
  const projected = response.body.data.logs.find(item => item.entityId === entityId);
  assert.ok(projected);
  assert.equal(projected.summary, "audit privacy fixture");
  assert.deepEqual(projected.newValues, { status: "RELEASED" });
  assert.equal(Object.hasOwn(projected, "oldValues"), false);
  assert.equal(JSON.stringify(projected).includes("fixture-sensitive-value"), false);
  const stored = await AuditLog.findById(log._id).lean();
  assert.equal(stored.oldValues.aadhaar, "fixture-sensitive-value");
});

async function withInjectedFailure(target, method, replacement, callback) {
  const original = target[method];
  target[method] = replacement(original);
  try {
    return await callback();
  } finally {
    target[method] = original;
  }
}

before(async () => {
  assertTestDatabaseUri();
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
  assert.equal(mongoose.connection.name, "parenthood_phase1_test", "Connected database must be parenthood_phase1_test");

  const bankUser = await User.create({ username: `phase1a-bank-${runId}`, passwordHash: "test-only", role: "ART_BANK_ADMIN", sessionVersion: 1, active: true });
  const staffUser = await User.create({ username: `phase1a-staff-${runId}`, passwordHash: "test-only", role: "ART_BANK_STAFF", sessionVersion: 1, active: true });
  staffUsername = staffUser.username;
  const hospitalUser = await User.create({ username: `phase1a-hospital-${runId}`, passwordHash: "test-only", role: "HOSPITAL_USER", hospitalId, centreId, sessionVersion: 1, active: true });
  const superAdmin = await User.create({ username: `phase1a-super-${runId}`, passwordHash: "test-only", role: "SUPER_ADMIN", sessionVersion: 1, active: true });
  const chainCeo = await User.create({ username: `phase1a-chain-ceo-${runId}`, passwordHash: "test-only", role: "CHAIN_CEO", chainId: `TEST-CHAIN-${runId}`, sessionVersion: 1, active: true });
  tracked.users.push(bankUser._id, staffUser._id, hospitalUser._id, superAdmin._id, chainCeo._id);
  hospitalUserId = String(hospitalUser._id);
  superAdminId = String(superAdmin._id);
  bankToken = tokenFor(bankUser, `phase1a-bank-session-${runId}`);
  staffToken = tokenFor(staffUser, `phase1a-staff-session-${runId}`);
  hospitalToken = tokenFor(hospitalUser, `phase1a-hospital-session-${runId}`);
  superAdminToken = tokenFor(superAdmin, `phase1a-super-session-${runId}`);
  chainCeoToken = tokenFor(chainCeo, `phase1a-chain-ceo-session-${runId}`);

  server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "0.0.0.0", resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  try {
    if (mongoose.connection.readyState === 1) {
      const manualDonors = tracked.manualDonorIds.length
        ? await Donor.find({ manualDonorId: { $in: tracked.manualDonorIds } }).select("donorId").lean()
        : [];
      const testDonorIds = [...new Set([...tracked.donors, ...manualDonors.map(donor => donor.donorId)])];
      const testBatches = await Batch.find({
        $or: [
          { batchId: { $in: tracked.batches } },
          { "donor.donorId": { $in: testDonorIds } }
        ]
      }).select("batchId").lean();
      const testBatchIds = testBatches.map(batch => batch.batchId);
      const vialFilters = [];
      if (tracked.vials.length) vialFilters.push({ vialId: { $in: tracked.vials } });
      if (testBatchIds.length) vialFilters.push({ batchId: { $in: testBatchIds } });
      if (testDonorIds.length) vialFilters.push({ donorId: { $in: testDonorIds } });
      if (vialFilters.length) await Vial.deleteMany({ $or: vialFilters });
      if (testBatchIds.length) await Batch.deleteMany({ batchId: { $in: testBatchIds } });
      if (tracked.orders.length) await Order.deleteMany({ orderId: { $in: tracked.orders } });
      if (tracked.couples.length) await Couple.deleteMany({ coupleId: { $in: tracked.couples } });
      if (tracked.patients.length) await Patient.deleteMany({ patientId: { $in: tracked.patients } });
      if (tracked.attachments.length) await Attachment.deleteMany({ attachmentId: { $in: tracked.attachments } });
      if (tracked.donors.length) await Donor.deleteMany({ donorId: { $in: tracked.donors } });
      if (tracked.manualDonorIds.length) await Donor.deleteMany({ manualDonorId: { $in: tracked.manualDonorIds } });
      const auditEntityIds = [...testDonorIds, ...tracked.batches, ...tracked.orders, ...tracked.vials, ...tracked.attachments, ...tracked.users.map(id => String(id))];
      if (auditEntityIds.length) await AuditLog.collection.deleteMany({ entityId: { $in: auditEntityIds } });
      if (tracked.auditIds.length) await AuditLog.collection.deleteMany({ _id: { $in: tracked.auditIds } });
      if (tracked.users.length) await User.deleteMany({ _id: { $in: tracked.users } });
    }
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await mongoose.disconnect();
  }
});

test("batch creation commits batch and numbered vial IDs beginning at 3", async () => {
  const donor = await createDonor();
  const collectedAt = new Date().toISOString().slice(0, 10);
  const response = await request("/api/batches", bankToken, "POST", {
    donorId: donor.donorId,
    batchDate: new Date().toISOString(),
    collectionAt: collectedAt,
    vialCount: 3,
    bloodGroup: "A+",
    stockClassification: "KARYOTYPE_TESTED"
  });
  if (response.status === 201 && response.body?.data) {
    if (response.body.data.batch?.batchId) tracked.batches.push(response.body.data.batch.batchId);
    if (Array.isArray(response.body.data.vials)) tracked.vials.push(...response.body.data.vials.map(vial => vial.vialId).filter(Boolean));
  }
  assert.equal(response.status, 201);
  assert.equal(response.body.success, true);
  assert.equal(response.body.data.vials.length, 3);
  assert.match(response.body.data.batch.batchId, /^ARTB-\d{4}-\d{5}$/);
  const bloodGroupCode = response.body.data.batch.bloodGroup.replace(/[+-]/g, "");
  assert.deepEqual(response.body.data.vials.map(vial => vial.vialId), ["V01", "V02", "V03"].map(suffix => `${response.body.data.batch.batchId}-${bloodGroupCode}-${suffix}`));
  assert.ok(response.body.data.vials.every(vial => vial.bloodGroup === "O+" && vial.stockClassification === "KARYOTYPE_TESTED"));
  assert.equal(await Vial.countDocuments({ batchId: response.body.data.batch.batchId }), 3);
});

test("batch collection enforces date-only input and a six-month donor interval", async () => {
  const donor = await createDonor();
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const recentCollection = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));
  const previousBatchId = `TEST-INTERVAL-BATCH-${runId}-${crypto.randomUUID()}`;
  tracked.batches.push(previousBatchId);
  await Batch.create({ batchId: previousBatchId, donor: { donorId: donor.donorId }, collectionAt: recentCollection, vialCount: 3 });

  const blocked = await request("/api/batches", bankToken, "POST", {
    donorId: donor.donorId, collectionAt: today.toISOString().slice(0, 10), vialCount: 3
  });
  assert.equal(blocked.status, 400);
  assert.equal(blocked.body.errorCode, "DONOR_COLLECTION_INTERVAL");
  assert.ok(blocked.body.data?.nextAllowedDate);

  const dateTime = await request("/api/batches", bankToken, "POST", {
    donorId: donor.donorId, collectionAt: `${today.toISOString().slice(0, 10)}T09:30`, vialCount: 3
  });
  assert.equal(dateTime.status, 400);
  assert.equal(dateTime.body.errorCode, "INVALID_BATCH_DATES");

  const invalidCount = await request("/api/batches", bankToken, "POST", {
    donorId: donor.donorId, collectionAt: today.toISOString().slice(0, 10), vialCount: 6
  });
  assert.equal(invalidCount.status, 400);
  assert.equal(invalidCount.body.errorCode, "INVALID_BATCH");

  const earlyQuarantine = await request("/api/batches", bankToken, "POST", {
    donorId: donor.donorId,
    collectionAt: today.toISOString().slice(0, 10),
    quarantineEnd: today.toISOString().slice(0, 10),
    vialCount: 1
  });
  assert.equal(earlyQuarantine.status, 400);
  assert.equal(earlyQuarantine.body.errorCode, "INVALID_QUARANTINE_END");
});

test("batch collection allows the six-month boundary and persists the donor blood group", async () => {
  const donor = await createDonor();
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const sixMonthsAgo = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 6, 1));
  const previousBatchId = `TEST-INTERVAL-BOUNDARY-${runId}-${crypto.randomUUID()}`;
  tracked.batches.push(previousBatchId);
  await Batch.create({ batchId: previousBatchId, donor: { donorId: donor.donorId }, collectionAt: sixMonthsAgo, vialCount: 3 });

  const response = await request("/api/batches", bankToken, "POST", {
    donorId: donor.donorId,
    batchDate: now.toISOString(),
    collectionAt: today.toISOString().slice(0, 10),
    vialCount: 5,
    bloodGroup: "A+",
    stockClassification: "NORMAL_STOCK"
  });
  if (response.status === 201 && response.body?.data) {
    tracked.batches.push(response.body.data.batch.batchId);
    tracked.vials.push(...response.body.data.vials.map(vial => vial.vialId));
  }
  assert.equal(response.status, 201);
  assert.equal(response.body.data.batch.bloodGroup, "O+");
  const bloodGroupCode = response.body.data.batch.bloodGroup.replace(/[+-]/g, "");
  assert.deepEqual(response.body.data.vials.map(vial => vial.vialId), ["V01", "V02", "V03", "V04", "V05"].map(suffix => `${response.body.data.batch.batchId}-${bloodGroupCode}-${suffix}`));
  assert.equal(new Date(response.body.data.batch.quarantineEnd).toISOString().slice(0, 10), addCalendarMonths(today, 6).toISOString().slice(0, 10));
  assert.equal((await Donor.findById(donor._id)).lastCollectionAt.toISOString().slice(0, 10), today.toISOString().slice(0, 10));
});

test("ART Bank can create a hospital dispatch order with its audit event", async () => {
  const response = await request("/api/orders", bankToken, "POST", {
    hospitalId,
    centreId,
    items: [{ bloodGroup: "AB+", quantity: 1 }],
    purpose: "Phase 1A bank dispatch order test"
  });
  assert.equal(response.status, 201);
  const orderId = response.body.data.orderId;
  tracked.orders.push(orderId);
  assert.equal(response.body.data.status, "PENDING");
  const audit = await AuditLog.findOne({ entity: "Order", entityId: orderId, action: "BANK_DISPATCH_ORDER_CREATED" }).lean();
  assert.ok(audit);
  tracked.auditIds.push(audit._id);
});

test("pending hospital stock can be donor-linked and dispatch rejects another donor's vials", async () => {
  const donor = await createDonor();
  const availableVial = await createVial({ status: "AVAILABLE_AT_ART_BANK" });
  const quarantinedVial = await createVial({ status: "QUARANTINED", quarantineEnd: new Date(Date.now() + 60_000) });
  await Vial.updateMany(
    { _id: { $in: [availableVial._id, quarantinedVial._id] } },
    { $set: { donorId: donor.donorId } }
  );

  const stock = await request("/api/donors/available-stock", bankToken);
  assert.equal(stock.status, 200);
  const availableDonor = stock.body.data.find(item => item.donorId === donor.donorId);
  assert.equal(availableDonor.availableVialCount, 1);
  assert.deepEqual(availableDonor.bloodGroups, [{ bloodGroup: "O+", count: 1 }]);

  const created = await request("/api/orders", bankToken, "POST", {
    hospitalId, centreId, donorId: donor.donorId, items: [{ bloodGroup: "O+", quantity: 1 }],
    purpose: "Donor-linked pending stock test"
  });
  assert.equal(created.status, 201);
  tracked.orders.push(created.body.data.orderId);
  assert.equal(created.body.data.donorId, donor.donorId);

  const otherDonor = await createDonor();
  const mismatchedVial = await createVial({ status: "AVAILABLE_AT_ART_BANK" });
  await Vial.updateOne({ _id: mismatchedVial._id }, { $set: { donorId: otherDonor.donorId } });
  const mismatch = await request(`/api/orders/${created.body.data.orderId}/dispatch`, bankToken, "POST", { vialIds: [mismatchedVial.vialId] });
  assert.equal(mismatch.status, 400);
  assert.equal(mismatch.body.errorCode, "ORDER_DONOR_MISMATCH");

  const dispatched = await request(`/api/orders/${created.body.data.orderId}/dispatch`, bankToken, "POST", { vialIds: [availableVial.vialId] });
  assert.equal(dispatched.status, 200);
  assert.equal(dispatched.body.data.order.donorId, donor.donorId);
});

test("batch list retains its array and reports complete release-eligible totals", async () => {
  const expectedTotal = await Batch.countDocuments({});
  const expectedEligible = await Batch.countDocuments({ releaseStatus: "QUARANTINED", quarantineEnd: { $lte: new Date() } });
  const response = await request("/api/batches", bankToken);
  assert.equal(response.status, 200);
  assert.ok(Array.isArray(response.body.data));
  assert.ok(response.body.data.length <= 100);
  assert.deepEqual(response.body.summary, { total: expectedTotal, releaseEligible: expectedEligible });
});

test("batch search and status filters paginate the full matching result set", async () => {
  const donorId = `TEST-BATCH-FILTER-DONOR-${runId}`;
  const batchIds = [`TEST-BATCH-FILTER-${runId}-A`, `TEST-BATCH-FILTER-${runId}-B`];
  tracked.batches.push(...batchIds);
  await Batch.create([
    { batchId: batchIds[0], donor: { donorId }, collectionAt: new Date(), vialCount: 1, releaseStatus: "QUARANTINED" },
    { batchId: batchIds[1], donor: { donorId }, collectionAt: new Date(), vialCount: 1, releaseStatus: "RELEASED" }
  ]);

  const firstPage = await request(`/api/batches?q=${encodeURIComponent(donorId)}&limit=1&skip=0`, bankToken);
  assert.equal(firstPage.status, 200);
  assert.ok(Array.isArray(firstPage.body.data));
  assert.equal(firstPage.body.data.length, 1);
  assert.deepEqual(firstPage.body.pagination, { skip: 0, limit: 1, total: 2, hasMore: true });

  const secondPage = await request(`/api/batches?q=${encodeURIComponent(donorId)}&limit=1&skip=1`, bankToken);
  assert.equal(secondPage.status, 200);
  assert.equal(secondPage.body.data.length, 1);
  assert.equal(secondPage.body.pagination.hasMore, false);
  assert.notEqual(firstPage.body.data[0].batchId, secondPage.body.data[0].batchId);

  const released = await request(`/api/batches?q=${encodeURIComponent(donorId)}&status=RELEASED`, bankToken);
  assert.equal(released.status, 200);
  assert.equal(released.body.pagination.total, 1);
  assert.equal(released.body.data[0].batchId, batchIds[1]);

  const metacharacterSearch = await request(`/api/batches?q=${encodeURIComponent(`${donorId}.*`)}`, bankToken);
  assert.equal(metacharacterSearch.status, 200);
  assert.equal(metacharacterSearch.body.pagination.total, 0);

  const donor = await createDonor();
  const legacyBatchId = `TEST-BATCH-UNIT-SEARCH-${runId}`;
  tracked.batches.push(legacyBatchId);
  await Batch.create({
    batchId: legacyBatchId,
    donor: { donorId: donor.donorId },
    collectionAt: new Date(),
    vialCount: 1,
    releaseStatus: "QUARANTINED"
  });
  const unitSearch = await request(`/api/batches?q=${encodeURIComponent(donor.unitNumber.slice(-8))}`, bankToken);
  assert.equal(unitSearch.status, 200);
  assert.equal(unitSearch.body.pagination.total, 1);
  assert.equal(unitSearch.body.data[0].batchId, legacyBatchId);

  const invalidStatus = await request(`/api/batches?status=DISCARDED`, bankToken);
  assert.equal(invalidStatus.status, 400);
  assert.equal(invalidStatus.body.errorCode, "INVALID_BATCH_STATUS");
});

test("donor-linked batch and vial histories are available through all API pages", async () => {
  const donor = await createDonor();
  const batchIds = [
    `TEST-DONOR-HISTORY-BATCH-${runId}-${crypto.randomUUID()}`,
    `TEST-DONOR-HISTORY-BATCH-${runId}-${crypto.randomUUID()}`
  ];
  const vialIds = [
    `TEST-DONOR-HISTORY-VIAL-${runId}-${crypto.randomUUID()}`,
    `TEST-DONOR-HISTORY-VIAL-${runId}-${crypto.randomUUID()}`
  ];
  tracked.batches.push(...batchIds);
  tracked.vials.push(...vialIds);
  await Batch.create(batchIds.map(batchId => ({
    batchId,
    donor: { donorId: donor.donorId },
    collectionAt: new Date(),
    vialCount: 1,
    releaseStatus: "QUARANTINED"
  })));
  await Vial.create(vialIds.map((vialId, index) => ({
    vialId,
    donorId: donor.donorId,
    batchId: batchIds[index],
    bloodGroup: "O+",
    status: "QUARANTINED",
    currentLocation: "ART Bank"
  })));

  const batchPages = [];
  let batchSkip = 0;
  let batchPage;
  do {
    const response = await request(`/api/batches?q=${encodeURIComponent(donor.donorId)}&limit=1&skip=${batchSkip}`, bankToken);
    assert.equal(response.status, 200);
    batchPages.push(...response.body.data);
    batchPage = response.body.pagination;
    batchSkip += batchPage.limit;
  } while (batchPage.hasMore);
  assert.equal(batchPage.total, 2);
  assert.deepEqual(new Set(batchPages.map(batch => batch.batchId)), new Set(batchIds));

  const vialPages = [];
  let vialSkip = 0;
  let vialPage;
  do {
    const response = await request(`/api/vials?donorId=${encodeURIComponent(donor.donorId)}&limit=1&skip=${vialSkip}`, bankToken);
    assert.equal(response.status, 200);
    vialPages.push(...response.body.data);
    vialPage = response.body.pagination;
    vialSkip += vialPage.limit;
  } while (vialPage.hasMore);
  assert.equal(vialPage.total, 2);
  assert.deepEqual(new Set(vialPages.map(vial => vial.vialId)), new Set(vialIds));
  assert.ok(vialPages.every(vial => vial.donorId === donor.donorId));
});

test("batch creation rolls back batch write if vial insertion fails", async () => {
  const donor = await createDonor();
  const originalInsertMany = Vial.insertMany;
  let createdBatchId;
  const originalBatchCreate = Batch.create;
  Batch.create = async function (...args) {
    const created = await originalBatchCreate.apply(this, args);
    createdBatchId = created[0].batchId;
    tracked.batches.push(createdBatchId);
    return created;
  };
  try {
    await withInjectedFailure(Vial, "insertMany", original => async function (...args) {
      await original.apply(this, args);
      throw new Error("injected vial insert failure");
    }, async () => {
      const collectedAt = new Date().toISOString().slice(0, 10);
      const response = await request("/api/batches", bankToken, "POST", {
        donorId: donor.donorId, batchDate: new Date().toISOString(), collectionAt: collectedAt, vialCount: 3, bloodGroup: "O+"
      });
      assert.equal(response.status, 500);
      assert.equal(response.body.errorCode, "BATCH_CREATE_ERROR");
    });
  } finally {
    Batch.create = originalBatchCreate;
  }
  assert.ok(createdBatchId);
  assert.equal(await Batch.countDocuments({ batchId: createdBatchId }), 0);
  assert.equal(await Vial.countDocuments({ batchId: createdBatchId }), 0);
});

test("batch release commits batch and vial status changes together", async () => {
  const batchId = `TEST-BATCH-${runId}-${crypto.randomUUID()}`;
  tracked.batches.push(batchId);
  const expiredAt = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
  await Batch.create({ batchId, collectionAt: expiredAt, vialCount: 1, quarantineStart: expiredAt, quarantineEnd: expiredAt, releaseStatus: "QUARANTINED" });
  const vial = await createVial({ status: "QUARANTINED", quarantineEnd: expiredAt, vialId: `TEST-VIAL-${runId}-${crypto.randomUUID()}` });
  vial.batchId = batchId;
  await vial.save();
  const response = await request(`/api/batches/${batchId}/release`, bankToken, "POST", {});
  assert.equal(response.status, 200);
  assert.equal(response.body.data.batch.releaseStatus, "RELEASED");
  assert.equal((await Vial.findOne({ vialId: vial.vialId })).status, "AVAILABLE_AT_ART_BANK");
});

test("batch release rejects a quarantine period shorter than six months", async () => {
  const batchId = `TEST-BATCH-${runId}-${crypto.randomUUID()}`;
  tracked.batches.push(batchId);
  const collectionAt = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const tooEarlyEnd = new Date(Date.now() - 1000);
  await Batch.create({ batchId, collectionAt, vialCount: 1, quarantineStart: collectionAt, quarantineEnd: tooEarlyEnd, releaseStatus: "QUARANTINED" });
  const vial = await createVial({ status: "QUARANTINED", quarantineEnd: tooEarlyEnd });
  vial.batchId = batchId;
  await vial.save();

  const response = await request(`/api/batches/${batchId}/release`, bankToken, "POST", {});
  assert.equal(response.status, 400);
  assert.equal(response.body.errorCode, "QUARANTINE_ACTIVE");
  assert.equal((await Batch.findOne({ batchId })).releaseStatus, "QUARANTINED");
  assert.equal((await Vial.findOne({ vialId: vial.vialId })).status, "QUARANTINED");
});

test("batch release rolls back batch update if vial update fails", async () => {
  const batchId = `TEST-BATCH-${runId}-${crypto.randomUUID()}`;
  tracked.batches.push(batchId);
  const expiredAt = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
  await Batch.create({ batchId, collectionAt: expiredAt, vialCount: 1, quarantineStart: expiredAt, quarantineEnd: expiredAt, releaseStatus: "QUARANTINED" });
  const vial = await createVial({ status: "QUARANTINED", quarantineEnd: expiredAt, vialId: `TEST-VIAL-${runId}-${crypto.randomUUID()}` });
  vial.batchId = batchId;
  await vial.save();
  await withInjectedFailure(Vial, "updateMany", original => async function (...args) {
    await original.apply(this, args);
    throw new Error("injected batch vial update failure");
  }, async () => {
    const response = await request(`/api/batches/${batchId}/release`, bankToken, "POST", {});
    assert.equal(response.status, 500);
    assert.equal(response.body.errorCode, "BATCH_RELEASE_ERROR");
  });
  assert.equal((await Batch.findOne({ batchId })).releaseStatus, "QUARANTINED");
  assert.equal((await Vial.findOne({ vialId: vial.vialId })).status, "QUARANTINED");
});

test("batch release aborts when quarantined vial count differs from batch.vialCount", async () => {
  const batchId = `TEST-BATCH-${runId}-${crypto.randomUUID()}`;
  tracked.batches.push(batchId);
  const expiredAt = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
  const originalBatch = await Batch.create({
    batchId,
    collectionAt: expiredAt,
    vialCount: 10,
    quarantineStart: expiredAt,
    quarantineEnd: expiredAt,
    releaseStatus: "QUARANTINED",
    notes: "preserve on mismatch"
  });
  const vials = [];
  for (let index = 0; index < 8; index++) {
    const vial = await createVial({ status: "QUARANTINED", quarantineEnd: expiredAt });
    vial.batchId = batchId;
    await vial.save();
    vials.push(vial);
  }
  const originalVialStates = await Vial.find({ vialId: { $in: vials.map(vial => vial.vialId) } }).lean();

  const response = await request(`/api/batches/${batchId}/release`, bankToken, "POST", { releaseReason: "test release" });
  assert.equal(response.status, 500);
  assert.equal(response.body.errorCode, "BATCH_RELEASE_ERROR");
  assert.equal(response.body.message, "Failed to release batch");

  const batchAfter = await Batch.findOne({ batchId }).lean();
  assert.equal(batchAfter.releaseStatus, originalBatch.releaseStatus);
  assert.equal(batchAfter.approvedBy, originalBatch.approvedBy);
  assert.equal(batchAfter.notes, originalBatch.notes);
  assert.equal(batchAfter.updatedAt.getTime(), originalBatch.updatedAt.getTime());
  const vialsAfter = await Vial.find({ vialId: { $in: vials.map(vial => vial.vialId) } }).lean();
  assert.equal(vialsAfter.length, 8);
  for (const original of originalVialStates) {
    const current = vialsAfter.find(vial => vial.vialId === original.vialId);
    assert.ok(current);
    assert.equal(current.status, original.status);
    assert.deepEqual(current.statusHistory, original.statusHistory);
    assert.equal(current.updatedAt.getTime(), original.updatedAt.getTime());
  }
});

test("only one simultaneous release of the same batch succeeds", async () => {
  const batchId = `TEST-BATCH-${runId}-${crypto.randomUUID()}`;
  tracked.batches.push(batchId);
  const expiredAt = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
  await Batch.create({ batchId, collectionAt: expiredAt, vialCount: 1, quarantineStart: expiredAt, quarantineEnd: expiredAt, releaseStatus: "QUARANTINED" });
  const vial = await createVial({ status: "QUARANTINED", quarantineEnd: expiredAt });
  vial.batchId = batchId;
  await vial.save();

  const results = await Promise.all([
    request(`/api/batches/${batchId}/release`, bankToken, "POST", {}),
    request(`/api/batches/${batchId}/release`, bankToken, "POST", {})
  ]);
  assert.equal(results.filter(result => result.status === 200).length, 1);
  const loser = results.find(result => result.status !== 200);
  assert.equal(loser.status, 400);
  assert.equal(loser.body.errorCode, "INVALID_RELEASE_STATUS");
  assert.equal(loser.body.message, "Batch is not in quarantine");
  assert.equal((await Batch.findOne({ batchId })).releaseStatus, "RELEASED");
  assert.equal((await Vial.findOne({ vialId: vial.vialId })).status, "AVAILABLE_AT_ART_BANK");
});

test("order dispatch commits order and vial changes together", async () => {
  const historicalVial = await createVial({ status: "RETURNED_BEFORE_MAPPING" });
  const historicalBefore = await Vial.findOne({ vialId: historicalVial.vialId }).lean();
  const vial = await createVial();
  const order = await createOrder();
  const response = await request(`/api/orders/${order.orderId}/dispatch`, bankToken, "POST", { vialIds: [vial.vialId], courierDetails: { reference: "test" } });
  assert.equal(response.status, 200);
  assert.equal(response.body.data.order.status, "DISPATCHED");
  assert.equal(response.body.data.vials[0].status, "DISPATCHED");
  assert.deepEqual(response.body.data.order.vialIds, [vial.vialId]);
  const historicalAfter = await Vial.findOne({ vialId: historicalVial.vialId }).lean();
  assert.equal(historicalAfter.status, historicalBefore.status);
  assert.deepEqual(historicalAfter.statusHistory, historicalBefore.statusHistory);
});

test("order dispatch rolls back vial claims if the later order update fails", async () => {
  const vial = await createVial();
  const order = await createOrder();
  await withInjectedFailure(Order, "findOneAndUpdate", original => async function (filter, ...args) {
    if (filter && filter.status === "PENDING") throw new Error("injected dispatch order update failure");
    return original.call(this, filter, ...args);
  }, async () => {
    const response = await request(`/api/orders/${order.orderId}/dispatch`, bankToken, "POST", { vialIds: [vial.vialId] });
    assert.equal(response.status, 500);
    assert.equal(response.body.errorCode, "ORDER_DISPATCH_ERROR");
  });
  assert.equal((await Vial.findOne({ vialId: vial.vialId })).status, "AVAILABLE_AT_ART_BANK");
  assert.equal((await Order.findOne({ orderId: order.orderId })).status, "PENDING");
});

test("only one concurrent dispatch can claim a shared vial", async () => {
  const vial = await createVial();
  const first = await createOrder();
  const second = await createOrder();
  const results = await Promise.all([
    request(`/api/orders/${first.orderId}/dispatch`, bankToken, "POST", { vialIds: [vial.vialId] }),
    request(`/api/orders/${second.orderId}/dispatch`, bankToken, "POST", { vialIds: [vial.vialId] })
  ]);
  assert.equal(results.filter(result => result.status === 200).length, 1);
  const loser = results.find(result => result.status !== 200);
  assert.equal(loser.status, 400);
  assert.equal(loser.body.errorCode, "VIAL_NOT_AVAILABLE");
  assert.equal((await Vial.findOne({ vialId: vial.vialId })).status, "DISPATCHED");
  assert.equal(await Order.countDocuments({ orderId: { $in: [first.orderId, second.orderId] }, status: "DISPATCHED" }), 1);
});

test("order receipt commits order and all vial status changes together", async () => {
  const vial = await createVial({ status: "DISPATCHED", hospital: hospitalId, centre: centreId });
  const order = await createOrder({ status: "DISPATCHED", vialIds: [vial.vialId], donorId: `TEST-DONOR-PRIVATE-${runId}` });
  const response = await request(`/api/orders/${order.orderId}/receive`, hospitalToken, "POST", { vialIds: [vial.vialId] });
  assert.equal(response.status, 200);
  assert.equal(response.body.data.order.status, "RECEIVED");
  assert.equal(response.body.data.vials[0].status, "UNUSED_AT_HOSPITAL");
  assert.equal(Object.hasOwn(response.body.data.order, "donorId"), false);
  for (const field of ["donorId", "batchId", "statusHistory"]) assert.equal(Object.hasOwn(response.body.data.vials[0], field), false);
});

test("order receipt rolls back vial updates if the later order update fails", async () => {
  const vial = await createVial({ status: "DISPATCHED", hospital: hospitalId, centre: centreId });
  const order = await createOrder({ status: "DISPATCHED", vialIds: [vial.vialId] });
  await withInjectedFailure(Order, "findOneAndUpdate", original => async function (filter, ...args) {
    if (filter && filter.status === "DISPATCHED") throw new Error("injected receipt order update failure");
    return original.call(this, filter, ...args);
  }, async () => {
    const response = await request(`/api/orders/${order.orderId}/receive`, hospitalToken, "POST", { vialIds: [vial.vialId] });
    assert.equal(response.status, 500);
    assert.equal(response.body.errorCode, "VIAL_RECEIVE_ERROR");
  });
  assert.equal((await Vial.findOne({ vialId: vial.vialId })).status, "DISPATCHED");
  assert.equal((await Order.findOne({ orderId: order.orderId })).status, "DISPATCHED");
});

test("only one simultaneous receipt of the same order succeeds", async () => {
  const vial = await createVial({ status: "DISPATCHED", hospital: hospitalId, centre: centreId });
  const order = await createOrder({ status: "DISPATCHED", vialIds: [vial.vialId] });
  const results = await Promise.all([
    request(`/api/orders/${order.orderId}/receive`, hospitalToken, "POST", { vialIds: [vial.vialId] }),
    request(`/api/orders/${order.orderId}/receive`, hospitalToken, "POST", { vialIds: [vial.vialId] })
  ]);
  assert.equal(results.filter(result => result.status === 200).length, 1);
  const loser = results.find(result => result.status !== 200);
  assert.equal(loser.status, 400);
  assert.equal(loser.body.errorCode, "INVALID_ORDER_STATUS");
  assert.equal(loser.body.message, "Order is not in dispatched status");
  assert.equal((await Order.findOne({ orderId: order.orderId })).status, "RECEIVED");
  assert.equal((await Vial.findOne({ vialId: vial.vialId })).status, "UNUSED_AT_HOSPITAL");
});

test("vial mapping commits couple and vial changes together", async () => {
  const vial = await createVial({ status: "UNUSED_AT_HOSPITAL", hospital: hospitalId, centre: centreId });
  const couple = await createCouple();
  const response = await request("/api/mappings", hospitalToken, "POST", { coupleId: couple.coupleId, vialId: vial.vialId });
  assert.equal(response.status, 201);
  assert.deepEqual(response.body.data, { coupleId: couple.coupleId, vialId: vial.vialId, coupleStatus: "ACTIVE", vialStatus: "MAPPED_USED" });
  assert.deepEqual((await Couple.findOne({ coupleId: couple.coupleId })).mappedVialIds, [vial.vialId]);
  const mapping = await request(`/api/mappings/${encodeURIComponent(couple.coupleId)}`, hospitalToken);
  assert.equal(mapping.status, 200);
  const [hospitalVial] = mapping.body.data.vials;
  assert.equal(hospitalVial.vialId, vial.vialId);
  for (const field of ["donorId", "batchId", "statusHistory"]) assert.equal(Object.hasOwn(hospitalVial, field), false);
  assert.equal((await Vial.findOne({ vialId: vial.vialId })).status, "MAPPED_USED");
});

test("staff attachment APIs limit identity documents to the uploader while admins retain bank access", async () => {
  const fixtures = [
    { attachmentId: `TEST-ATTACH-${runId}-identity-other`, category: "IDENTITY_DOCUMENT", createdBy: `other-user-${runId}` },
    { attachmentId: `TEST-ATTACH-${runId}-aadhaar-other`, category: "DONOR_AADHAAR", createdBy: `other-user-${runId}` },
    { attachmentId: `TEST-ATTACH-${runId}-aadhaar-own`, category: "DONOR_AADHAAR", createdBy: staffUsername },
    { attachmentId: `TEST-ATTACH-${runId}-bank-doc`, category: "BANK_DOCUMENT", createdBy: `other-user-${runId}` }
  ];
  tracked.attachments.push(...fixtures.map(item => item.attachmentId));
  await Attachment.create(fixtures.map(item => ({
    ...item, hospitalId, centreId, relatedId: `TEST-RELATED-${runId}`, label: item.attachmentId, status: "DRAFT", files: []
  })));

  const staffList = await request("/api/attachments?limit=500", staffToken);
  assert.equal(staffList.status, 200);
  const staffIds = staffList.body.data.map(item => item.attachmentId);
  assert.ok(staffIds.includes(fixtures[2].attachmentId));
  assert.ok(staffIds.includes(fixtures[3].attachmentId));
  assert.ok(!staffIds.includes(fixtures[0].attachmentId));
  assert.ok(!staffIds.includes(fixtures[1].attachmentId));

  const adminList = await request("/api/attachments?limit=500", bankToken);
  assert.equal(adminList.status, 200);
  for (const fixture of fixtures) assert.ok(adminList.body.data.some(item => item.attachmentId === fixture.attachmentId));

  const deniedDownload = await request(`/api/attachments/${encodeURIComponent(fixtures[0].attachmentId)}/files/not-present`, staffToken);
  assert.equal(deniedDownload.status, 404);
  assert.equal(deniedDownload.body.errorCode, "ATTACHMENT_NOT_FOUND");

  const deniedVisibility = await request(`/api/attachments/${encodeURIComponent(fixtures[0].attachmentId)}/visibility`, staffToken, "PATCH", { status: "SUBMITTED" });
  assert.equal(deniedVisibility.status, 404);
  assert.equal(deniedVisibility.body.errorCode, "ATTACHMENT_NOT_FOUND");
  assert.equal((await Attachment.findOne({ attachmentId: fixtures[0].attachmentId }).lean()).status, "DRAFT");

  const ownVisibility = await request(`/api/attachments/${encodeURIComponent(fixtures[2].attachmentId)}/visibility`, staffToken, "PATCH", { status: "SUBMITTED" });
  assert.equal(ownVisibility.status, 200);
  assert.equal(ownVisibility.body.data.status, "SUBMITTED");
});

test("hospital attachment list and download never expose donor Aadhaar scans", async () => {
  const fixtures = [
    { attachmentId: `TEST-ATTACH-HOSPITAL-${runId}-aadhaar`, category: "DONOR_AADHAAR", status: "SUBMITTED" },
    { attachmentId: `TEST-ATTACH-HOSPITAL-${runId}-couple-id`, category: "IDENTITY_DOCUMENT", status: "SUBMITTED" },
    { attachmentId: `TEST-ATTACH-HOSPITAL-${runId}-bank-doc`, category: "BANK_DOCUMENT", status: "SUBMITTED" }
  ];
  tracked.attachments.push(...fixtures.map(item => item.attachmentId));
  await Attachment.create(fixtures.map(item => ({
    ...item,
    hospitalId,
    centreId,
    relatedId: `TEST-ATTACHMENT-RELATED-${runId}`,
    label: item.attachmentId,
    createdBy: "phase1a-bank-uploader",
    files: [{ fileId: "test-file", originalName: "test.pdf", label: "test", storageName: "unread-test-file.enc", mimeType: "application/pdf", size: 1 }]
  })));

  const listed = await request("/api/attachments?limit=500", hospitalToken);
  assert.equal(listed.status, 200);
  const visibleIds = listed.body.data.map(item => item.attachmentId);
  assert.ok(!visibleIds.includes(fixtures[0].attachmentId));
  assert.ok(visibleIds.includes(fixtures[1].attachmentId));
  assert.ok(visibleIds.includes(fixtures[2].attachmentId));

  const donorScanDownload = await request(`/api/attachments/${encodeURIComponent(fixtures[0].attachmentId)}/files/test-file`, hospitalToken);
  assert.equal(donorScanDownload.status, 404);
  assert.equal(donorScanDownload.body.errorCode, "ATTACHMENT_NOT_FOUND");
});

test("couple detail API applies role privacy projections and hospital scope", async () => {
  const couple = await Couple.create({
    coupleId: `TEST-COUPLE-${runId}-${crypto.randomUUID()}`,
    hospitalId,
    centreId,
    husband: { name: "Test Partner One", idType: "TEST", idNumber: "TEST-IDENTIFIER-1" },
    wife: { name: "Test Partner Two", idType: "TEST", idNumber: "TEST-IDENTIFIER-2" },
    status: "REGISTERED",
    mappedVialIds: []
  });
  tracked.couples.push(couple.coupleId);

  for (const token of [bankToken, staffToken]) {
    const response = await request(`/api/couples/${encodeURIComponent(couple.coupleId)}`, token);
    assert.equal(response.status, 200);
    assert.equal(Object.hasOwn(response.body.data, "husband"), false);
    assert.equal(Object.hasOwn(response.body.data, "wife"), false);
  }
  const hospitalResponse = await request(`/api/couples/${encodeURIComponent(couple.coupleId)}`, hospitalToken);
  assert.equal(hospitalResponse.status, 200);
  assert.equal(hospitalResponse.body.data.husband.name, "Test Partner One");
  assert.equal(hospitalResponse.body.data.wife.name, "Test Partner Two");

  const wrongScopeUser = await User.create({ username: `phase1a-couple-scope-${runId}`, passwordHash: "test-only", role: "HOSPITAL_USER", hospitalId: `${hospitalId}-OTHER`, centreId, sessionVersion: 1, active: true });
  tracked.users.push(wrongScopeUser._id);
  const wrongScopeResponse = await request(`/api/couples/${encodeURIComponent(couple.coupleId)}`, tokenFor(wrongScopeUser, `couple-scope-${runId}`));
  assert.equal(wrongScopeResponse.status, 404);
  assert.equal(wrongScopeResponse.body.errorCode, "COUPLE_NOT_FOUND");
});

test("couple registration requires at least one Aadhaar, limits it to 12 digits, and stores only masked values", async () => {
  const body = {
    hospitalId,
    centreId,
    husband: { name: "Synthetic Partner One", idType: "Passport", idNumber: "P-100" },
    wife: { name: "Synthetic Partner Two", idType: "", idNumber: "" }
  };
  const missingAadhaar = await request("/api/couples", hospitalToken, "POST", body);
  assert.equal(missingAadhaar.status, 400);
  assert.equal(missingAadhaar.body.errorCode, "AADHAAR_REQUIRED");

  const tooLongAadhaar = await request("/api/couples", hospitalToken, "POST", {
    ...body,
    husband: { name: "Synthetic Partner One", idType: "Aadhaar", idNumber: "0000000000000" }
  });
  assert.equal(tooLongAadhaar.status, 400);
  assert.equal(tooLongAadhaar.body.errorCode, "INVALID_AADHAAR");

  const oneAadhaarNumber = "000000000000";
  const oneAadhaarResponse = await request("/api/couples", hospitalToken, "POST", {
    ...body,
    husband: { name: "Synthetic Partner One", idType: "Aadhaar", idNumber: oneAadhaarNumber }
  });
  assert.equal(oneAadhaarResponse.status, 201);
  const oneAadhaarId = oneAadhaarResponse.body.data.coupleId;
  tracked.couples.push(oneAadhaarId);
  assert.match(oneAadhaarId, /^CASE-\d{4}-\d{4,}$/);
  assert.equal(oneAadhaarResponse.body.data.husband.idNumber, "00••••••••00");
  assert.equal(Object.hasOwn(oneAadhaarResponse.body.data.husband, "idNumberHash"), false);
  assert.equal(oneAadhaarResponse.body.data.wife.idNumber, "");
  const storedOneAadhaar = await Couple.findOne({ coupleId: oneAadhaarId }).lean();
  assert.equal(storedOneAadhaar.husband.idNumber, "00••••••••00");
  assert.equal(storedOneAadhaar.husband.idNumberHash, crypto.createHash("sha256").update(oneAadhaarNumber).digest("hex"));
  assert.equal(JSON.stringify(storedOneAadhaar).includes(oneAadhaarNumber), false);

  const bothAadhaarResponse = await request("/api/couples", hospitalToken, "POST", {
    ...body,
    husband: { name: "Synthetic Partner One", idType: "Aadhaar", idNumber: "111111111111" },
    wife: { name: "Synthetic Partner Two", idType: "Aadhaar", idNumber: "222222222222" }
  });
  assert.equal(bothAadhaarResponse.status, 201);
  tracked.couples.push(bothAadhaarResponse.body.data.coupleId);
  assert.notEqual(bothAadhaarResponse.body.data.coupleId, oneAadhaarId);
  assert.match(bothAadhaarResponse.body.data.coupleId, /^CASE-\d{4}-\d{4,}$/);
  assert.equal(bothAadhaarResponse.body.data.husband.idNumber, "11••••••••11");
  assert.equal(bothAadhaarResponse.body.data.wife.idNumber, "22••••••••22");
});

test("vial mapping rolls back couple update if the later vial claim fails", async () => {
  const vial = await createVial({ status: "UNUSED_AT_HOSPITAL", hospital: hospitalId, centre: centreId });
  const couple = await createCouple();
  await withInjectedFailure(Vial, "updateOne", original => async function (...args) {
    await original.apply(this, args);
    throw new Error("injected mapping vial update failure");
  }, async () => {
    const response = await request("/api/mappings", hospitalToken, "POST", { coupleId: couple.coupleId, vialId: vial.vialId });
    assert.equal(response.status, 500);
    assert.equal(response.body.errorCode, "MAPPING_ERROR");
  });
  assert.deepEqual((await Couple.findOne({ coupleId: couple.coupleId })).mappedVialIds, []);
  assert.equal((await Vial.findOne({ vialId: vial.vialId })).status, "UNUSED_AT_HOSPITAL");
});

test("mapping accepts historical null statusHistory and appends the event", async () => {
  const vial = await createVial({ status: "UNUSED_AT_HOSPITAL", hospital: hospitalId, centre: centreId, statusHistory: null });
  const couple = await createCouple();
  assert.equal((await Vial.findOne({ vialId: vial.vialId }).lean()).statusHistory, null);

  const response = await request("/api/mappings", hospitalToken, "POST", { coupleId: couple.coupleId, vialId: vial.vialId });
  assert.equal(response.status, 201);
  const updated = await Vial.findOne({ vialId: vial.vialId }).lean();
  assert.equal(updated.status, "MAPPED_USED");
  assert.ok(Array.isArray(updated.statusHistory));
  assert.equal(updated.statusHistory.length, 1);
  assert.equal(updated.statusHistory[0].status, "MAPPED_USED");
  assert.equal(updated.statusHistory[0].coupleId, couple.coupleId);
});

test("mapping applies hospital and centre scope in database record queries", async () => {
  const vial = await createVial({ status: "UNUSED_AT_HOSPITAL", hospital: hospitalId, centre: centreId });
  const coupleInOtherCentre = await Couple.create({
    coupleId: `TEST-COUPLE-${runId}-${crypto.randomUUID()}`,
    hospitalId,
    centreId: `${centreId}-OTHER`,
    status: "REGISTERED",
    mappedVialIds: []
  });
  tracked.couples.push(coupleInOtherCentre.coupleId);

  const coupleScopeResponse = await request("/api/mappings", hospitalToken, "POST", {
    coupleId: coupleInOtherCentre.coupleId, vialId: vial.vialId
  });
  assert.equal(coupleScopeResponse.status, 404);
  assert.equal(coupleScopeResponse.body.errorCode, "HOSPITAL_SCOPE_DENIED");

  const couple = await createCouple();
  const vialInOtherCentre = await createVial({
    status: "UNUSED_AT_HOSPITAL", hospital: hospitalId, centre: `${centreId}-OTHER`
  });
  const vialScopeResponse = await request("/api/mappings", hospitalToken, "POST", {
    coupleId: couple.coupleId, vialId: vialInOtherCentre.vialId
  });
  assert.equal(vialScopeResponse.status, 404);
  assert.equal(vialScopeResponse.body.errorCode, "VIAL_NOT_FOUND");
  assert.deepEqual((await Couple.findOne({ coupleId: couple.coupleId })).mappedVialIds, []);
  assert.equal((await Vial.findOne({ vialId: vial.vialId })).status, "UNUSED_AT_HOSPITAL");
  assert.equal((await Vial.findOne({ vialId: vialInOtherCentre.vialId })).status, "UNUSED_AT_HOSPITAL");
});

test("only one concurrent couple mapping can claim a shared vial", async () => {
  const vial = await createVial({ status: "UNUSED_AT_HOSPITAL", hospital: hospitalId, centre: centreId });
  const first = await createCouple();
  const second = await createCouple();
  const results = await Promise.all([
    request("/api/mappings", hospitalToken, "POST", { coupleId: first.coupleId, vialId: vial.vialId }),
    request("/api/mappings", hospitalToken, "POST", { coupleId: second.coupleId, vialId: vial.vialId })
  ]);
  assert.equal(results.filter(result => result.status === 201).length, 1);
  const loser = results.find(result => result.status !== 201);
  assert.equal(loser.status, 400);
  assert.equal(loser.body.errorCode, "VIAL_NOT_MAPPABLE");
  assert.equal((await Vial.findOne({ vialId: vial.vialId })).status, "MAPPED_USED");
  assert.equal(await Couple.countDocuments({ coupleId: { $in: [first.coupleId, second.coupleId] }, mappedVialIds: vial.vialId }), 1);
});

test("conditional vial status update preserves its existing response and rejects a racing stale transition", async () => {
  const vial = await createVial({ status: "AVAILABLE_AT_ART_BANK" });
  const [first, second] = await Promise.all([
    request(`/api/vials/${vial.vialId}/status`, bankToken, "PATCH", { status: "BLOCKED" }),
    request(`/api/vials/${vial.vialId}/status`, bankToken, "PATCH", { status: "BLOCKED" })
  ]);
  assert.equal([first, second].filter(result => result.status === 200).length, 1);
  assert.equal([first, second].filter(result => result.status === 409).length, 1);
  const success = first.status === 200 ? first : second;
  assert.equal(success.body.success, true);
  assert.equal(success.body.message, "Vial status updated");
  assert.equal(success.body.data.status, "BLOCKED");
});

test("vial list pagination preserves the array contract and reports exact hospital-scoped totals", async () => {
  const firstVial = await createVial({ status: "CREATED", hospital: hospitalId, centre: centreId });
  const secondVial = await createVial({ status: "CREATED", hospital: hospitalId, centre: centreId });
  const otherCentreVial = await createVial({ status: "CREATED", hospital: hospitalId, centre: `${centreId}-OTHER` });

  const donorFilter = encodeURIComponent(`TEST-DONOR-LINK-${runId}`);
  const firstPage = await request(`/api/vials?status=CREATED&donorId=${donorFilter}&limit=1&skip=0`, hospitalToken);
  assert.equal(firstPage.status, 200);
  assert.ok(Array.isArray(firstPage.body.data));
  assert.equal(firstPage.body.data.length, 1);
  assert.deepEqual(firstPage.body.pagination, { skip: 0, limit: 1, total: 2, hasMore: true });
  assert.ok([firstVial.vialId, secondVial.vialId].includes(firstPage.body.data[0].vialId));
  assert.notEqual(firstPage.body.data[0].vialId, otherCentreVial.vialId);
  for (const field of ["donorId", "donorUhid", "batchId", "statusHistory"]) assert.equal(Object.hasOwn(firstPage.body.data[0], field), false);
  const vialDetails = await request(`/api/vials/${encodeURIComponent(firstPage.body.data[0].vialId)}`, hospitalToken);
  assert.equal(vialDetails.status, 200);
  for (const field of ["donorId", "batchId", "statusHistory"]) assert.equal(Object.hasOwn(vialDetails.body.data, field), false);

  const secondPage = await request(`/api/vials?status=CREATED&donorId=${donorFilter}&limit=1&skip=1`, hospitalToken);
  assert.equal(secondPage.status, 200);
  assert.equal(secondPage.body.data.length, 1);
  assert.equal(secondPage.body.pagination.hasMore, false);
  assert.notEqual(secondPage.body.data[0].vialId, firstPage.body.data[0].vialId);
  assert.notEqual(secondPage.body.data[0].vialId, otherCentreVial.vialId);
});

test("dispatch vial candidates support case-insensitive blood-group filters across pages", async () => {
  const upper = await createVial({ status: "AVAILABLE_AT_ART_BANK" });
  const lower = await createVial({ status: "AVAILABLE_AT_ART_BANK" });
  const candidateDonorId = `TEST-DISPATCH-CANDIDATE-${runId}`;
  await Vial.updateMany({ _id: { $in: [upper._id, lower._id] } }, { $set: { donorId: candidateDonorId } });
  await Vial.updateOne({ _id: upper._id }, { $set: { bloodGroup: "O+" } });
  await Vial.updateOne({ _id: lower._id }, { $set: { bloodGroup: "o+" } });

  const donorFilter = encodeURIComponent(candidateDonorId);
  const firstPage = await request(`/api/vials?status=AVAILABLE_AT_ART_BANK&bloodGroup=o%2B&donorId=${donorFilter}&limit=1&skip=0`, bankToken);
  assert.equal(firstPage.status, 200);
  assert.equal(firstPage.body.pagination.total, 2);
  assert.equal(firstPage.body.data.length, 1);
  assert.equal(firstPage.body.pagination.hasMore, true);

  const secondPage = await request(`/api/vials?status=AVAILABLE_AT_ART_BANK&bloodGroup=O%2B&donorId=${donorFilter}&limit=1&skip=1`, bankToken);
  assert.equal(secondPage.status, 200);
  assert.equal(secondPage.body.pagination.total, 2);
  assert.equal(secondPage.body.data.length, 1);
  assert.equal(secondPage.body.pagination.hasMore, false);
  assert.notEqual(firstPage.body.data[0].vialId, secondPage.body.data[0].vialId);
});

test("donor and vial text search covers database records while retaining hospital and centre scope", async () => {
  const donor = await createDonor();
  donor.uhid = `TST${crypto.randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`;
  await donor.save();
  const vialId = `TEST-VIAL-SEARCH-${runId}-${crypto.randomUUID()}`;
  const otherCentreVialId = `TEST-VIAL-SEARCH-OTHER-${runId}-${crypto.randomUUID()}`;
  tracked.vials.push(vialId, otherCentreVialId);
  await Vial.create([
    { vialId, donorId: donor.donorId, batchId: `TEST-BATCH-SEARCH-${runId}`, bloodGroup: "O+", status: "CREATED", hospitalId, centreId, currentLocation: "Search Test Location" },
    { vialId: otherCentreVialId, donorId: donor.donorId, batchId: `TEST-BATCH-SEARCH-OTHER-${runId}`, bloodGroup: "O+", status: "CREATED", hospitalId, centreId: `${centreId}-OTHER`, currentLocation: "Search Test Location" }
  ]);

  const donorSearch = await request(`/api/donors?q=${encodeURIComponent(donor.uhid)}`, bankToken);
  assert.equal(donorSearch.status, 200);
  assert.equal(donorSearch.body.pagination.total, 1);
  assert.equal(donorSearch.body.data[0].uhid, donor.uhid);

  const vialSearch = await request(`/api/vials?q=${encodeURIComponent(donor.uhid)}&limit=10`, hospitalToken);
  assert.equal(vialSearch.status, 200);
  assert.equal(vialSearch.body.pagination.total, 0);
  assert.equal(vialSearch.body.data.length, 0);
  assert.equal(vialSearch.body.data.some(vial => vial.vialId === otherCentreVialId), false);
});

test("order list adds complete scoped status totals while preserving the data array", async () => {
  const pending = await createOrder({ status: "PENDING", donorId: `TEST-DONOR-PRIVATE-${runId}` });
  const dispatched = await createOrder({ status: "DISPATCHED", donorId: `TEST-DONOR-DISPATCH-${runId}` });
  const receivedId = `TEST-ORDER-${runId}-${crypto.randomUUID()}`;
  tracked.orders.push(receivedId);
  await Order.create({ orderId: receivedId, hospitalId, centreId, requestedBy: "phase1a-test", items: [{ bloodGroup: "O+", quantity: 1 }], status: "RECEIVED" });
  const outOfScopeId = `TEST-ORDER-${runId}-${crypto.randomUUID()}`;
  tracked.orders.push(outOfScopeId);
  await Order.create({ orderId: outOfScopeId, hospitalId, centreId: `${centreId}-OTHER`, requestedBy: "phase1a-test", items: [{ bloodGroup: "O+", quantity: 1 }], status: "PENDING" });

  const expectedByStatus = await Order.aggregate([
    { $match: { hospitalId, centreId } },
    { $group: { _id: "$status", count: { $sum: 1 } } },
    { $sort: { _id: 1 } }
  ]);
  const response = await request("/api/orders", hospitalToken);
  assert.equal(response.status, 200);
  assert.ok(Array.isArray(response.body.data));
  assert.equal(response.body.summary.total, expectedByStatus.reduce((sum, item) => sum + item.count, 0));
  assert.deepEqual(response.body.summary.byStatus, expectedByStatus.map(item => ({ status: item._id, count: item.count })));
  assert.ok(response.body.data.some(order => order.orderId === pending.orderId));
  assert.equal(Object.hasOwn(response.body.data.find(order => order.orderId === pending.orderId), "donorId"), false);
  assert.equal(response.body.data.some(order => order.orderId === outOfScopeId), false);
  const dispatches = await request("/api/dispatches", hospitalToken);
  assert.equal(dispatches.status, 200);
  const hospitalDispatch = dispatches.body.data.find(order => order.orderId === dispatched.orderId);
  assert.ok(hospitalDispatch);
  assert.equal(Object.hasOwn(hospitalDispatch, "donorId"), false);
});

test("existing hospital scope and role restrictions remain enforced", async () => {
  const vial = await createVial({ status: "DISPATCHED", hospital: hospitalId, centre: centreId });
  const order = await createOrder({ status: "DISPATCHED", vialIds: [vial.vialId] });
  const wrongScopeUser = await User.create({ username: `phase1a-wrong-scope-${runId}`, passwordHash: "test-only", role: "HOSPITAL_USER", hospitalId: `${hospitalId}-OTHER`, centreId, sessionVersion: 1, active: true });
  tracked.users.push(wrongScopeUser._id);
  const wrongScopeResponse = await request(`/api/orders/${order.orderId}/receive`, tokenFor(wrongScopeUser, `wrong-scope-${runId}`), "POST", { vialIds: [vial.vialId] });
  assert.equal(wrongScopeResponse.status, 404);
  assert.equal(wrongScopeResponse.body.errorCode, "ORDER_NOT_FOUND");
  const forbidden = await request(`/api/batches/TEST-NONEXISTENT-${runId}/release`, hospitalToken, "POST", {});
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.body.errorCode, "FORBIDDEN");
  assert.equal((await Vial.findOne({ vialId: vial.vialId })).status, "DISPATCHED");
});

test("chain CEO remains aggregate-only while hospital chain scope is unconfigured", async () => {
  const vial = await createVial({ status: "UNUSED_AT_HOSPITAL", hospital: hospitalId, centre: centreId });
  const order = await createOrder({ status: "RECEIVED", vialIds: [vial.vialId] });
  const couple = await createCouple();

  const [vials, orders, dispatches, reports, couples] = await Promise.all([
    request("/api/vials", chainCeoToken),
    request("/api/orders", chainCeoToken),
    request("/api/dispatches", chainCeoToken),
    request("/api/reports", chainCeoToken),
    request("/api/couples", chainCeoToken)
  ]);

  assert.equal(vials.status, 200);
  assert.deepEqual(vials.body.data, []);
  assert.equal(orders.status, 200);
  assert.deepEqual(orders.body.data, []);
  assert.equal(dispatches.status, 200);
  assert.deepEqual(dispatches.body.data, []);
  assert.equal(reports.status, 200);
  assert.equal(reports.body.data.available, false);
  assert.equal(couples.status, 403);
  for (const response of [vials, orders, dispatches, reports, couples]) {
    assert.equal(JSON.stringify(response.body).includes(vial.vialId), false);
    assert.equal(JSON.stringify(response.body).includes(order.orderId), false);
    assert.equal(JSON.stringify(response.body).includes(couple.coupleId), false);
  }
});

test("hospital report applies date filters to its unused-vial total and rejects invalid dates", async () => {
  const historicalVial = await createVial({ status: "UNUSED_AT_HOSPITAL", hospital: hospitalId, centre: centreId });
  await createVial({ status: "UNUSED_AT_HOSPITAL", hospital: hospitalId, centre: centreId });
  await Vial.collection.updateOne({ vialId: historicalVial.vialId }, { $set: { createdAt: new Date("2010-06-15T12:00:00.000Z") } });

  const historical = await request("/api/reports?from=2010-06-01&to=2010-06-30", hospitalToken);
  assert.equal(historical.status, 200);
  assert.equal(historical.body.data.summary.vials, 1);

  const impossibleDate = await request("/api/reports?from=2025-02-30", hospitalToken);
  assert.equal(impossibleDate.status, 400);
  assert.equal(impossibleDate.body.errorCode, "INVALID_REPORT_DATE");
  const reversedRange = await request("/api/reports?from=2025-02-02&to=2025-02-01", hospitalToken);
  assert.equal(reversedRange.status, 400);
  assert.equal(reversedRange.body.errorCode, "INVALID_REPORT_DATE");
});

test("hospital order CSV export is centre-scoped, formula-safe and audited", async () => {
  const visibleOrder = await createOrder();
  visibleOrder.purpose = "=1+1";
  await visibleOrder.save();
  const outsideScopeOrderId = `TEST-ORDER-CSV-${runId}-${crypto.randomUUID()}`;
  tracked.orders.push(outsideScopeOrderId);
  await Order.create({
    orderId: outsideScopeOrderId,
    hospitalId,
    centreId: `${centreId}-OTHER`,
    requestedBy: "phase1a-test",
    items: [{ bloodGroup: "O+", quantity: 1 }],
    purpose: "outside scope",
    status: "PENDING"
  });

  const startedAt = new Date();
  const response = await fetch(`${baseUrl}/api/reports/export/csv`, { headers: { authorization: `Bearer ${hospitalToken}` } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/csv/);
  const csv = await response.text();
  assert.ok(csv.includes(visibleOrder.orderId));
  assert.equal(csv.includes(outsideScopeOrderId), false);
  assert.ok(csv.includes("'=1+1"));
  const audit = await AuditLog.findOne({ userId: hospitalUserId, action: "REPORT_EXPORT", entity: "ORDERS_REPORT", createdAt: { $gte: startedAt } }).sort({ createdAt: -1 }).lean();
  if (audit?._id) tracked.auditIds.push(audit._id);
  assert.ok(audit);

  const excelStartedAt = new Date();
  const excelResponse = await fetch(`${baseUrl}/api/reports/export/excel`, { headers: { authorization: `Bearer ${hospitalToken}` } });
  assert.equal(excelResponse.status, 200);
  const excelCsv = await excelResponse.text();
  assert.ok(excelCsv.startsWith("\"Order ID\""), "the legacy route retains its CSV header; fetch text decoding removes the BOM");
  assert.ok(excelCsv.includes(visibleOrder.orderId));
  assert.equal(excelCsv.includes(outsideScopeOrderId), false);
  const excelAudit = await AuditLog.findOne({ userId: hospitalUserId, action: "REPORT_EXPORT", entity: "ORDERS_REPORT", createdAt: { $gte: excelStartedAt } }).sort({ createdAt: -1 }).lean();
  if (excelAudit?._id) tracked.auditIds.push(excelAudit._id);

  const pdfStartedAt = new Date();
  const pdfResponse = await fetch(`${baseUrl}/api/reports/export/pdf`, { headers: { authorization: `Bearer ${hospitalToken}` } });
  assert.equal(pdfResponse.status, 200);
  assert.match(pdfResponse.headers.get("content-type"), /application\/pdf/);
  const pdfBytes = new Uint8Array(await pdfResponse.arrayBuffer());
  assert.equal(new TextDecoder().decode(pdfBytes.slice(0, 4)), "%PDF");
  const pdfAudit = await AuditLog.findOne({ userId: hospitalUserId, action: "REPORT_EXPORT", entity: "ORDERS_REPORT", createdAt: { $gte: pdfStartedAt } }).sort({ createdAt: -1 }).lean();
  if (pdfAudit?._id) tracked.auditIds.push(pdfAudit._id);
});

test("report exports reject malformed, impossible and reversed date ranges consistently", async () => {
  const paths = [
    "/api/reports/export/csv",
    "/api/reports/export/excel",
    "/api/reports/export/pdf",
    "/api/reports/export/couples"
  ];
  for (const path of paths) {
    const token = path.endsWith("/couples") ? superAdminToken : hospitalToken;
    for (const range of ["from=not-a-date", "from=2025-02-30", "from=2025-02-02&to=2025-02-01"]) {
      const response = await fetch(`${baseUrl}${path}?${range}`, { headers: { authorization: `Bearer ${token}` } });
      const body = await response.json();
      assert.equal(response.status, 400, `${path} should reject ${range}`);
      assert.equal(body.errorCode, "INVALID_REPORT_DATE", `${path} should use the shared date error`);
    }
  }
});

test("CSV report date filters include the complete selected UTC calendar day", async () => {
  const lastMillisecondOfDay = new Date("2010-06-15T23:59:59.999Z");
  const order = await createOrder();
  await Order.collection.updateOne({ orderId: order.orderId }, { $set: { createdAt: lastMillisecondOfDay } });
  const couple = await createCouple();
  await Couple.collection.updateOne({ coupleId: couple.coupleId }, { $set: { createdAt: lastMillisecondOfDay } });

  const orderStartedAt = new Date();
  const ordersResponse = await fetch(`${baseUrl}/api/reports/export/csv?from=2010-06-15&to=2010-06-15`, { headers: { authorization: `Bearer ${hospitalToken}` } });
  assert.equal(ordersResponse.status, 200);
  assert.ok((await ordersResponse.text()).includes(order.orderId));
  const orderAudit = await AuditLog.findOne({ userId: hospitalUserId, action: "REPORT_EXPORT", entity: "ORDERS_REPORT", createdAt: { $gte: orderStartedAt } }).sort({ createdAt: -1 }).lean();
  if (orderAudit?._id) tracked.auditIds.push(orderAudit._id);

  const coupleStartedAt = new Date();
  const couplesResponse = await fetch(`${baseUrl}/api/reports/export/couples?from=2010-06-15&to=2010-06-15`, { headers: { authorization: `Bearer ${superAdminToken}` } });
  assert.equal(couplesResponse.status, 200);
  assert.ok((await couplesResponse.text()).includes(couple.coupleId));
  const coupleAudit = await AuditLog.findOne({ userId: superAdminId, action: "REPORT_EXPORT", entity: "COUPLES_PATIENTS_REPORT", createdAt: { $gte: coupleStartedAt } }).sort({ createdAt: -1 }).lean();
  if (coupleAudit?._id) tracked.auditIds.push(coupleAudit._id);
});

test("detailed couple and patient export streams every patient row and retains couples without patients", async () => {
  const withPatients = await createCouple();
  const withoutPatients = await createCouple();
  withPatients.husband = { name: "Phase 1A Export Partner", patientId: `TEST-PARTNER-${runId}` };
  await withPatients.save();
  const patientFixtures = [
    { patientId: `TEST-PATIENT-CSV-A-${runId}`, hospitalId, centreId, coupleId: withPatients.coupleId, name: "=1+1", gender: "OTHER", status: "REGISTERED" },
    { patientId: `TEST-PATIENT-CSV-B-${runId}`, hospitalId, centreId, coupleId: withPatients.coupleId, name: "Second Patient", gender: "FEMALE", status: "ACTIVE" }
  ];
  tracked.patients.push(...patientFixtures.map(patient => patient.patientId));
  await Patient.create(patientFixtures);

  const startedAt = new Date();
  const response = await fetch(`${baseUrl}/api/reports/export/couples`, { headers: { authorization: `Bearer ${superAdminToken}` } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/csv/);
  const csv = await response.text();
  assert.ok(csv.startsWith("\"coupleId\""));
  assert.ok(csv.includes(withPatients.coupleId));
  assert.ok(csv.includes(withoutPatients.coupleId));
  assert.ok(csv.includes(patientFixtures[0].patientId));
  assert.ok(csv.includes(patientFixtures[1].patientId));
  assert.ok(csv.includes("'=1+1"));
  const coupleLines = csv.split("\r\n").filter(line => line.includes(withPatients.coupleId));
  const noPatientLines = csv.split("\r\n").filter(line => line.includes(withoutPatients.coupleId));
  assert.equal(coupleLines.length, 2);
  assert.equal(noPatientLines.length, 1);

  const audit = await AuditLog.findOne({ userId: superAdminId, action: "REPORT_EXPORT", entity: "COUPLES_PATIENTS_REPORT", createdAt: { $gte: startedAt } }).sort({ createdAt: -1 }).lean();
  if (audit?._id) tracked.auditIds.push(audit._id);
  assert.ok(audit);
});

test("simultaneous hospital logins claim one session and audit the winner/block transactionally", async () => {
  const user = await User.create({
    username: `phase1a-login-race-${runId}-${crypto.randomUUID()}`,
    passwordHash: await bcrypt.hash(`test-password-${runId}`, 4),
    role: "HOSPITAL_USER", hospitalId, centreId, sessionVersion: 1, active: true
  });
  tracked.users.push(user._id);
  const body = { username: user.username, password: `test-password-${runId}` };
  const [first, second] = await Promise.all([
    request("/api/auth/login", "", "POST", body),
    request("/api/auth/login", "", "POST", body)
  ]);
  assert.equal([first, second].filter(result => result.status === 200).length, 1);
  assert.equal([first, second].filter(result => result.status === 409 && result.body.errorCode === "ACTIVE_SESSION").length, 1);
  const saved = await User.findById(user._id).lean();
  assert.ok(saved.activeSessionId);
  assert.equal(await AuditLog.countDocuments({ entityId: String(user._id), action: "LOGIN_SUCCESS" }), 1);
  assert.equal(await AuditLog.countDocuments({ entityId: String(user._id), action: "LOGIN_BLOCKED_ACTIVE_SESSION" }), 1);
});

test("failed login audit does not persist an unverified username", async () => {
  const submittedUsername = `TEST-SENSITIVE-LOGIN-${runId}-${crypto.randomUUID()}`;
  const requestAt = new Date();
  const response = await request("/api/auth/login", bankToken, "POST", { username: submittedUsername, password: "wrong-test-password" });
  assert.equal(response.status, 401);
  assert.equal(response.body.errorCode, "INVALID_LOGIN");
  const malformed = await request("/api/auth/login", bankToken, "POST", { username: { $ne: "" }, password: 123 });
  assert.equal(malformed.status, 401);
  assert.equal(malformed.body.errorCode, "INVALID_LOGIN");
  const events = await AuditLog.find({ action: "LOGIN_FAILED", entity: "AUTH", createdAt: { $gte: requestAt } }).sort({ createdAt: 1, _id: 1 });
  assert.equal(events.length, 2);
  tracked.auditIds.push(...events.map(event => event._id));
  assert.ok(events.every(event => !Object.hasOwn(event.toObject(), "entityId")));
  assert.equal(JSON.stringify(events).includes(submittedUsername), false);
});

test("hospital registration requires a username used as the login and hospital ID", async () => {
  const hospitalName = `Phase 1A Hospital Registration ${runId}`;
  const missingUsername = await request("/api/users/hospital-registration", superAdminToken, "POST", {
    hospitalName, password: "test-only-password"
  });
  assert.equal(missingUsername.status, 400);
  assert.equal(missingUsername.body.errorCode, "HOSPITAL_REGISTRATION_REQUIRED");

  const loginUsername = `hospital-login-${runId}`;
  const response = await request("/api/users/hospital-registration", superAdminToken, "POST", {
    hospitalName, username: loginUsername, password: "test-only-password"
  });
  if (response.status === 201 && response.body?.data?._id) tracked.users.push(response.body.data._id);
  assert.equal(response.status, 201);
  assert.equal(response.body.data.username, loginUsername);
  assert.equal(response.body.data.hospitalId, loginUsername);
  assert.equal(response.body.data.centreId, `CENTRE-${loginUsername}`);
  assert.equal(response.body.data.centreName, hospitalName);
  assert.equal(response.body.data.hospitalName, hospitalName);
  assert.equal(Object.hasOwn(response.body.data, "passwordHash"), false);
  const savedHospital = await User.findById(response.body.data._id).lean();
  assert.equal(savedHospital.centreId, `CENTRE-${loginUsername}`);
  assert.equal(savedHospital.centreName, hospitalName);

  const customUsernameResponse = await request("/api/users/hospital-registration", superAdminToken, "POST", {
    hospitalName: `${hospitalName} Custom Login`, username: `hospital-custom-${runId}`, password: "test-only-password"
  });
  if (customUsernameResponse.status === 201 && customUsernameResponse.body?.data?._id) tracked.users.push(customUsernameResponse.body.data._id);
  assert.equal(customUsernameResponse.status, 201);
  assert.equal(customUsernameResponse.body.data.username, `hospital-custom-${runId}`);
  assert.equal(customUsernameResponse.body.data.hospitalId, `hospital-custom-${runId}`);
  assert.equal(customUsernameResponse.body.data.centreId, `CENTRE-hospital-custom-${runId}`);

  const invalidUsername = await request("/api/users/hospital-registration", superAdminToken, "POST", {
    hospitalName: `${hospitalName} Invalid Login`, username: "not a valid username", password: "test-only-password"
  });
  assert.equal(invalidUsername.status, 400);
  assert.equal(invalidUsername.body.errorCode, "INVALID_USERNAME");

  const duplicateUsername = await request("/api/users/hospital-registration", superAdminToken, "POST", {
    hospitalName: `${hospitalName} Duplicate Login`, username: loginUsername, password: "test-only-password"
  });
  assert.equal(duplicateUsername.status, 409);
  assert.equal(duplicateUsername.body.errorCode, "USERNAME_EXISTS");

  const duplicate = await request("/api/users/hospital-registration", superAdminToken, "POST", {
    hospitalName: hospitalName.toUpperCase(), username: `hospital-duplicate-${runId}`, password: "test-only-password"
  });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.errorCode, "HOSPITAL_REGISTRATION_EXISTS");
});

test("user create, role/scope updates, password changes and forced logout are audited transactionally", async () => {
  const created = await request("/api/users", superAdminToken, "POST", {
    username: `phase1a-audited-user-${runId}`,
    password: "test-only-password",
    name: "Phase 1A fixture user",
    role: "ART_BANK_STAFF"
  });
  if (created.status === 201 && created.body?.data?._id) tracked.users.push(created.body.data._id);
  assert.equal(created.status, 201);
  const userId = String(created.body.data._id);
  let event = await AuditLog.findOne({ entityId: userId, action: "USER_CREATED" }).lean();
  assert.ok(event);
  assert.deepEqual(event.newValues, { assignedRole: "ART_BANK_STAFF", active: true });
  assert.equal(JSON.stringify(event).includes("test-only-password"), false);

  const updated = await request(`/api/users/${encodeURIComponent(userId)}`, superAdminToken, "PUT", {
    role: "HOSPITAL_USER", hospitalId, centreId
  });
  assert.equal(updated.status, 200);
  event = await AuditLog.findOne({ entityId: userId, action: "USER_UPDATED" }).lean();
  assert.ok(event);
  assert.equal(event.newValues.roleChanged, "HOSPITAL_USER");
  assert.equal(event.newValues.hospitalId, hospitalId);
  assert.equal(event.newValues.centreId, centreId);

  const password = await request(`/api/users/${encodeURIComponent(userId)}/password`, superAdminToken, "PUT", { password: "another-test-only-password" });
  assert.equal(password.status, 200);
  event = await AuditLog.findOne({ entityId: userId, action: "USER_PASSWORD_CHANGED" }).lean();
  assert.ok(event);
  assert.equal(JSON.stringify(event).includes("another-test-only-password"), false);

  const logout = await request(`/api/users/${encodeURIComponent(userId)}/force-logout`, superAdminToken, "POST", {});
  assert.equal(logout.status, 200);
  assert.ok(await AuditLog.findOne({ entityId: userId, action: "USER_FORCE_LOGOUT" }).lean());
});

test("user list pagination keeps its array response and excludes session/security fields", async () => {
  const first = await request("/api/users?limit=1&skip=0", superAdminToken);
  assert.equal(first.status, 200);
  assert.equal(Array.isArray(first.body.data), true);
  assert.equal(first.body.data.length, 1);
  assert.equal(first.body.pagination.limit, 1);
  assert.ok(first.body.pagination.total >= 1);
  assert.equal(Object.hasOwn(first.body.data[0], "passwordHash"), false);
  assert.equal(Object.hasOwn(first.body.data[0], "activeSessionId"), false);
  assert.equal(Object.hasOwn(first.body.data[0], "scopeRegistryVersion"), false);
  if (first.body.pagination.hasMore) {
    const second = await request("/api/users?limit=1&skip=1", superAdminToken);
    assert.equal(second.status, 200);
    assert.equal(Array.isArray(second.body.data), true);
    assert.equal(second.body.data.length, 1);
    assert.notEqual(second.body.data[0]._id, first.body.data[0]._id);
  }
});

test("concurrent named hospital-user creation rejects distinct names that collapse to one scope ID", async () => {
  const suffix = crypto.randomUUID();
  const requests = await Promise.all([
    request("/api/users", superAdminToken, "POST", {
      username: `phase1a-scope-collision-a-${suffix}`, password: "test-only-password", name: "Scope fixture A", role: "HOSPITAL_USER",
      hospitalName: "St. Mary's Scope Clinic", centreName: "Main Centre"
    }),
    request("/api/users", superAdminToken, "POST", {
      username: `phase1a-scope-collision-b-${suffix}`, password: "test-only-password", name: "Scope fixture B", role: "HOSPITAL_USER",
      hospitalName: "St Mary's Scope Clinic", centreName: "Main Centre"
    })
  ]);
  const created = requests.filter(response => response.status === 201);
  const rejected = requests.filter(response => response.status === 409);
  for (const response of created) tracked.users.push(response.body.data._id);
  assert.equal(created.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].body.errorCode, "HOSPITAL_SCOPE_ID_COLLISION");
  assert.equal(await User.countDocuments({ username: { $in: [`phase1a-scope-collision-a-${suffix}`, `phase1a-scope-collision-b-${suffix}`] } }), 1);
});

test("hospital-user scope update cannot collide with another named facility", async () => {
  const suffix = crypto.randomUUID();
  const base = await request("/api/users", superAdminToken, "POST", {
    username: `phase1a-scope-base-${suffix}`, password: "test-only-password", name: "Scope base", role: "HOSPITAL_USER",
    hospitalName: `Northside Clinic ${suffix}`, centreName: "Central Centre"
  });
  if (base.status === 201) tracked.users.push(base.body.data._id);
  assert.equal(base.status, 201);
  const target = await request("/api/users", superAdminToken, "POST", {
    username: `phase1a-scope-target-${suffix}`, password: "test-only-password", name: "Scope target", role: "HOSPITAL_USER",
    hospitalName: `Southside Clinic ${suffix}`, centreName: "Central Centre"
  });
  if (target.status === 201) tracked.users.push(target.body.data._id);
  assert.equal(target.status, 201);

  const attempted = await request(`/api/users/${encodeURIComponent(target.body.data._id)}`, superAdminToken, "PUT", {
    hospitalName: `Northside-Clinic ${suffix}`, centreName: "Central Centre"
  });
  assert.equal(attempted.status, 409);
  assert.equal(attempted.body.errorCode, "HOSPITAL_SCOPE_ID_COLLISION");
  const unchanged = await User.findById(target.body.data._id).lean();
  assert.equal(unchanged.hospitalId, target.body.data.hospitalId);
  assert.equal(unchanged.hospitalName, `Southside Clinic ${suffix}`);
});

test("user active fields require booleans and deactivation revokes sessions permanently", async () => {
  const invalidCreate = await request("/api/users", superAdminToken, "POST", {
    username: `phase1a-invalid-active-${runId}`,
    password: "test-only-password",
    name: "Invalid active fixture",
    role: "ART_BANK_STAFF",
    active: "false"
  });
  assert.equal(invalidCreate.status, 400);
  assert.equal(invalidCreate.body.errorCode, "INVALID_ACTIVE_STATUS");
  assert.equal(await User.exists({ username: `phase1a-invalid-active-${runId}` }), null);

  const sessionId = `phase1a-active-session-${runId}`;
  const user = await User.create({
    username: `phase1a-active-revoke-${runId}`,
    passwordHash: "test-only",
    role: "HOSPITAL_USER",
    hospitalId,
    centreId,
    active: true,
    activeSessionId: sessionId,
    sessionVersion: 4
  });
  tracked.users.push(user._id);
  const oldToken = tokenFor(user, sessionId);

  const malformedUpdate = await request(`/api/users/${user._id}`, superAdminToken, "PUT", { active: "false" });
  assert.equal(malformedUpdate.status, 400);
  assert.equal(malformedUpdate.body.errorCode, "INVALID_ACTIVE_STATUS");
  let current = await User.findById(user._id).lean();
  assert.equal(current.active, true);
  assert.equal(current.activeSessionId, sessionId);
  assert.equal(current.sessionVersion, 4);

  const deactivated = await request(`/api/users/${user._id}`, superAdminToken, "PUT", { active: false });
  assert.equal(deactivated.status, 200);
  current = await User.findById(user._id).lean();
  assert.equal(current.active, false);
  assert.equal(current.activeSessionId, null);
  assert.equal(current.sessionVersion, 5);

  const reactivated = await request(`/api/users/${user._id}`, superAdminToken, "PUT", { active: true });
  assert.equal(reactivated.status, 200);
  const oldSession = await request("/api/reports", oldToken);
  assert.equal(oldSession.status, 401);
  assert.equal(oldSession.body.errorCode, "SESSION_REVOKED");
});

test("self logout revokes its current token transactionally without clearing a newer session", async () => {
  const sessionId = `phase1a-self-logout-${runId}`;
  const user = await User.create({
    username: `phase1a-self-logout-user-${runId}`,
    passwordHash: "test-only",
    role: "ART_BANK_STAFF",
    active: true,
    activeSessionId: sessionId,
    sessionVersion: 2
  });
  tracked.users.push(user._id);

  const token = tokenFor(user, sessionId);
  const response = await request("/api/auth/logout", token, "POST", {});
  assert.equal(response.status, 200);
  assert.equal(response.body.success, true);
  assert.equal(response.body.data.loggedOut, true);

  const revoked = await User.findById(user._id).lean();
  assert.equal(revoked.activeSessionId, undefined);
  assert.equal(revoked.sessionVersion, 3);
  const audit = await AuditLog.findOne({ entityId: String(user._id), action: "LOGOUT_SUCCESS" }).lean();
  if (audit?._id) tracked.auditIds.push(audit._id);
  assert.ok(audit);
  assert.equal(Object.hasOwn(audit, "newValues"), false);

  const oldTokenRequest = await request("/api/reports", token);
  assert.equal(oldTokenRequest.status, 401);
  assert.equal(oldTokenRequest.body.errorCode, "SESSION_REVOKED");

  const newerSessionId = `phase1a-self-logout-new-${runId}`;
  const secondUser = await User.create({
    username: `phase1a-self-logout-race-${runId}`,
    passwordHash: "test-only",
    role: "ART_BANK_STAFF",
    active: true,
    activeSessionId: newerSessionId,
    sessionVersion: 7
  });
  tracked.users.push(secondUser._id);
  const staleToken = tokenFor(secondUser, `phase1a-self-logout-stale-${runId}`);
  const staleResponse = await request("/api/auth/logout", staleToken, "POST", {});
  assert.equal(staleResponse.status, 401);
  assert.equal(staleResponse.body.errorCode, "SESSION_REPLACED");
  const untouched = await User.findById(secondUser._id).lean();
  assert.equal(untouched.activeSessionId, newerSessionId);
  assert.equal(untouched.sessionVersion, 7);

  const legacyUser = await User.create({
    username: `phase1a-self-logout-legacy-${runId}`,
    passwordHash: "test-only",
    role: "ART_BANK_STAFF",
    active: true,
    sessionVersion: 3
  });
  tracked.users.push(legacyUser._id);
  const legacyToken = tokenFor(legacyUser, `phase1a-self-logout-legacy-session-${runId}`);
  const legacyResponse = await request("/api/auth/logout", legacyToken, "POST", {});
  assert.equal(legacyResponse.status, 200);
  assert.equal(legacyResponse.body.data.loggedOut, true);
  const legacyRevoked = await User.findById(legacyUser._id).lean();
  assert.equal(legacyRevoked.sessionVersion, 4);
  const legacyTokenUse = await request("/api/reports", legacyToken);
  assert.equal(legacyTokenUse.status, 401);
  assert.equal(legacyTokenUse.body.errorCode, "SESSION_REVOKED");
});
