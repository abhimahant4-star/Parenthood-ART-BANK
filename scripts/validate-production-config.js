require("dotenv").config({ path: ".env.production" });

const required = ["MONGODB_URI", "JWT_SECRET", "CLIENT_ORIGIN", "PORTAL_HOST", "UPLOAD_ENCRYPTION_KEY", "CLAMAV_HOST"];
const missing = required.filter((key) => !process.env[key]);
const placeholders = required.filter((key) => /REPLACE_WITH|example\.org/i.test(process.env[key] || ""));
const failures = [];

if (missing.length) failures.push(`Missing: ${missing.join(", ")}`);
if (placeholders.length) failures.push(`Replace template values: ${placeholders.join(", ")}`);
if (process.env.NODE_ENV !== "production") failures.push("NODE_ENV must be production");
if (!/^mongodb(\+srv)?:\/\//i.test(process.env.MONGODB_URI || "")) failures.push("MONGODB_URI must be a MongoDB connection URI");
if ((process.env.JWT_SECRET || "").length < 32) failures.push("JWT_SECRET must be at least 32 characters");
if (!/^https:\/\/[^/]+$/i.test(process.env.CLIENT_ORIGIN || "")) failures.push("CLIENT_ORIGIN must be one HTTPS origin without a trailing slash");
const portalHost = process.env.PORTAL_HOST || "";
const validPortalHost = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(portalHost);
if (!validPortalHost) failures.push("PORTAL_HOST must be a DNS hostname with at least two valid labels");
if (/^https:\/\/[^/]+$/i.test(process.env.CLIENT_ORIGIN || "")) {
  try {
    if (new URL(process.env.CLIENT_ORIGIN).hostname.toLowerCase() !== portalHost.toLowerCase()) failures.push("PORTAL_HOST must match the hostname in CLIENT_ORIGIN");
  } catch {
    // The HTTPS-origin format check above reports malformed values.
  }
}
if (process.env.TRUST_PROXY !== "true") failures.push("TRUST_PROXY must be true");

const rawKey = process.env.UPLOAD_ENCRYPTION_KEY || "";
const key = /^[a-f\d]{64}$/i.test(rawKey) ? Buffer.from(rawKey, "hex") : Buffer.from(rawKey, "base64");
if (key.length !== 32) failures.push("UPLOAD_ENCRYPTION_KEY must encode exactly 32 bytes");

if (failures.length) {
  console.error("Production configuration is not ready:\n- " + failures.join("\n- "));
  process.exit(1);
}

console.log("Production configuration is ready.");
