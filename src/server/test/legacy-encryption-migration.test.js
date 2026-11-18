"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { parseOptions, inspectLegacyFiles } = require("../../../scripts/encrypt-legacy-data");

test("migration defaults to dry-run and reports no write authorization", () => {
  const options = parseOptions([], "isolated_db");
  assert.equal(options.dryRun, true);
  assert.equal(options.execute, false);
});

test("execute requires exact database, backup, and write confirmations", () => {
  assert.throws(() => parseOptions(["--execute"], "isolated_db"), /confirm-database/);
  assert.throws(() => parseOptions(["--execute", "--confirm-database=other", "--confirm-backup=YES", "--confirm-writes=YES"], "isolated_db"), /confirm-database/);
  assert.throws(() => parseOptions(["--execute", "--confirm-database=isolated_db"], "isolated_db"), /confirm-backup/);
  const options = parseOptions(["--execute", "--confirm-database=isolated_db", "--confirm-backup=YES", "--confirm-writes=YES"], "isolated_db");
  assert.equal(options.execute, true);
  assert.equal(options.dryRun, undefined);
});

test("migration rejects conflicting and unknown arguments", () => {
  assert.throws(() => parseOptions(["--execute", "--dry-run"], "isolated_db"), /Choose either/);
  assert.throws(() => parseOptions(["--unexpected"], "isolated_db"), /Unknown migration option/);
});

test("normal API startup does not run the historical encryption migration", async () => {
  const startupSource = await fs.readFile(path.join(__dirname, "../http/database.js"), "utf8");
  assert.doesNotMatch(startupSource, /encryptLegacyFiles|encryptLegacySensitiveString|Signature\.find/);
  assert.match(startupSource, /mongoose\s*\.connect\(process\.env\.MONGODB_URI,\s*databaseConnectionOptions\(process\.env\.NODE_ENV\)\)/);
});

test("file inspection counts encrypted and legacy files without changing them", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "art-bank-encryption-inspect-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const legacy = Buffer.from("legacy fixture");
  const encrypted = Buffer.concat([Buffer.from("PAB1"), Buffer.from("test fixture")]);
  await fs.writeFile(path.join(directory, "legacy.pdf"), legacy);
  await fs.writeFile(path.join(directory, "encrypted.pdf"), encrypted);
  await fs.writeFile(path.join(directory, "ignored.tmp"), "temporary");

  const result = await inspectLegacyFiles(directory);
  assert.deepEqual(result, { totalFiles: 2, encryptedFiles: 1, legacyFiles: 1 });
  assert.deepEqual(await fs.readFile(path.join(directory, "legacy.pdf")), legacy);
  assert.deepEqual(await fs.readFile(path.join(directory, "encrypted.pdf")), encrypted);
});

test("missing upload directory is reported as an empty inventory", async t => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "art-bank-encryption-missing-"));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  assert.deepEqual(await inspectLegacyFiles(path.join(parent, "not-created")), {
    totalFiles: 0,
    encryptedFiles: 0,
    legacyFiles: 0
  });
});
