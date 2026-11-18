"use strict";

const { after, before, test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET ||= crypto.randomBytes(32).toString("hex");
process.env.UPLOAD_ENCRYPTION_KEY ||= crypto.randomBytes(32).toString("hex");

const app = require("./support/app");
const User = require("../models/User");
const AuthorizedSigner = require("../models/AuthorizedSigner");

const fixtureId = crypto.randomUUID();
const username = `signer-update-test-${fixtureId}`;
const signerId = `SIGNER-UPDATE-TEST-${fixtureId}`;
let userId;
let server;
let baseUrl;
let token;

function assertIsolatedTestDatabase() {
  assert.ok(process.env.MONGODB_URI, "MONGODB_URI must be supplied by the isolated test runner");
  const uri = new URL(process.env.MONGODB_URI);
  assert.equal(decodeURIComponent(uri.pathname.replace(/^\//, "")), "parenthood_phase1_test");
  assert.ok(["127.0.0.1", "localhost"].includes(uri.hostname), "Refusing to connect unless MongoDB is a local test instance");
}

before(async () => {
  assertIsolatedTestDatabase();
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
  assert.equal(mongoose.connection.name, "parenthood_phase1_test");
  const user = await User.create({ username, passwordHash: "test-only", role: "SUPER_ADMIN", active: true, sessionVersion: 1 });
  userId = user._id;
  token = jwt.sign({ id: String(user._id), username, role: user.role, sessionVersion: 1 }, process.env.JWT_SECRET, { expiresIn: "5m" });
  await AuthorizedSigner.create({
    signerId,
    name: "Signer before update",
    designation: "Authorised signatory",
    imageStorageName: "test-only-image.enc",
    imageMimeType: "image/png",
    imageOriginalName: "test.png",
    imageVersions: [{ version: 1, storageName: "test-only-image.enc", mimeType: "image/png", originalName: "test.png" }]
  });
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  if (mongoose.connection.readyState === 1) {
    if (signerId) await AuthorizedSigner.deleteOne({ signerId });
    if (userId) await User.deleteOne({ _id: userId });
    await mongoose.disconnect();
  }
});

test("PUT signer preserves omitted fields and completes against the actual API", async () => {
  const response = await fetch(`${baseUrl}/api/signers/${encodeURIComponent(signerId)}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}` }
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.success, true);
  assert.equal(body.data.signerId, signerId);
  assert.equal(body.data.name, "Signer before update");
  assert.equal(body.data.designation, "Authorised signatory");
  assert.equal(body.data.version, 2);
});
