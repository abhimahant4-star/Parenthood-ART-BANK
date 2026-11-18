"use strict";

const mongoose = require("mongoose");
const { databaseConnectionOptions } = require("../services/databaseConnectionOptions");

function assertProductionConfiguration() {
  if (process.env.NODE_ENV !== "production") return;
  const missing = ["MONGODB_URI", "JWT_SECRET", "CLIENT_ORIGIN", "CLAMAV_HOST"].filter(key => !process.env[key]);
  if (missing.length) throw new Error(`Production configuration is incomplete: ${missing.join(", ")}`);
  if (process.env.TRUST_PROXY !== "true") throw new Error("TRUST_PROXY=true is required behind the HTTPS reverse proxy");
}

// Next.js can load this module more than once, so one connection is shared globally.
const cache = globalThis.__parenthoodDatabase || (globalThis.__parenthoodDatabase = { connection: null });

async function connectDatabase() {
  if (mongoose.connection.readyState === 1) return mongoose.connection;
  if (!cache.connection) {
    assertProductionConfiguration();
    if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is not configured");
    cache.connection = mongoose
      .connect(process.env.MONGODB_URI, databaseConnectionOptions(process.env.NODE_ENV))
      .catch(error => {
        cache.connection = null;
        throw error;
      });
  }
  await cache.connection;
  return mongoose.connection;
}

module.exports = { connectDatabase };
