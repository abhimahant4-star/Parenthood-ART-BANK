const AuditLog = require("../models/AuditLog");

const EVENT_ACTIONS = new Set([
  "DECLARATION_CORRECTION_SUBMITTED",
  "DECLARATION_CORRECTION_RESUBMITTED",
  "DECLARATION_CORRECTION_APPROVED",
  "DECLARATION_CORRECTION_REJECTED",
  "DECLARATION_SIGNATURE_INVALIDATED",
  "DECLARATION_SIGNATURE_CREATED"
]);
const ROLES = new Set(["SUPER_ADMIN", "ART_BANK_ADMIN", "ART_BANK_STAFF", "HOSPITAL_USER", "CHAIN_CEO"]);
const ALLOWED_INPUTS = new Set([
  "actorId", "role", "event", "declarationId", "requestId",
  "baseVersion", "resultingVersion", "ip", "session"
]);

function assertVersion(value, field) {
  if (value != null && (!Number.isInteger(value) || value < 1)) throw new TypeError(`${field} must be a positive integer`);
}

function makeAuditDocument(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("Audit event must be an object");
  const unknown = Object.keys(input).filter(key => !ALLOWED_INPUTS.has(key));
  if (unknown.length) throw new TypeError("Audit event contains unsupported or sensitive fields");
  if (typeof input.actorId !== "string" || !input.actorId) throw new TypeError("actorId is required");
  if (!ROLES.has(input.role)) throw new TypeError("role is invalid");
  if (!EVENT_ACTIONS.has(input.event)) throw new TypeError("event is invalid");
  if (typeof input.declarationId !== "string" || !input.declarationId) throw new TypeError("declarationId is required");
  const signatureEvent = input.event === "DECLARATION_SIGNATURE_CREATED" || input.event === "DECLARATION_SIGNATURE_INVALIDATED";
  const requestIdOptional = input.event === "DECLARATION_SIGNATURE_CREATED";
  if (!requestIdOptional && (typeof input.requestId !== "string" || !input.requestId)) throw new TypeError("requestId is required");
  if (requestIdOptional && input.requestId != null && (typeof input.requestId !== "string" || !input.requestId)) throw new TypeError("requestId must be a non-empty string when supplied");
  if (input.ip != null && typeof input.ip !== "string") throw new TypeError("ip must be a string");
  assertVersion(input.baseVersion, "baseVersion");
  assertVersion(input.resultingVersion, "resultingVersion");

  const values = { declarationId: input.declarationId };
  if (input.requestId) values.requestId = input.requestId;
  if (input.baseVersion != null) values.baseVersion = input.baseVersion;
  if (input.resultingVersion != null) values.resultingVersion = input.resultingVersion;
  return {
    userId: input.actorId,
    role: input.role,
    action: input.event,
    entity: signatureEvent ? "Signature" : "DeclarationCorrectionRequest",
    entityId: input.requestId || input.declarationId,
    summary: input.event.replaceAll("_", " ").toLowerCase(),
    newValues: values,
    ...(input.ip ? { ip: input.ip } : {})
  };
}

async function recordDeclarationCorrectionEvent(input) {
  const document = makeAuditDocument(input);
  if (input.session !== undefined) {
    if (!input.session) throw new TypeError("session must be a valid Mongoose session when supplied");
    const created = await AuditLog.create([document], { session: input.session });
    return created[0];
  }
  return AuditLog.create(document);
}

module.exports = { recordDeclarationCorrectionEvent, makeAuditDocument };
