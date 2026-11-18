const AuditLog = require("../models/AuditLog");

const EVENTS = new Map([
  ["DONOR_CREATED", "Donor"], ["BATCH_CREATED", "Batch"], ["BATCH_RELEASED", "Batch"],
  ["VIAL_STATUS_CHANGED", "Vial"], ["ORDER_CREATED", "Order"], ["ORDER_DISPATCHED", "Order"],
  ["BANK_DISPATCH_ORDER_CREATED", "Order"],
  ["ORDER_RECEIVED", "Order"], ["COUPLE_CREATED", "Couple"], ["VIAL_MAPPED", "Vial"],
  ["DECLARATION_CREATED", "Declaration"], ["DECLARATION_DRAFT_DETAILS_UPDATED", "Declaration"], ["DECLARATION_SUBMITTED", "Declaration"],
  ["DECLARATION_UNSUBMITTED", "Declaration"], ["ATTACHMENT_UPLOADED", "Attachment"],
  ["ATTACHMENT_SUBMITTED", "Attachment"], ["ATTACHMENT_UNSUBMITTED", "Attachment"],
  ["ATTACHMENT_DOWNLOADED", "Attachment"], ["USER_CREATED", "User"], ["HOSPITAL_REGISTERED", "User"], ["USER_UPDATED", "User"],
  ["USER_PASSWORD_CHANGED", "User"], ["USER_FORCE_LOGOUT", "User"], ["SIGNER_CREATED", "AuthorizedSigner"],
  ["SIGNER_UPDATED", "AuthorizedSigner"], ["SIGNER_STATUS_CHANGED", "AuthorizedSigner"], ["REPORT_EXPORT", "Report"],
  ["LOGIN_SUCCESS", "AUTH"], ["LOGOUT_SUCCESS", "AUTH"], ["LOGIN_BLOCKED_ACTIVE_SESSION", "AUTH"], ["SESSION_REPLACED", "AUTH"]
]);
const ROLES = new Set(["SUPER_ADMIN", "ART_BANK_ADMIN", "ART_BANK_STAFF", "HOSPITAL_USER", "CHAIN_CEO"]);
const INPUT_KEYS = new Set(["actorId", "role", "event", "entityId", "ip", "metadata", "session"]);
const METADATA_TYPES = new Map([
  ["previousStatus", "status"], ["status", "status"], ["count", "number"], ["format", "format"],
  ["version", "number"], ["baseVersion", "number"], ["resultingVersion", "number"],
  ["hospitalId", "id"], ["centreId", "id"], ["batchId", "id"], ["orderId", "id"],
  ["coupleId", "id"], ["vialId", "id"], ["declarationId", "id"], ["attachmentId", "id"], ["relatedId", "id"],
  ["category", "category"],
  ["requestId", "id"], ["roleChanged", "role"], ["assignedRole", "role"], ["active", "boolean"], ["ceoLinked", "boolean"]
]);
const ATTACHMENT_CATEGORIES = new Set([
  "IDENTITY_DOCUMENT", "BANK_DOCUMENT", "BATCH_DOCUMENT", "DONOR_DOCUMENT", "DONOR_AADHAAR"
]);

function makeOperationalAuditDocument(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("Audit event must be an object");
  if (Object.keys(input).some(key => !INPUT_KEYS.has(key))) throw new TypeError("Audit event contains unsupported or sensitive fields");
  if (typeof input.actorId !== "string" || !input.actorId || input.actorId.length > 128) throw new TypeError("actorId is required");
  if (!ROLES.has(input.role)) throw new TypeError("role is invalid");
  if (!EVENTS.has(input.event)) throw new TypeError("event is invalid");
  if (typeof input.entityId !== "string" || !input.entityId || input.entityId.length > 160) throw new TypeError("entityId is required");
  if (input.ip != null && typeof input.ip !== "string") throw new TypeError("ip must be a string");
  const metadata = input.metadata == null ? {} : input.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new TypeError("metadata must contain allowlisted scalar fields");
  const safeValues = {};
  for (const [key, value] of Object.entries(metadata)) {
    const type = METADATA_TYPES.get(key);
    if (!type) throw new TypeError("Audit metadata contains unsupported or sensitive fields");
    if (type === "number") {
      if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${key} must be a non-negative integer`);
    } else if (type === "boolean") {
      if (typeof value !== "boolean") throw new TypeError(`${key} must be boolean`);
    } else {
      if (typeof value !== "string" || !value || value.length > 160 || !/^[A-Za-z0-9_.:-]+$/.test(value)) throw new TypeError(`${key} is invalid`);
      if (type === "category" && !ATTACHMENT_CATEGORIES.has(value)) throw new TypeError("category is invalid");
      if (type === "status" && !/^[A-Za-z][A-Za-z0-9_]*$/.test(value)) throw new TypeError(`${key} is invalid`);
      if (type === "format" && !/^[A-Z]{2,10}$/.test(value)) throw new TypeError("format is invalid");
      if (type === "role" && !ROLES.has(value)) throw new TypeError("roleChanged is invalid");
    }
    safeValues[key] = value;
  }
  return {
    userId: input.actorId,
    role: input.role,
    action: input.event,
    entity: EVENTS.get(input.event),
    entityId: input.entityId,
    summary: input.event.replaceAll("_", " ").toLowerCase(),
    ...(Object.keys(safeValues).length ? { newValues: safeValues } : {}),
    ...(input.ip ? { ip: input.ip } : {})
  };
}

async function recordOperationalEvent(input) {
  const document = makeOperationalAuditDocument(input);
  if (input.session !== undefined) {
    if (!input.session) throw new TypeError("session must be a valid Mongoose session when supplied");
    const created = await AuditLog.create([document], { session: input.session });
    return created[0];
  }
  return AuditLog.create(document);
}

module.exports = { makeOperationalAuditDocument, recordOperationalEvent };
