const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const privateDirectory = path.resolve(/*turbopackIgnore: true*/ process.cwd(), process.env.UPLOAD_DIR || "private-uploads");
const MAGIC = Buffer.from("PAB1");
const rawKey = process.env.UPLOAD_ENCRYPTION_KEY || "";
const encryptionKey = /^[a-f\d]{64}$/i.test(rawKey)
  ? Buffer.from(rawKey, "hex")
  : Buffer.from(rawKey, "base64");

if (encryptionKey.length !== 32) {
  throw new Error("UPLOAD_ENCRYPTION_KEY must contain 32 bytes encoded as base64 or 64 hex characters");
}

const mimeByExtension = new Map([
  [".pdf", "application/pdf"], [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"], [".png", "image/png"]
]);

function validateFile(req, file, callback) {
  const safeOriginalName = String(file.originalname || "").replace(/\\/g, "/");
  const extension = path.extname(safeOriginalName).toLowerCase();
  if (!mimeByExtension.has(extension) || mimeByExtension.get(extension) !== file.mimetype) {
    return callback(new Error("Only matching PDF, JPG, JPEG and PNG files are allowed"));
  }
  callback(null, true);
}

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_REQUEST_BYTES = 5 * MAX_FILE_BYTES + 1024 * 1024;
const MAX_FIELDS = 3;
const MAX_PARTS = 8;

function uploadError(code, message) {
  return Object.assign(new Error(message), { code });
}

function checkFileType(file) {
  return new Promise((resolve, reject) => validateFile(null, file, error => (error ? reject(error) : resolve())));
}

// Reads a multipart request into req.body and req.files with the same limits as before.
async function readMultipart(req, fieldName, maxFiles) {
  const contentType = String(req.headers["content-type"] || "").toLowerCase();
  if (!contentType.includes("multipart/form-data")) return;
  if (Number(req.headers["content-length"] || 0) > MAX_REQUEST_BYTES) throw uploadError("LIMIT_FILE_SIZE", "File too large");

  let form;
  try { form = await req.webRequest.formData(); }
  catch { throw uploadError("INVALID_MULTIPART", "Upload could not be read"); }

  const body = {};
  const files = [];
  let fields = 0, parts = 0;
  for (const [key, value] of form.entries()) {
    parts += 1;
    if (parts > MAX_PARTS) throw uploadError("LIMIT_PART_COUNT", "Too many parts");
    if (typeof value === "string") {
      fields += 1;
      if (fields > MAX_FIELDS) throw uploadError("LIMIT_FIELD_COUNT", "Too many fields");
      body[key] = value;
      continue;
    }
    if (!value.name) continue;
    if (key !== fieldName) throw uploadError("LIMIT_UNEXPECTED_FILE", "Unexpected file field");
    if (files.length >= maxFiles) throw uploadError("LIMIT_FILE_COUNT", "Too many files");
    if (value.size > MAX_FILE_BYTES) throw uploadError("LIMIT_FILE_SIZE", "File too large");
    const file = { fieldname: key, originalname: value.name, mimetype: value.type, size: value.size };
    await checkFileType(file);
    file.buffer = Buffer.from(await value.arrayBuffer());
    files.push(file);
  }
  req.body = body;
  return files;
}

const upload = {
  limits: { fileSize: MAX_FILE_BYTES, files: 5, fields: MAX_FIELDS, parts: MAX_PARTS },
  array: (fieldName, maxFiles) => (req, res, callback) => {
    readMultipart(req, fieldName, maxFiles).then(files => { if (files) req.files = files; callback(); }, callback);
  },
  single: fieldName => (req, res, callback) => {
    readMultipart(req, fieldName, 1).then(files => { if (files) req.file = files[0]; callback(); }, callback);
  }
};

function encrypt(buffer) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(buffer), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), ciphertext]);
}

function decrypt(buffer) {
  if (buffer.subarray(0, MAGIC.length).equals(MAGIC)) {
    const iv = buffer.subarray(4, 16), tag = buffer.subarray(16, 32), ciphertext = buffer.subarray(32);
    const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }
  // Read legacy files during migration; run `npm run encrypt-uploads` before production.
  return buffer;
}

function validateFileContent(file) {
  const b = file.buffer;
  const valid = file.mimetype === "application/pdf" ? b.subarray(0, 5).toString("ascii") === "%PDF-"
    : file.mimetype === "image/png" ? b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : file.mimetype === "image/jpeg" ? b[0] === 0xff && b[1] === 0xd8 && b[b.length - 2] === 0xff && b[b.length - 1] === 0xd9
        : false;
  if (!valid) {
    const error = new Error("File contents do not match the declared file type");
    error.code = "FILE_CONTENT_MISMATCH";
    throw error;
  }
}

async function storePrivateFile(buffer) {
  await fs.mkdir(privateDirectory, { recursive: true, mode: 0o700 });
  const storageName = `${crypto.randomUUID()}.enc`;
  await fs.writeFile(path.join(privateDirectory, storageName), encrypt(buffer), { mode: 0o600, flag: "wx" });
  return storageName;
}

async function readPrivateFile(storageName) {
  const safeName = path.basename(String(storageName || ""));
  if (!safeName || safeName !== storageName) throw new Error("Invalid private storage key");
  return decrypt(await fs.readFile(path.join(privateDirectory, safeName)));
}

async function deletePrivateFile(storageName) {
  const safeName = path.basename(String(storageName || ""));
  if (safeName && safeName === storageName) await fs.unlink(path.join(privateDirectory, safeName)).catch(error => { if (error.code !== "ENOENT") throw error; });
}

async function encryptLegacyFiles() {
  await fs.mkdir(privateDirectory, { recursive: true, mode: 0o700 });
  const entries = await fs.readdir(privateDirectory, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.endsWith(".tmp")) continue;
    const target = path.join(privateDirectory, entry.name);
    const data = await fs.readFile(target);
    if (data.subarray(0, MAGIC.length).equals(MAGIC)) continue;
    const temp = `${target}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temp, encrypt(data), { mode: 0o600, flag: "wx" });
    await fs.rename(temp, target);
  }
}

function encryptSensitiveString(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  return `enc:v1:${Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64")}`;
}

function isEncryptedSensitiveString(value) {
  return typeof value === "string" && value.startsWith("enc:v1:");
}

function encryptLegacySensitiveString(value) {
  return isEncryptedSensitiveString(value) ? value : encryptSensitiveString(value);
}

module.exports = { upload, privateDirectory, storePrivateFile, readPrivateFile, deletePrivateFile, validateFileContent, encryptLegacyFiles, encryptSensitiveString, encryptLegacySensitiveString };
