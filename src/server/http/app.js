"use strict";

const cors = require("cors");
const helmet = require("helmet");
const mongoose = require("mongoose");
const qs = require("qs");
const { ApiResponse } = require("./response");
const { connectDatabase } = require("./database");

const JSON_BODY_LIMIT = 2 * 1024 * 1024;
const RATE_WINDOW_MS = 15 * 60 * 1000;

const mounts = [
  ["/api/auth", require("../routes/auth")],
  ["/api/users", require("../routes/users")],
  ["/api/donors", require("../routes/donors")],
  ["/api/batches", require("../routes/batches")],
  ["/api/vials", require("../routes/vials")],
  ["/api/stock", require("../routes/stock")],
  ["/api/hospitals", require("../routes/hospitals")],
  ["/api/centres", require("../routes/centres")],
  ["/api/orders", require("../routes/orders")],
  ["/api/dispatches", require("../routes/dispatches")],
  ["/api/couples", require("../routes/couples")],
  ["/api/mappings", require("../routes/mappings")],
  ["/api/attachments", require("../routes/attachments")],
  ["/api/signers", require("../routes/signers")],
  ["/api/declarations", require("../routes/declarations")],
  ["/api", require("../routes/declarationCorrections")],
  ["/api/signatures", require("../routes/signatures")],
  ["/api/reports", require("../routes/reports")],
  ["/api/audit", require("../routes/audit")]
];

const production = () => process.env.NODE_ENV === "production";
const trustProxy = () => process.env.TRUST_PROXY === "true";
const applyHelmet = helmet();

function allowedOrigins() {
  const fallback = production() ? "" : "http://localhost:3000,http://127.0.0.1:3000";
  return String(process.env.CLIENT_ORIGIN || fallback).split(",").map(origin => origin.trim()).filter(Boolean);
}

const applyCors = cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins().includes(origin)) return callback(null, true);
    const error = new Error("Origin is not allowed");
    error.status = 403;
    error.code = "ORIGIN_NOT_ALLOWED";
    return callback(error);
  },
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
});

// Requests are counted per client address for this server process.
const rateBuckets = globalThis.__parenthoodRateBuckets || (globalThis.__parenthoodRateBuckets = new Map());

function isRateLimited(key, max, res) {
  const now = Date.now();
  let bucket = rateBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + RATE_WINDOW_MS };
    rateBuckets.set(key, bucket);
  }
  bucket.count += 1;
  res.setHeader("RateLimit-Limit", max);
  res.setHeader("RateLimit-Remaining", Math.max(max - bucket.count, 0));
  res.setHeader("RateLimit-Reset", Math.ceil((bucket.resetAt - now) / 1000));
  if (rateBuckets.size > 10000) {
    for (const [storedKey, stored] of rateBuckets) if (stored.resetAt <= now) rateBuckets.delete(storedKey);
  }
  return bucket.count > max;
}

function forwardedValue(value) {
  return String(value || "").split(",").map(item => item.trim()).filter(Boolean);
}

function buildRequest(request, url) {
  const headers = Object.fromEntries(request.headers.entries());
  const hostHeader = (trustProxy() && forwardedValue(headers["x-forwarded-host"]).at(-1)) || headers.host || url.host;
  const forwardedFor = forwardedValue(headers["x-forwarded-for"]);
  return {
    method: request.method,
    url: `${url.pathname}${url.search}`,
    path: url.pathname,
    headers,
    query: qs.parse(url.search.slice(1)),
    params: {},
    body: {},
    hostname: hostHeader.replace(/:\d+$/, "").toLowerCase(),
    secure: url.protocol === "https:" || (trustProxy() && forwardedValue(headers["x-forwarded-proto"]).at(-1) === "https"),
    ip: (trustProxy() && forwardedFor.at(-1)) || "local",
    webRequest: request
  };
}

