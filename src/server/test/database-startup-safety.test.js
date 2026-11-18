"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { databaseConnectionOptions } = require("../services/databaseConnectionOptions");

const backendDirectory = path.resolve(__dirname, "../../..");
const productionConfigScript = path.join(backendDirectory, "scripts", "validate-production-config.js");

function productionConfigEnvironment(overrides = {}) {
  return {
    PATH: process.env.PATH,
    NODE_ENV: "production",
    MONGODB_URI: "mongodb://preflight.invalid/does_not_connect",
    JWT_SECRET: "configuration-only-placeholder-secret-value",
    CLIENT_ORIGIN: "https://parenthood.invalid",
    PORTAL_HOST: "parenthood.invalid",
    UPLOAD_ENCRYPTION_KEY: "a".repeat(64),
    CLAMAV_HOST: "clamav.invalid",
    TRUST_PROXY: "true",
    ...overrides
  };
}

test("production database connections do not auto-create collections or indexes", () => {
  const options = databaseConnectionOptions("production");
  assert.deepEqual(options, { autoIndex: false, autoCreate: false });
});

test("non-production database connection defaults remain unchanged", () => {
  assert.deepEqual(databaseConnectionOptions("development"), {});
  assert.deepEqual(databaseConnectionOptions("test"), {});
});

test("production configuration accepts a canonical portal host matching the HTTPS origin without connecting", () => {
  const result = spawnSync(process.execPath, [productionConfigScript], {
    cwd: backendDirectory,
    env: productionConfigEnvironment(),
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Production configuration is ready/);
});

test("production configuration rejects malformed or mismatched portal hosts", () => {
  for (const [portalHost, clientOrigin, expectedMessage] of [
    ["bad;host", "https://parenthood.invalid", "PORTAL_HOST must be a DNS hostname"],
    ["other.invalid", "https://parenthood.invalid", "PORTAL_HOST must match the hostname in CLIENT_ORIGIN"]
  ]) {
    const result = spawnSync(process.execPath, [productionConfigScript], {
      cwd: backendDirectory,
      env: productionConfigEnvironment({ PORTAL_HOST: portalHost, CLIENT_ORIGIN: clientOrigin }),
      encoding: "utf8"
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(expectedMessage));
    assert.equal(result.stderr.includes(portalHost), false, "configuration errors must not echo supplied values");
  }
});

