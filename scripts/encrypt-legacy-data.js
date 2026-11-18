#!/usr/bin/env node
"use strict";

const fs = require("fs/promises");
const path = require("path");

function parseOptions(argv, actualDatabase) {
  const options = { execute: false, confirmedDatabase: null, backupConfirmed: false, writesConfirmed: false };
  for (const argument of argv) {
    if (argument === "--dry-run") {
      if (options.execute) throw new Error("Choose either --dry-run or --execute");
      options.dryRun = true;
    } else if (argument === "--execute") {
      if (options.dryRun) throw new Error("Choose either --dry-run or --execute");
      options.execute = true;
    } else if (argument.startsWith("--confirm-database=")) {
      options.confirmedDatabase = argument.slice("--confirm-database=".length);
    } else if (argument === "--confirm-backup=YES") {
      options.backupConfirmed = true;
    } else if (argument === "--confirm-writes=YES") {
      options.writesConfirmed = true;
    } else {
      throw new Error("Unknown migration option");
    }
  }
  if (!options.execute) return { ...options, dryRun: true };
  if (!options.confirmedDatabase || options.confirmedDatabase !== actualDatabase) {
    throw new Error("--execute requires --confirm-database to exactly match the URI database name");
  }
  if (!options.backupConfirmed || !options.writesConfirmed) {
    throw new Error("--execute requires --confirm-backup=YES and --confirm-writes=YES");
  }
  return options;
}

async function inspectLegacyFiles(directory) {
  let entries;
  try { entries = await fs.readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === "ENOENT") return { totalFiles: 0, encryptedFiles: 0, legacyFiles: 0 }; throw error; }
  let totalFiles = 0, encryptedFiles = 0, legacyFiles = 0;
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.endsWith(".tmp")) continue;
    totalFiles++;
    const handle = await fs.open(path.join(directory, entry.name), "r");
    try {
      const header = Buffer.alloc(4);
      const { bytesRead } = await handle.read(header, 0, header.length, 0);
      if (bytesRead === 4 && header.equals(Buffer.from("PAB1"))) encryptedFiles++;
      else legacyFiles++;
    } finally { await handle.close(); }
  }
  return { totalFiles, encryptedFiles, legacyFiles };
}

async function countInvalidSignaturePayloads(Signature) {
  const rows = await Signature.aggregate([
    { $match: { $expr: { $ne: [{ $type: "$signatureData" }, "string"] } } },
    { $count: "count" }
  ]);
  return rows[0]?.count || 0;
}

async function main() {
  require("dotenv").config({ path: process.env.ENV_FILE || ".env.production" });
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is required");
  const parsedUri = new URL(uri);
  const actualDatabase = decodeURIComponent(parsedUri.pathname.replace(/^\//, ""));
  if (!actualDatabase) throw new Error("MONGODB_URI must include a database name");
  const options = parseOptions(process.argv.slice(2), actualDatabase);

  const mongoose = require("mongoose");
  const Signature = require("../src/server/models/Signature");
  const { privateDirectory, encryptLegacyFiles, encryptLegacySensitiveString } = require("../src/server/middleware/privateUpload");
  await mongoose.connect(uri, { autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 10000 });
  try {
    if (mongoose.connection.name !== actualDatabase) throw new Error("Connected database does not match the URI database name");
    const files = await inspectLegacyFiles(privateDirectory);
    const invalidSignaturePayloads = await countInvalidSignaturePayloads(Signature);
    if (invalidSignaturePayloads) throw new Error("Signature records with missing or non-string content require manual review; no migration was performed");
    const legacySignatureCount = await Signature.countDocuments({ signatureData: { $not: /^enc:v1:/ } });
    console.log(JSON.stringify({
      mode: options.dryRun ? "dry-run" : "execute",
      database: actualDatabase,
      uploadFiles: files,
      legacySignatureCount,
      writesPerformed: false
    }));
    if (options.dryRun) return;

    await encryptLegacyFiles();
    let encryptedSignatures = 0;
    const cursor = Signature.find({ signatureData: { $not: /^enc:v1:/ } }).select("_id signatureData").lean().cursor();
    for await (const signature of cursor) {
      if (typeof signature.signatureData !== "string") throw new Error("Encountered non-string signature content; stopping migration");
      const encrypted = encryptLegacySensitiveString(signature.signatureData);
      const result = await Signature.collection.updateOne(
        { _id: signature._id, signatureData: signature.signatureData },
        { $set: { signatureData: encrypted } }
      );
      if (result.matchedCount !== 1) throw new Error("A signature changed during migration; stop and review before retrying");
      encryptedSignatures++;
    }
    const remainingFiles = await inspectLegacyFiles(privateDirectory);
    const remainingSignatures = await Signature.countDocuments({ signatureData: { $not: /^enc:v1:/ } });
    if (remainingFiles.legacyFiles || remainingSignatures) throw new Error("Post-migration verification found remaining legacy data");
    console.log(JSON.stringify({
      mode: "complete",
      database: actualDatabase,
      encryptedFiles: files.legacyFiles,
      encryptedSignatures,
      remainingLegacyFiles: remainingFiles.legacyFiles,
      remainingLegacySignatures: remainingSignatures
    }));
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch(error => {
    // Connection and filesystem errors can contain configured hosts or paths.
    // Keep terminal output free of URI credentials and private storage details.
    const safeMessage = [
      "MONGODB_URI is required",
      "MONGODB_URI must include a database name",
      "--execute requires --confirm-database to exactly match the URI database name",
      "--execute requires --confirm-backup=YES and --confirm-writes=YES",
      "Choose either --dry-run or --execute",
      "Unknown migration option",
      "Connected database does not match the URI database name",
      "Signature records with missing or non-string content require manual review; no migration was performed",
      "Encountered non-string signature content; stopping migration",
      "A signature changed during migration; stop and review before retrying",
      "Post-migration verification found remaining legacy data"
    ].find(message => error.message === message);
    console.error(`Legacy encryption migration stopped${safeMessage ? `: ${safeMessage}` : ". Review the protected operator logs for the underlying error."}`);
    process.exitCode = 1;
  });
}

module.exports = { parseOptions, inspectLegacyFiles, countInvalidSignaturePayloads };