async function parseBody(req) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return;
  const contentType = String(req.headers["content-type"] || "").toLowerCase();
  const isJson = contentType.includes("application/json");
  const isForm = contentType.includes("application/x-www-form-urlencoded");
  if (!isJson && !isForm) return;

  const tooLarge = () => Object.assign(new Error("Request body is too large"), { status: 413, code: "PAYLOAD_TOO_LARGE" });
  if (Number(req.headers["content-length"] || 0) > JSON_BODY_LIMIT) throw tooLarge();
  const text = await req.webRequest.text();
  if (Buffer.byteLength(text) > JSON_BODY_LIMIT) throw tooLarge();
  if (!text) return;

  if (isForm) {
    req.body = qs.parse(text);
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw Object.assign(new Error("Request body must be valid JSON"), { status: 400, code: "INVALID_JSON" });
  }
  if (parsed === null || typeof parsed !== "object") {
    throw Object.assign(new Error("Request body must be a JSON object or array"), { status: 400, code: "INVALID_JSON" });
  }
  req.body = parsed;
}

const runMiddleware = (middleware, req, res) => new Promise((resolve, reject) => {
  middleware(req, res, error => (error ? reject(error) : resolve()));
});

function routeRequest(req, res) {
  return new Promise((resolve, reject) => {
    let index = 0;
    const nextMount = error => {
      if (error) return reject(error);
      while (index < mounts.length) {
        const [prefix, router] = mounts[index++];
        if (req.path !== prefix && !req.path.startsWith(`${prefix}/`)) continue;
        return router.handle(req, res, nextMount, req.path.slice(prefix.length) || "/");
      }
      return resolve(false);
    };
    nextMount();
  });
}

function sendError(error, req, res) {
  const errorCode = error.errorCode || error.code || "SERVER_ERROR";
  if (production()) console.error("Request failed", { path: req.path, code: errorCode });
  else console.error(error);
  if (res.headersSent) {
    res.destroy(error);
    return;
  }
  res.status(error.status || 500).json({
    success: false,
    message: production() ? "Request could not be completed" : (error.message || "Server error"),
    errorCode
  });
}

async function processRequest(req, res) {
  const localHttpAllowed = process.env.ALLOW_INSECURE_LOCAL_HTTP === "true" && ["localhost", "127.0.0.1"].includes(req.hostname);
  if (production() && !req.secure && !localHttpAllowed && req.path !== "/api/health") {
    return res.status(400).json({ success: false, message: "HTTPS is required", errorCode: "HTTPS_REQUIRED" });
  }

  await runMiddleware(applyHelmet, req, res);
  res.setHeader("Cache-Control", "no-store");
  await runMiddleware(applyCors, req, res);
  if (res.headersSent || res.writableEnded) return undefined;

  await parseBody(req);

  const message = { success: false, message: "Too many requests, please try again later", errorCode: "RATE_LIMITED" };
  if (isRateLimited(`all:${req.ip}`, 300, res)) return res.status(429).json(message);
  if (req.path === "/api/auth/login" && isRateLimited(`login:${req.ip}`, 10, res)) return res.status(429).json(message);

  if (req.method === "GET" && req.path === "/api/health") {
    return res.json({ success: true, message: "Parenthood ART Bank API is running" });
  }
  if (req.method === "GET" && req.path === "/api/ready") {
    await connectDatabase().catch(() => {});
    const databaseReady = mongoose.connection.readyState === 1;
    return res.status(databaseReady ? 200 : 503).json({
      success: databaseReady,
      message: databaseReady ? "Parenthood ART Bank API is ready" : "Database is unavailable"
    });
  }

  await connectDatabase();
  const handled = await routeRequest(req, res);
  if (handled === false && !res.headersSent && !res.writableEnded) {
    return res.status(404).json({ success: false, message: "API route not found", errorCode: "NOT_FOUND" });
  }
  return undefined;
}

async function handleApiRequest(request) {
  const req = buildRequest(request, new URL(request.url));
  const res = new ApiResponse();
  processRequest(req, res).catch(error => sendError(error, req, res));
  return res.ready;
}

module.exports = { handleApiRequest };
